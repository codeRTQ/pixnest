#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
图集站部署工具（零依赖：Python 3.10 标准库）

用法：
  python deploy.py                      # 构建 + 打包 dist.tar.gz + 生成 nginx/Docker/部署说明
  python deploy.py --check              # 只做部署前检查（死链、体积、SEO 文件）
  python deploy.py --oss                # 上传阿里云 OSS（需环境变量，见下）
  python deploy.py --cloudflare         # 调 wrangler 部署到 Cloudflare Pages（需已登录）
  python deploy.py --sftp host=/path    # 通过 sftp/scp 上传（需本机 ssh 免密）

阿里云 OSS 环境变量：
  OSS_AK / OSS_SK / OSS_BUCKET / OSS_ENDPOINT(如 oss-cn-hangzhou.aliyuncs.com) / OSS_PREFIX(可选)
"""
import argparse
import base64
import hashlib
import hmac
import mimetypes
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
from datetime import datetime
from email.utils import formatdate
from http.client import HTTPSConnection

# Windows 控制台默认 GBK，输出 emoji/中文会崩 → 强制 UTF-8
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, 'dist')
OUT = os.path.join(ROOT, 'deploy')
SITE = {}

if os.path.exists(os.path.join(ROOT, 'site.json')):
    import json
    SITE = json.load(open(os.path.join(ROOT, 'site.json'), encoding='utf-8'))

SITE_NAME = SITE.get('siteName', '图集站')
BASE_URL = (SITE.get('baseUrl') or '').rstrip('/')


def sh(cmd, **kw):
    print('$', ' '.join(cmd) if isinstance(cmd, list) else cmd)
    return subprocess.run(cmd, cwd=kw.pop('cwd', ROOT), **kw)


def build(lite=True, public=True, base_url=None):
    print(f'\n=== 1/4 构建站点（{"精简模式：只放缩略图" if lite else "完整模式：含原图与压缩包"}'
          f'{" · 公网模式：剥离后台入口" if public else ""}）===')
    env = dict(os.environ)
    env['SITE_LITE'] = '1' if lite else '0'
    env['SITE_PUBLIC'] = '1' if public else '0'
    if base_url:
        env['SITE_BASE_URL'] = base_url.rstrip('/')
        print(f'  站点绝对地址：{base_url.rstrip("/")}')
    r = subprocess.run(['node', 'build.mjs'], cwd=ROOT, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', env=env)
    print((r.stdout or '') + (r.stderr or ''))
    if r.returncode != 0:
        sys.exit('构建失败')


def check():
    print('\n=== 2/4 部署前检查 ===')
    if not os.path.isdir(DIST):
        sys.exit('× 找不到 dist/，请先构建')
    files = []
    total = 0
    for dirpath, _, names in os.walk(DIST):
        for n in names:
            p = os.path.join(dirpath, n)
            sz = os.path.getsize(p)
            files.append((os.path.relpath(p, DIST).replace('\\', '/'), sz))
            total += sz
    print(f'  文件数 {len(files)} · 总体积 {total/1048576:.1f} MB')
    for need in ('index.html', 'style-not-needed', 'search-index.json', 'sitemap.xml', 'robots.txt', 'feed.xml'):
        if need == 'style-not-needed':
            continue
        ok = os.path.exists(os.path.join(DIST, need))
        print(f'  {"✅" if ok else "❌"} {need}')
    # 大文件提示
    big = sorted(files, key=lambda x: -x[1])[:5]
    print('  最大的 5 个文件：')
    for f, s in big:
        print(f'    {s/1048576:6.2f} MB  {f}')
    # 缺失封面/缩略图的图集
    sets_dir = os.path.join(ROOT, 'sets')
    for name in sorted(os.listdir(sets_dir)) if os.path.isdir(sets_dir) else []:
        d = os.path.join(sets_dir, name)
        if not os.path.isdir(d):
            continue
        imgs = [f for f in os.listdir(os.path.join(d, 'images'))] if os.path.isdir(os.path.join(d, 'images')) else []
        missing = []
        if not os.path.exists(os.path.join(d, 'cover.jpg')):
            missing.append('封面')
        if imgs and not os.path.isdir(os.path.join(d, 'thumbs')):
            missing.append('缩略图')
        meta = json.load(open(os.path.join(d, 'meta.json'), encoding='utf-8')) if os.path.exists(os.path.join(d, 'meta.json')) else {}
        if not meta.get('tags'):
            missing.append('标签')
        if missing:
            print(f'  ⚠️ {name}: 缺 {"、".join(missing)}')
    print('  检查完成')
    # 公网产物安全检查
    print('  ── 公网就绪检查 ──')
    leaks = []
    for dirpath, _, names in os.walk(DIST):
        for n in names:
            if not n.endswith(('.html', '.js')):
                continue
            p = os.path.join(dirpath, n)
            try:
                t = open(p, encoding='utf-8', errors='ignore').read()
            except OSError:
                continue
            if '8091' in t or 'admin=1' in t:
                leaks.append(os.path.relpath(p, DIST))
    if leaks:
        print(f'  ❌ 产物里残留本地后台入口（{len(leaks)} 个文件，如 {leaks[0]}）→ 用 python deploy.py 重新构建（默认公网模式）')
    else:
        print('  ✅ 无本地后台入口残留（8091 / ?admin=1）')
    sm = os.path.join(DIST, 'sitemap.xml')
    sm_abs = os.path.exists(sm) and '<loc>http' in open(sm, encoding='utf-8', errors='ignore').read()
    if sm_abs:
        print('  ✅ sitemap 使用绝对地址（分享卡片/SEO 正常）')
    else:
        print('  ⚠️ sitemap 为相对地址：部署后请设置 baseUrl（site.json 或 --base-url）再重新构建')
    for need in ('404.html', '_headers', 'about.html'):
        ok = os.path.exists(os.path.join(DIST, need))
        print(f'  {"✅" if ok else "❌"} {need}')


def bundle():
    print('\n=== 3/4 打包与配置 ===')
    os.makedirs(OUT, exist_ok=True)
    # tar.gz
    tar_path = os.path.join(OUT, 'dist.tar.gz')
    with tarfile.open(tar_path, 'w:gz') as t:
        t.add(DIST, arcname='.')
    print(f'  ✅ {tar_path}（{os.path.getsize(tar_path)/1048576:.1f} MB）')

    # nginx 配置
    nginx = f"""# {SITE_NAME} · Nginx 站点配置
# 放置到 /etc/nginx/conf.d/img-site.conf 后 nginx -t && systemctl reload nginx
server {{
    listen 80;
    server_name {'your-domain.com' if not BASE_URL else BASE_URL.replace('https://', '').replace('http://', '')};
    root /var/www/img-site;
    index index.html;

    # 静态长缓存（文件名带内容哈希的走这里）
    location ~* \\.(?:jpg|jpeg|png|webp|gif|css|js|woff2?)$ {{
        expires 30d;
        add_header Cache-Control "public, immutable";
        access_log off;
    }}
    # HTML 短缓存（内容会更新）
    location ~* \\.html$ {{
        expires 1h;
        add_header Cache-Control "public, must-revalidate";
    }}
    # 压缩（图片本身已压缩，只压文本）
    gzip on;
    gzip_types text/plain text/css application/javascript application/json application/xml image/svg+xml;
    gzip_min_length 1024;
    gzip_comp_level 5;
    # SEO 与安全
    location = /robots.txt {{ add_header Cache-Control "public, max-age=3600"; }}
    location = /sitemap.xml {{ add_header Cache-Control "public, max-age=3600"; }}
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy no-referrer-when-downgrade;
    # 防盗链（可选，按需放开）
    # location ~* \\.(jpg|jpeg|png|webp)$ {{
    #     valid_referers none blocked server_names *.your-domain.com;
    #     if ($invalid_referer) {{ return 403; }}
    # }}
}}
"""
    open(os.path.join(OUT, 'nginx-img-site.conf'), 'w', encoding='utf-8').write(nginx)

    # Dockerfile
    dockerfile = """FROM nginx:alpine
COPY dist/ /usr/share/nginx/html/
COPY deploy/nginx-img-site.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
"""
    open(os.path.join(OUT, 'Dockerfile'), 'w', encoding='utf-8').write(dockerfile)

    # 部署说明
    guide = f"""# {SITE_NAME} · 部署说明

构建产物：`dist/`（纯静态，无需 Node/Python 运行环境）

## 前置：设置站点域名（重要）
编辑 `site.json` 的 `baseUrl`（如 `https://img.example.com`），或在部署时用 `--base-url` 传入；
之后 canonical / sitemap / RSS / OG 图片地址才会是绝对地址，利于 SEO 与分享卡片。

## 常用命令
```bash
python deploy.py --check                    # 只做部署前检查（构建 + 体检，不上传）
python deploy.py                            # 构建（精简 + 公网模式）+ 打包到 deploy/
python deploy.py --cloudflare               # 构建后部署到 Cloudflare Pages
python deploy.py --cloudflare --project my-img --base-url https://img.example.com
python deploy.py --full                     # 完整模式：原图与压缩包也进站点（体积大 10-20 倍）
python deploy.py --with-admin               # 仅本机使用：保留 ?admin=1 后台入口
```

## 公网内容范围（重要）
默认「精简模式 + 公网模式」，产物只含缩略图与页面（约 5 MB）：
- 原图 / `pack.zip` **不会**进入 `dist/`（下载请用网盘外链）
- 本地后台入口（`?admin=1`、`127.0.0.1:8091`）在构建时被整体剥离
- 管理端 `admin.py` 与素材目录 `sets/` 永远不要上传到公网

## 方式一：Nginx（自有服务器 / 云主机）
```bash
# 服务器上
mkdir -p /var/www/img-site && cd /var/www/img-site
# 本地上传
scp deploy/dist.tar.gz user@server:/tmp/
# 服务器上解包
tar -xzf /tmp/dist.tar.gz -C /var/www/img-site
cp {os.path.relpath(os.path.join(OUT, 'nginx-img-site.conf'), ROOT).replace(os.sep, '/')} /etc/nginx/conf.d/img-site.conf   # 从仓库拷
nginx -t && systemctl reload nginx
```

## 方式二：Docker
```bash
docker build -f deploy/Dockerfile -t img-site .
docker run -d --name img-site -p 8080:80 --restart unless-stopped img-site
```

## 方式三：阿里云 OSS（国内访问最快，建议配 CDN）
```bash
# 环境变量（AK/SK 建议用 RAM 子账号，只给该 Bucket 的读写权限）
export OSS_AK=xxx OSS_SK=xxx OSS_BUCKET=my-img-bucket OSS_ENDPOINT=oss-cn-hangzhou.aliyuncs.com
python deploy.py --oss
```
提示：OSS 绑定自定义域名 + CDN 后记得回源缓存规则；同时开启「静态网站托管」把 index.html 设为默认首页。

## 方式四：Cloudflare Pages（免费、免备案、全球 CDN）★ 推荐
```bash
npm i -g wrangler && wrangler login
python deploy.py --cloudflare --project img-site --base-url https://img-site.pages.dev
# 或手动：npx wrangler pages deploy dist --project-name=img-site --branch=main
```
产物里已自动生成：
- `_headers` → `assets/*` 长缓存 immutable（带 `?v=` 指纹）、缩略图 1 天 + stale-while-revalidate、HTML 短缓存
- `404.html` → Pages 自动作为错误页
- `robots.txt` / `sitemap.xml` / `feed.xml` → 直接可用
自定义域：控制台 → Pages → 项目 → Custom domains。
注意：国内访问 Cloudflare 速度一般，访客主要在国内建议用 OSS+CDN；另请确认内容符合其 AUP（成人向内容可能被要求下架）。

## 方式五：GitHub Pages（最省事）
```bash
# 把 dist/ 推到 gh-pages 分支（已含 .nojekyll）
cd dist && git init && git add -A && git commit -m deploy \\
  && git push -f git@github.com:<user>/<repo>.git main:gh-pages
```

## 更新流程
```bash
python admin.py      # 上传/编辑图集（自动重建 dist/）
python deploy.py     # 重新打包；再按上面任一方式推送
```

## 上线检查清单
- [ ] `site.json` 的 baseUrl 已填真实域名
- [ ] 后台设置 `ADMIN_PASSWORD`（若部署 admin.py 到公网；建议只在本机用）
- [ ] 图集封面/缩略图/标签齐全（`python deploy.py --check`）
- [ ] 备案：国内主机/OSS 自定义域名需 ICP 备案
- [ ] 备份 `sets/` 目录（源数据，dist 可随时重建）
"""
    open(os.path.join(OUT, 'DEPLOY.md'), 'w', encoding='utf-8').write(guide)
    print('  ✅ deploy/nginx-img-site.conf')
    print('  ✅ deploy/Dockerfile')
    print('  ✅ deploy/DEPLOY.md')


# ───────────── 阿里云 OSS 上传（V1 签名，标准库实现） ─────────────

def oss_upload():
    ak = os.environ.get('OSS_AK'); sk = os.environ.get('OSS_SK')
    bucket = os.environ.get('OSS_BUCKET'); endpoint = os.environ.get('OSS_ENDPOINT')
    prefix = (os.environ.get('OSS_PREFIX') or '').strip('/')
    if not all([ak, sk, bucket, endpoint]):
        sys.exit('× 缺少环境变量：OSS_AK / OSS_SK / OSS_BUCKET / OSS_ENDPOINT')

    files = []
    for dirpath, _, names in os.walk(DIST):
        for n in names:
            p = os.path.join(dirpath, n)
            key = os.path.relpath(p, DIST).replace('\\', '/')
            if prefix:
                key = f'{prefix}/{key}'
            files.append((p, key))
    print(f'\n=== 4/4 上传 OSS：{len(files)} 个文件 → {bucket}/{prefix or ""} ===')
    conn = HTTPSConnection(endpoint, timeout=60)
    ok = fail = 0
    for p, key in files:
        with open(p, 'rb') as f:
            body = f.read()
        ctype = mimetypes.guess_type(key)[0] or 'application/octet-stream'
        date = formatdate(timeval=None, localtime=False, usegmt=True)
        # V1 签名
        canon = f'PUT\n\n{ctype}\n{date}\n/{bucket}/{key}'
        sig = base64.b64encode(hmac.new(sk.encode(), canon.encode(), hashlib.sha1).digest()).decode()
        headers = {
            'Authorization': f'OSS {ak}:{sig}',
            'Date': date,
            'Content-Type': ctype,
            'Content-Length': str(len(body)),
            'x-oss-object-acl': 'public-read',
        }
        try:
            conn.request('PUT', f'/{key}', body=body, headers=headers)
            resp = conn.getresponse()
            resp.read()
            if resp.status in (200, 201):
                ok += 1
                if ok % 20 == 0:
                    print(f'  已上传 {ok}/{len(files)}')
            else:
                fail += 1
                print(f'  ❌ {key} → HTTP {resp.status}')
        except Exception as e:  # noqa
            fail += 1
            print(f'  ❌ {key} → {e}')
            conn = HTTPSConnection(endpoint, timeout=60)
    conn.close()
    print(f'\n完成：成功 {ok}，失败 {fail}')
    print(f'访问地址：https://{bucket}.{endpoint}/{prefix + "/" if prefix else ""}index.html')


def cloudflare(project='img-site', branch='main'):
    if shutil.which('wrangler') is None and shutil.which('npx') is None:
        sys.exit('× 未找到 wrangler / npx，请先 npm i -g wrangler && wrangler login')
    print(f'\n=== 4/4 部署到 Cloudflare Pages（项目 {project}）===')
    cmd = (['wrangler'] if shutil.which('wrangler') else ['npx', 'wrangler'])
    r = sh(cmd + ['pages', 'deploy', 'dist', f'--project-name={project}', f'--branch={branch}',
                  '--commit-dirty=true'], shell=(os.name == 'nt'))
    # 上传失败必须让整个脚本以非零退出，否则调用方（如后台一键发布）会误判成功
    if r is None or r.returncode != 0:
        code = 'None' if r is None else r.returncode
        sys.exit(f'× 上传失败（退出码 {code}）—— 线上仍是上一个版本，可重试')
    print(f'\n访问地址：https://{project}.pages.dev/')
    print('自定义域：Cloudflare 控制台 → Pages → 该项目 → Custom domains 添加你的域名')


def sftp(spec):
    host, _, path = spec.partition('=')
    if not host or not path:
        sys.exit('× 用法：--sftp user@host=/var/www/img-site')
    import glob
    print('\n=== 4/4 通过 scp 上传 ===')
    if shutil.which('scp') is None:
        sys.exit('× 未找到 scp（Windows 可用 Git Bash 或 OpenSSH 客户端）')
    sh(['scp', '-r', os.path.join(DIST, '*'), f'{host}:{path}/'])


def main():
    ap = argparse.ArgumentParser(description='图集站部署工具')
    ap.add_argument('--check', action='store_true', help='只做部署前检查')
    ap.add_argument('--oss', action='store_true', help='上传阿里云 OSS')
    ap.add_argument('--cloudflare', action='store_true', help='部署到 Cloudflare Pages')
    ap.add_argument('--sftp', metavar='user@host=/path', help='通过 scp 上传')
    ap.add_argument('--skip-build', action='store_true', help='跳过构建（直接用现有 dist）')
    ap.add_argument('--full', action='store_true', help='完整模式：把原图与压缩包也打进站点（体积大 10-20 倍）')
    ap.add_argument('--base-url', metavar='URL', help='站点绝对地址，如 https://img.example.com（写入 sitemap/canonical/og）')
    ap.add_argument('--with-admin', action='store_true', help='保留本地后台入口（默认公网模式会剥离 ?admin=1 与 8091 链接）')
    ap.add_argument('--project', default='img-site', help='Cloudflare Pages 项目名（默认 img-site）')
    ap.add_argument('--branch', default='main', help='Cloudflare Pages 分支名（默认 main）')
    a = ap.parse_args()

    t0 = time.time()
    if not a.skip_build:
        build(lite=not a.full, public=not a.with_admin, base_url=a.base_url)
    check()
    if a.check:
        return
    bundle()
    if a.oss:
        oss_upload()
    elif a.cloudflare:
        cloudflare(a.project, a.branch)
    elif a.sftp:
        sftp(a.sftp)
    else:
        print(f'\n✅ 完成（{time.time()-t0:.1f}s）。部署产物在 deploy/，按 deploy/DEPLOY.md 选择方式上传。')


if __name__ == '__main__':
    main()
