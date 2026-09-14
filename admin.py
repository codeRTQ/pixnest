#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
图集上传/管理后台（本地运行，零额外依赖：Python 3.10 + Pillow）

启动：  python admin.py            → http://127.0.0.1:8091
能力：
  · 上传多张图片 → 自动生成缩略图（1920px，详情页预览）+ LQIP 模糊占位图（20px）
  · 封面自动 600x800 裁切；可指定封面图
  · 上传后自动重建静态站（node build.mjs）
  · 【编辑已发布图集】改标题/系列/日期/模特/标签/密码/网盘/像素/描述、
    追加图片、删除单张、更换封面、一键补齐缩略图
"""
import cgi
import base64
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from urllib.parse import urlparse, quote

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.abspath(__file__))
SETS_DIR = os.path.join(ROOT, 'sets')
PORT = int(os.environ.get('ADMIN_PORT', '8091'))
PREVIEW_LONG = 1920   # 详情页预览缩略图【长边】上限（横竖构图总像素相近：竖 1280×1920 / 横 1920×1280）
LQIP_W = 20           # 模糊占位图宽度
COVER_W, COVER_H = 800, 1067   # 封面（列表卡片 2x 屏清晰）
# 首页置顶轮播的自定义 Banner（在后台从"本套图"里选一张裁剪）与模特头像（从该模特任意一套图里选）
# 都按 2x 屏生成，实际显示尺寸分别约 840×240（32:9）与 38~64px 圆形
BANNER_W, BANNER_H = 1600, 450
AVATAR_PX = 320
THUMB_Q = 88          # JPEG 质量
WEBP_Q = 86           # WebP 质量（同质量下体积更小）
# 缩略图并发生成线程数：Pillow 在解码/编码时会释放 GIL，多线程能实打实提速
# 实测 8 核机器：41 张原图 单线程 29.1s → 4 线程 10.2s → 8 线程 5.5s
# 默认取 min(8, 逻辑核数)，可用环境变量 THUMB_WORKERS 覆盖
THUMB_WORKERS = max(1, int(os.environ.get('THUMB_WORKERS') or min(8, (os.cpu_count() or 4))))
IMG_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff'}
# 后台访问密码（留空=不校验，仅本机使用时可不设；部署到公网务必设置）
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', '')
WEBP_ENABLED = os.environ.get('WEBP_THUMBS', '1') != '0'   # 额外生成 WebP 缩略图

# ── 自动打标：默认用 OVHcloud 免费匿名视觉链（免 key，每模型 2 次/分钟，5 模型轮流）
#    限流太狠时可以换成自己的接口：在 site.json 里加
#      "vision": { "base": "https://open.bigmodel.cn/api/paas/v4", "key": "你的key",
#                  "models": ["glm-4v-flash"] }
#    或用环境变量 VISION_BASE / VISION_API_KEY / VISION_MODELS 覆盖（模型名逗号分隔）
try:
    _SITE_CFG = json.load(open(os.path.join(ROOT, 'site.json'), encoding='utf-8'))
except Exception:  # noqa
    _SITE_CFG = {}
SITE_VISION = (_SITE_CFG.get('vision') or {}) if isinstance(_SITE_CFG, dict) else {}
# site.json 可覆盖 Banner / 头像输出尺寸："bannerSize": "1600x450"、"avatarSize": 320
try:
    _bs = str((_SITE_CFG or {}).get('bannerSize') or '').lower().split('x')
    if len(_bs) == 2:
        BANNER_W, BANNER_H = max(200, int(_bs[0])), max(80, int(_bs[1]))
except Exception:  # noqa
    pass
try:
    _av = int((_SITE_CFG or {}).get('avatarSize') or 0)
    if _av >= 64:
        AVATAR_PX = _av
except Exception:  # noqa
    pass
# 项目内的 vision.json（已加入 .gitignore，专门放 key，不会被提交/推送）
try:
    _LOCAL_VISION = json.load(open(os.path.join(ROOT, 'vision.json'), encoding='utf-8'))
except Exception:  # noqa
    _LOCAL_VISION = {}
if not isinstance(_LOCAL_VISION, dict):
    _LOCAL_VISION = {}
VISION_CFG = {**SITE_VISION, **_LOCAL_VISION}
OVH_VISION_BASE = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1'
OVH_VISION_MODELS = ['Qwen2.5-VL-72B-Instruct', 'Qwen3.5-397B-A17B', 'Qwen3.6-27B',
                     'Mistral-Small-3.2-24B-Instruct-2506', 'Qwen3.5-9B']
VISION_BASE = os.environ.get('VISION_BASE') or VISION_CFG.get('base') or OVH_VISION_BASE
VISION_KEY = os.environ.get('VISION_API_KEY') or VISION_CFG.get('key') or ''
VISION_MODELS = ([m.strip() for m in os.environ['VISION_MODELS'].split(',') if m.strip()]
                 if os.environ.get('VISION_MODELS')
                 else (VISION_CFG.get('models') or OVH_VISION_MODELS))


def _vision_chain():
    """打标用哪几家：配了自己的 key 就主用它，失败再回落 OVH 免费链"""
    chain = [{'name': '自定义' if VISION_KEY else '默认', 'base': VISION_BASE,
              'key': VISION_KEY, 'models': VISION_MODELS}]
    if VISION_BASE != OVH_VISION_BASE:
        chain.append({'name': 'OVH 免费', 'base': OVH_VISION_BASE, 'key': '', 'models': OVH_VISION_MODELS})
    return chain
VISION_PROMPT = (
    '你在为写真图集网站做内容标注。用户会给出同一套图集中的 1-3 张样图。\n'
    '请只输出一个 JSON 对象（不要任何解释、不要 markdown 代码块），格式：\n'
    '{"tags":["标签1","标签2"],"scene":"场景","clothing":"服装风格","style":"摄影风格"}\n'
    '要求：\n'
    '1. tags 给 6-10 个中文标签，覆盖维度：场景/环境、服装/造型、色调/光线、氛围/题材；\n'
    '2. 标签用常见短词（2-6 字），便于站内检索，如「教室」「制服」「夜景」「暖色调」「户外」「古风」；\n'
    '3. 不要出现真实人名、品牌、网站名，不要输出「写真」「图片」「美女」这类无检索价值的词；\n'
    '4. 不要输出人物年龄、身高、体重等个人信息（这些无法从图片判断），也不要写整段画面描述。'
)

# ───────────────────────── 工具 ─────────────────────────

def slugify(s: str) -> str:
    s = (s or '').strip().lower()
    s = re.sub(r'[^\w\u4e00-\u9fff-]+', '-', s)
    return re.sub(r'-{2,}', '-', s).strip('-') or 'set'


def unique_slug(base, model='', series=''):
    """目录名已被占用时给个不冲突的新名字。

    同名作品很常见（不同模特 / 不同系列拍同一个主题）。这时**优先用"确实不一样"的那个**接上去：
      同标题不同模特 → `2026-09-14-油菜花-许岚LAN`
      同标题同模特、不同系列 → `2026-09-14-油菜花-夏日晚风`
      两者都一样（真的是同名同人同系列）→ 才退回 `-2`
    这样目录名一眼能看出是哪一套，也比无意义的 -2 好找。
    """
    if not os.path.isdir(os.path.join(SETS_DIR, base)):
        return base
    try:
        old = read_meta(os.path.join(SETS_DIR, base))
    except Exception:  # noqa
        old = {}
    tags = []
    for val, key in ((model, 'model'), (series, 'series')):
        v = str(val or '').strip()
        if v and v != str(old.get(key) or '').strip():
            tags.append(v)
    # slug 片段保留大小写（许岚LAN 别变成 许岚lan），只清掉不适合做目录名的字符
    def frag(x):
        x = re.sub(r'[^\w\u4e00-\u9fff-]+', '-', str(x or '').strip())
        return re.sub(r'-{2,}', '-', x).strip('-')
    for t in tags:
        f = frag(t)
        if f and not os.path.isdir(os.path.join(SETS_DIR, f'{base}-{f}')):
            return f'{base}-{f}'
    for i in range(2, 500):
        cand = f'{base}-{i}'
        if not os.path.isdir(os.path.join(SETS_DIR, cand)):
            return cand
    return f'{base}-{int(time.time())}'


def make_thumb(src_bytes: bytes, dst: str, max_side: int, quality: int = THUMB_Q, box=None):
    """生成缩略图。

    · 不传 box：按【长边】等比缩放到 max_side —— 横竖构图总像素相近，且比例与原图完全一致
      （竖构图 2:3 → 1280×1920；横构图 3:2 → 1920×1280；16:9 → 1920×1080 / 1080×1920）
    · 传 box：居中裁切成固定尺寸（用于封面）
    同时生成 LQIP 模糊占位图与可选 WebP 版本。
    """
    img = Image.open(BytesIO(src_bytes))
    # JPEG 用 DCT 快速降采样解码：4480×6720 的原图只需解码 1/2 尺寸再缩放，
    # 画质几乎无损但速度快数倍（批量导入上百套时差别很大）；其它格式自动忽略
    try:
        if (img.format or '').upper() in ('JPEG', 'MPO'):
            img.draft('RGB', (max_side, max_side))
    except Exception:  # noqa
        pass
    im = ImageOps.exif_transpose(img)
    if box:
        out = ImageOps.fit(im.convert('RGB'), box, method=Image.LANCZOS, centering=(0.5, 0.4))
    else:
        out = im.convert('RGB')
        longest = max(out.width, out.height)
        if longest > max_side:
            scale = max_side / longest
            out = out.resize((max(1, round(out.width * scale)), max(1, round(out.height * scale))),
                             Image.LANCZOS)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    out.save(dst, 'JPEG', quality=quality, optimize=True, progressive=True)
    # LQIP：极小图，前端内联后先显示模糊版，再流式换成清晰图
    lqip = out.copy()
    lqip.thumbnail((LQIP_W, LQIP_W * 4), Image.LANCZOS)
    lqip.save(re.sub(r'\.jpg$', '.lqip.jpg', dst), 'JPEG', quality=40)
    # WebP 版本（体积通常再小 25-35%，构建时优先使用，jpg 作为老浏览器回退）
    if WEBP_ENABLED:
        try:
            out.save(re.sub(r'\.jpg$', '.webp', dst), 'WEBP', quality=WEBP_Q, method=6)
        except Exception as e:  # noqa
            print(f'[admin] WebP 生成失败（忽略）: {e}')
    return out.size


def _thumb_one(pair):
    """生成单张缩略图，返回错误信息（None = 成功）"""
    src, dst = pair
    try:
        make_thumb(open(src, 'rb').read(), dst, PREVIEW_LONG)
        return None
    except Exception as e:  # noqa
        return f'{os.path.basename(src)}: {e}'


def thumbs_parallel(pairs):
    """并发生成缩略图：pairs = [(原图路径, 缩略图路径), ...] → (成功数, 错误列表)"""
    pairs = [p for p in pairs if p]
    if not pairs:
        return 0, []
    if THUMB_WORKERS <= 1 or len(pairs) == 1:
        errs = [e for e in (_thumb_one(p) for p in pairs) if e]
    else:
        with ThreadPoolExecutor(max_workers=min(THUMB_WORKERS, len(pairs))) as ex:
            errs = [e for e in ex.map(_thumb_one, pairs) if e]
    return len(pairs) - len(errs), errs


def ensure_thumbs(set_dir: str, force=False):
    """为图集补齐所有缩略图与 LQIP；返回处理数量"""
    img_dir = os.path.join(set_dir, 'images')
    thumb_dir = os.path.join(set_dir, 'thumbs')
    if not os.path.isdir(img_dir):
        return 0
    os.makedirs(thumb_dir, exist_ok=True)
    n = 0
    pairs = []
    for f in sorted(os.listdir(img_dir)):
        if os.path.splitext(f)[1].lower() not in IMG_EXT:
            continue
        base = os.path.splitext(f)[0]
        dst = os.path.join(thumb_dir, base + '.jpg')
        need = (force or not os.path.exists(dst)
                or not os.path.exists(re.sub(r'\.jpg$', '.lqip.jpg', dst))
                or (WEBP_ENABLED and not os.path.exists(re.sub(r'\.jpg$', '.webp', dst))))
        if need:
            pairs.append((os.path.join(img_dir, f), dst))
    n, errs = thumbs_parallel(pairs)
    for e in errs:
        print(f'[admin] 缩略图失败 {e}')
    # 封面缩略图
    cover = next((c for c in ('cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp') if os.path.exists(os.path.join(set_dir, c))), None)
    if cover and (force or not os.path.exists(os.path.join(thumb_dir, 'cover.jpg'))):
        make_thumb(open(os.path.join(set_dir, cover), 'rb').read(), os.path.join(thumb_dir, 'cover.jpg'), 640, 88, box=(640, 854))
    return n


def set_signature(set_dir):
    """图集内容指纹：图片张数 + 各文件大小 + 首张图前 64KB 的内容哈希

    只看张数和大小会把「尺寸相同、大小恰好一样」的不同图集误判成完全重复，
    所以再掺一段真实内容（读 64KB 很快，整套图集比对仍是秒级）。"""
    img_dir = os.path.join(set_dir, 'images')
    if not os.path.isdir(img_dir):
        return ''
    names = [f for f in os.listdir(img_dir) if os.path.splitext(f)[1].lower() in IMG_EXT]
    if not names:
        return ''
    names.sort()
    sizes = [os.path.getsize(os.path.join(img_dir, f)) for f in names]
    sample = b''
    try:
        with open(os.path.join(img_dir, names[0]), 'rb') as fh:
            sample = fh.read(65536)
    except Exception:  # noqa
        pass
    key = str(len(sizes)) + '|' + ','.join(map(str, sorted(sizes))) + '|' + hashlib.md5(sample).hexdigest()
    return hashlib.md5(key.encode()).hexdigest()


def find_duplicate_sets(set_dir, exclude_slug=''):
    """找出与这套图集内容相同的其它图集（返回 [slug, ...]）"""
    sig = set_signature(set_dir)
    if not sig:
        return []
    hits = []
    for name in os.listdir(SETS_DIR):
        d = os.path.join(SETS_DIR, name)
        if name == exclude_slug or not os.path.isdir(d) or d == set_dir:
            continue
        if set_signature(d) == sig:
            hits.append(name)
    return hits


def _dist_ok():
    """产物体检：index.html 与 assets 必须存在且非空。
    曾经的事故：构建中途被打断（或两个构建并发互删 dist）→ dist 里只剩 html 没有 assets，
    访客看到的是完全没有样式的裸页面。"""
    for rel in ('index.html', os.path.join('assets', 'style.css'), os.path.join('assets', 'app.js')):
        fp = os.path.join(ROOT, 'dist', rel)
        if not os.path.exists(fp) or os.path.getsize(fp) == 0:
            return False, rel
    return True, ''


def _run_build(env):
    try:
        r = subprocess.run(['node', 'build.mjs'], cwd=ROOT, capture_output=True,
                           text=True, encoding='utf-8', errors='replace', timeout=900, env=env)
        return r.returncode == 0, ((r.stdout or '') + (r.stderr or '')).strip()
    except Exception as e:  # noqa
        return False, f'重建失败：{e}'


_rebuild_lock = threading.Lock()


def health_check():
    """站点体检：一键检查产物是否齐全、样式是否可达、各页引用的资源版本是否一致。
    针对"改封面后样式全丢"这类事故做的自检。"""
    import random
    import re
    DIST = os.path.join(ROOT, 'dist')
    lines, bad, warn = [], 0, 0

    def add(ok, text, level='bad'):
        nonlocal bad, warn
        mark = '✅' if ok else ('⚠️' if level == 'warn' else '❌')
        if not ok:
            if level == 'warn':
                warn += 1
            else:
                bad += 1
        lines.append(f'{mark} {text}')

    if not os.path.isdir(DIST):
        return '❌ 还没有 dist/ 产物，先点「重新构建站点」'

    # 1) 关键文件
    lines.append('【关键产物】')
    for rel in ('index.html', os.path.join('assets', 'style.css'), os.path.join('assets', 'app.js'),
                os.path.join('assets', 'photoswipe-extra.css'), 'search-index.json',
                'sitemap.xml', 'feed.xml', 'robots.txt', '404.html', '_headers'):
        p = os.path.join(DIST, rel)
        size = os.path.getsize(p) if os.path.exists(p) else 0
        add(size > 0, f'{rel}（{size} 字节）' if size else f'{rel} 缺失或为空')

    # 2) 各页面引用的资源版本是否一致 + 文件是否真的存在（混版/半成品检测）
    lines.append('')
    lines.append('【资源引用一致性】')

    def resolve_ref(page_path, ref):
        """按浏览器规则把引用解析成磁盘路径：/x → 站根；多余的 .. 夹在站根（不能上到域名之上）"""
        clean = ref.split('?')[0].split('#')[0]
        if clean.startswith('/'):
            cand = os.path.normpath(os.path.join(DIST, clean.lstrip('/')))
        else:
            cand = os.path.normpath(os.path.join(os.path.dirname(page_path), clean.replace('/', os.sep)))
        root = os.path.normpath(DIST)
        if not cand.startswith(root):
            tail = os.path.relpath(cand, root).replace('\\', '/')
            parts = [p for p in tail.split('/') if p not in ('..', '.', '')]
            cand = os.path.join(root, *parts)
        return cand

    vers, missing_ref, pages = {}, [], 0
    for dirpath, _, names in os.walk(DIST):
        for n in names:
            if not n.endswith('.html'):
                continue
            pages += 1
            p = os.path.join(dirpath, n)
            try:
                t = open(p, encoding='utf-8', errors='ignore').read(6000)
            except OSError:
                continue
            for m in re.finditer(r'(?:href|src)="([^"]*assets/[^"?]+)(?:\?v=([^"]+))?"', t):
                ref, v = m.group(1), m.group(2) or '(无版本)'
                if '://' in ref or ref.startswith('//'):
                    continue
                key = ref.split('assets/', 1)[-1]
                vers.setdefault(key, set()).add(v)
                if not os.path.exists(resolve_ref(p, ref)):
                    missing_ref.append(f'{os.path.relpath(p, DIST)} → {ref}')
    for rel, vs in sorted(vers.items()):
        add(len(vs) == 1, f'assets/{rel} 版本 {"、".join(sorted(vs))}' + ('' if len(vs) == 1 else f'（{len(vs)} 个不同版本 → 产物是新旧混合的）'), 'warn')
    add(not missing_ref, f'共 {pages} 个页面，引用缺失的资源 {len(missing_ref)} 处'
        + ('：' + '；'.join(missing_ref[:3]) if missing_ref else ''))

    # 3) 图片抽样
    lines.append('')
    lines.append('【图片抽样】')
    setdir = os.path.join(DIST, 'set')
    slugs = sorted(os.listdir(setdir)) if os.path.isdir(setdir) else []
    src_sets = [d for d in os.listdir(SETS_DIR) if os.path.isdir(os.path.join(SETS_DIR, d))]
    add(len(slugs) == len(src_sets), f'dist 里有 {len(slugs)} 套图集，sets/ 里有 {len(src_sets)} 套'
        + ('' if len(slugs) == len(src_sets) else '（不一致 → 可能没构建完）'))
    picks = random.sample(slugs, min(3, len(slugs))) if slugs else []
    for slug in picks:
        thumb_dir = os.path.join(setdir, slug, 'thumbs')
        thumbs = [f for f in os.listdir(thumb_dir) if f.endswith(('.webp', '.jpg'))] if os.path.isdir(thumb_dir) else []
        ok = bool(thumbs) and all(os.path.getsize(os.path.join(thumb_dir, f)) > 1024 for f in thumbs[:2])
        cover = os.path.exists(os.path.join(setdir, slug, 'cover.jpg'))
        add(ok, f'{slug[:34]}：缩略图 {len(thumbs)} 个' + ('' if ok else '（缺失或异常小）')
            + ('' if cover else ' · ⚠️ 无 cover.jpg'), 'bad' if not ok else 'warn')

    # 4) 残留与规模
    lines.append('')
    lines.append('【其它】')
    for leftover in ('dist.new', 'dist.old'):
        p = os.path.join(ROOT, leftover)
        if os.path.exists(p):
            cnt = sum(len(f) for _, _, f in os.walk(p))
            add(cnt == 0, f'{leftover}/ 残留 {cnt} 个文件（构建中断痕迹，可手动删除）', 'warn')
    total = sum(len(f) for _, _, f in os.walk(DIST))
    size_mb = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(DIST) for f in fs) / 1048576
    lines.append(f'ℹ️ dist 共 {total} 个文件 / {size_mb:.0f} MB')
    try:
        with socket.create_connection(('127.0.0.1', 8090), timeout=0.4):
            lines.append('ℹ️ 预览服务 8090 正在运行')
    except OSError:
        lines.append('⚠️ 预览服务 8090 没在运行（点「打开站点预览」前先跑 .\\preview.ps1）')
        warn += 1

    lines.append('')
    lines.append(f'结论：{"✅ 一切正常" if not bad else f"❌ 发现 {bad} 个问题"}'
                 + (f'，另有 {warn} 条提醒' if warn else ''))
    return '\n'.join(lines)


def rebuild():
    # 发布进行中禁止重建：deploy.py 正从 dist/ 读取上传，此时重建会换掉内容导致上传不一致
    if _pub['running']:
        return False, ('✗ 正在发布到线上（已用 %d 秒），请等发布完成后再重建站点。\n'
                       '  发布过程中改动 dist/ 会导致上传内容新旧混杂。'
                       % int(time.time() - _pub['started']))
    # 串行化：后台是多线程的（ThreadingHTTPServer），两个动作连着点会并发构建，
    # 各自 rmSync(dist) 再互相覆盖 → 产物变半成品（缺 assets 就是全站没样式）
    if not _rebuild_lock.acquire(timeout=180):
        return False, '✗ 等前一个构建等了 180 秒还没轮上，请稍后重试。'
    try:
        env = dict(os.environ)
        # 本地预览默认用精简模式：只拷缩略图（几百 MB、几秒），不拷几十 GB 原图
        # 需要本地看原图时设 ADMIN_REBUILD=full
        env['SITE_LITE'] = '1' if os.environ.get('ADMIN_REBUILD', 'lite') != 'full' else '0'
        env['SITE_PUBLIC'] = '0'          # 本地预览保留 ?admin=1 入口
        env.pop('SITE_BASE_URL', None)    # 本地不用线上域名
        ok, out = _run_build(env)
        good, missing = _dist_ok()
        if ok and not good:
            out += f'\n! 产物缺少 {missing}，已自动重跑一次构建…'
            ok, out2 = _run_build(env)
            out += '\n' + out2
            good, missing = _dist_ok()
        if ok and not good:
            ok = False
            out += (f'\n× 产物仍缺少 {missing}：页面会没有样式/脚本。'
                    '\n  排查方向：是否同时触发了两个构建、或构建进程被中途关掉？')
        elif ok:
            out += '\n✓ 产物体检通过（index.html + assets 齐全）'
        return ok, out
    finally:
        _rebuild_lock.release()


# ─────────────────── 一键发布到线上（Cloudflare Pages） ───────────────────
# 在后台点一下 = 构建（精简+公网模式）→ 体检 → 打包 → 上传，约 40 秒
PAGES_PROJECT = os.environ.get('PAGES_PROJECT', 'pixnest-gallery')
SITE_URL = os.environ.get('SITE_URL', 'https://pixnest.dpdns.org')
_pub_lock = threading.Lock()
_pub = {'running': False, 'ok': None, 'lines': [], 'started': 0.0, 'ended': 0.0, 'started_at': ''}


def _proxy_env():
    """本机有 Clash(7890) 在监听就带上代理（wrangler 要访问 Cloudflare API）"""
    env = dict(os.environ)
    try:
        with socket.create_connection(('127.0.0.1', 7890), timeout=0.3):
            env['HTTPS_PROXY'] = 'http://127.0.0.1:7890'
            env['HTTP_PROXY'] = 'http://127.0.0.1:7890'
    except Exception:  # noqa
        pass
    return env


def publish_start():
    """后台启动发布线程；返回 (是否启动, 提示)"""
    with _pub_lock:
        if _pub['running']:
            return False, '已有发布任务在进行中'
        _pub.update({'running': True, 'ok': None, 'lines': [], 'started': time.time(),
                     'ended': 0.0, 'started_at': time.strftime('%H:%M:%S')})

    def run():
        cmd = [sys.executable, '-u', 'deploy.py', '--cloudflare', '--project', PAGES_PROJECT, '--base-url', SITE_URL]
        _pub['lines'].append('$ ' + ' '.join(cmd[1:]))
        try:
            p = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, encoding='utf-8', errors='replace', env=_proxy_env(), bufsize=1)
            for line in p.stdout:
                _pub['lines'].append(line.rstrip('\n'))
                if len(_pub['lines']) > 600:
                    del _pub['lines'][:200]
            p.wait(timeout=900)
            ok = (p.returncode == 0)
            _pub['lines'].append('✅ 发布完成' if ok else f'✗ 发布失败（退出码 {p.returncode}）')
        except Exception as e:  # noqa
            ok = False
            _pub['lines'].append(f'✗ 发布异常：{e}')
        finally:
            _pub['running'] = False
            _pub['ok'] = ok
            _pub['ended'] = time.time()

    threading.Thread(target=run, daemon=True).start()
    return True, f'已开始发布到 {SITE_URL}（约 40 秒，期间线上访问不受影响）'


def publish_status():
    return {'running': _pub['running'], 'ok': _pub['ok'],
            'lines': _pub['lines'][-120:], 'started_at': _pub['started_at'],
            'elapsed': int((_pub['ended'] or time.time()) - _pub['started']) if _pub['started'] else 0,
            'site': SITE_URL, 'project': PAGES_PROJECT}


# ─────────────────── 批量自动打标（后台线程 + 实时进度） ───────────────────
_at_lock = threading.Lock()
_at = {'running': False, 'total': 0, 'done': 0, 'skipped': 0, 'failed': 0, 'current': '',
       'log': [], 'started': 0.0, 'ended': 0.0, 'forced': False}


def log_line(kind, text):
    """写后台日志文件：上传/发布这类慢操作出问题时能事后查（之前后台输出直接丢弃，出事只能猜）"""
    try:
        os.makedirs(os.path.join(ROOT, 'logs'), exist_ok=True)
        p = os.path.join(ROOT, 'logs', kind + '.log')
        with open(p, 'a', encoding='utf-8') as f:
            f.write(f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] {text}\n')
        # 单文件超过 2MB 就截断保留尾部
        if os.path.getsize(p) > 2 * 1024 * 1024:
            data = open(p, encoding='utf-8', errors='replace').read()[-1024 * 1024:]
            open(p, 'w', encoding='utf-8').write(data)
    except Exception:  # noqa
        pass


def rebuild_wait(timeout=180):
    """等正在进行的发布结束后再重建。
    否则连续两次内容改动（比如连点两下置顶）会碰上"发布中禁止重建"，
    第二次的改动就只写进了 meta、页面没更新。"""
    t0 = time.time()
    while _pub['running'] and time.time() - t0 < timeout:
        time.sleep(1.5)
    return rebuild()


def set_pin(slug, pinned=None, order=None, until=None):
    """置顶推荐：开关 / 排序 / 到期日。pinned=True 且没给 order 时自动排到最后一位。"""
    d = os.path.join(SETS_DIR, slug)
    if not os.path.isdir(d):
        return False, '图集不存在'
    meta = read_meta(d)
    if pinned is not None:
        meta['pinned'] = bool(pinned)
    if order is not None:
        try:
            meta['pinOrder'] = int(order)
        except Exception:  # noqa
            pass
    if until is not None:
        until = str(until).strip()
        if until:
            meta['pinUntil'] = until
        else:
            meta.pop('pinUntil', None)
    if meta.get('pinned') and not meta.get('pinOrder'):
        used = []
        for s in list_sets():
            if s['slug'] == slug:
                continue
            om = read_meta(os.path.join(SETS_DIR, s['slug']))
            if om.get('pinned'):
                used.append(int(om.get('pinOrder') or 0))
        meta['pinOrder'] = (max(used) + 1) if used else 1
    if not meta.get('pinned'):
        meta.pop('pinOrder', None)
        meta.pop('pinUntil', None)
    save_meta(d, meta)
    title = meta.get('title') or slug
    today = date.today().isoformat()
    n = 0
    for s in list_sets():
        om = read_meta(os.path.join(SETS_DIR, s['slug']))
        if om.get('pinned') and not (om.get('pinUntil') and str(om['pinUntil']) < today):
            n += 1   # 只数还没到期的
    if meta.get('pinned'):
        extra = f'（第 {meta.get("pinOrder")} 位' + (f'，置顶到 {meta["pinUntil"]}' if meta.get('pinUntil') else '') + '）'
        return True, f'✓ 已置顶「{title}」{extra}，当前共 {n} 套置顶'
    return True, f'✓ 已取消置顶「{title}」，当前共 {n} 套置顶'


def after_tagging(tagged):
    """打标跑完后的收尾：重建站点；开启自动发布时再同步到线上。
    没有这一步，标签只写进了 sets/*/meta.json，页面（本地 8090 与线上）都不会变。
    注意：重建 + 发布要几十秒，期间用 _at['finishing'] 标记，别让界面以为已经收工了。"""
    if not tagged:
        log_line('admin', '打标结束：本次没有新增标签，跳过重建')
        return
    _at['finishing'] = '正在重建站点…'
    try:
        ok, out = rebuild()
        first = next((l for l in (out or '').splitlines() if l.strip()), '')
        log_line('admin', f'打标结束自动重建：{"成功" if ok else "失败"}｜{first[:100]}')
        if not ok:
            _at['log'].append('✗ 打标后重建失败，页面不会更新（可手动点「重新构建站点」）')
            return
        if TAG_AUTOPUBLISH:
            _at['finishing'] = '正在同步到线上…'
            started, msg = publish_start()
            log_line('admin', f'打标结束自动发布：{msg}')
            _at['log'].append('🚀 自动同步到线上：' + msg)
        else:
            _at['log'].append('✓ 已自动重建站点（本地预览已更新；线上要点「同步到线上」）')
    finally:
        _at['finishing'] = ''


def autotag_queue_add(slugs, why='上传后自动打标'):
    """把若干图集塞进后台打标队列（已有任务在跑就追加进去）。
    上传/保存这类请求绝不能在请求里同步等视觉模型 —— 免费接口一被限流就是 429，
    一次调用要重试 50 秒以上，前端会一直转圈，看着像"上传卡住了"。"""
    slugs = [s for s in slugs if s]
    if not slugs:
        return False, '没有需要打标的图集'
    with _at_lock:
        if _at['running']:
            _at.setdefault('extra', []).extend(slugs)
            _at['total'] = _at.get('total', 0) + len(slugs)
            _at['log'].append(f'＋ {why}：追加 {len(slugs)} 套到队列')
            return True, f'已追加 {len(slugs)} 套到正在进行的打标队列'
        sets = [s for s in list_sets() if s['slug'] in set(slugs)]
        _at.update({'running': True, 'total': len(sets), 'done': 0, 'skipped': 0, 'failed': 0,
                    'current': '', 'log': [f'▶ {why}：{len(sets)} 套'], 'started': time.time(),
                    'ended': 0.0, 'forced': False, 'extra': []})

    def run():
        queue = [(s, 0) for s in sets]
        while True:
            with _at_lock:
                for sl in _at.get('extra') or []:
                    one = next((x for x in list_sets() if x['slug'] == sl), None)
                    if one:
                        queue.append((one, 0))
                _at['extra'] = []
            if not queue:
                break
            s, tries = queue.pop(0)
            title = s['meta'].get('title') or s['slug']
            if not os.path.isdir(os.path.join(SETS_DIR, s['slug'])):
                _at['log'].append(f'– {title}：图集已删除，跳过')
                _at['skipped'] += 1
                continue
            _at['current'] = title + (f'（重试 {tries}）' if tries else '')
            try:
                n, info, _ = autotag_set(os.path.join(SETS_DIR, s['slug']), samples=3)
                if n:
                    _at['done'] += 1
                    _at['log'].append(f'✓ {title}：{str(info)[:70]}')
                else:
                    _at['skipped'] += 1
                    _at['log'].append(f'– {title}：跳过（{str(info)[:50]}）')
                time.sleep(4)
            except Exception as e:  # noqa
                if tries < 3:
                    queue.append((s, tries + 1))
                    _at['log'].append(f'↻ {title}：{e} → 等限流窗口恢复后重试')
                    time.sleep(60)
                    continue
                _at['failed'] += 1
                _at['log'].append(f'✗ {title}：{e}（已重试 {tries} 次）')
                time.sleep(4)
        _at['current'] = ''
        _at['running'] = False
        _at['ended'] = time.time()
        try:
            after_tagging(_at.get('done', 0))
        except Exception as e:  # noqa
            log_line('error', f'打标后收尾失败：{type(e).__name__}: {e}')
        finally:
            _at['finishing'] = ''

    threading.Thread(target=run, daemon=True).start()
    return True, f'已把 {len(slugs)} 套放进后台打标队列（关闭页面不会中断，可在首页看进度）'


def autotag_batch_start(force=False, limit=0):
    """后台批量打标；force=True 连已打标的也重打，limit>0 只处理前 N 套"""
    with _at_lock:
        if _at['running']:
            return False, '已有打标任务在进行中'
        todo = []
        for s in list_sets():
            m = s['meta']
            if not force and (m.get('tags') or []) and m.get('autoTags'):
                continue
            todo.append(s)
        if limit > 0:
            todo = todo[:limit]
        if not todo:
            return False, '没有需要打标的图集（都已经打过了）'
        _at.update({'running': True, 'total': len(todo), 'done': 0, 'skipped': 0, 'failed': 0,
                    'current': '', 'log': [], 'started': time.time(), 'ended': 0.0,
                    'forced': bool(force)})

    def run():
        # 免费视觉接口每个模型限 2 次/分钟，连打必然 429 → 失败的排队重试，而不是直接放弃
        queue = [(s, 0) for s in todo]
        while queue:
            s, tries = queue.pop(0)
            title = s['meta'].get('title') or s['slug']
            _at['current'] = title + (f'（重试 {tries}）' if tries else '')
            try:
                n, info, _ = autotag_set(os.path.join(SETS_DIR, s['slug']), samples=3)
                if n:
                    _at['done'] += 1
                    _at['log'].append(f'✓ {title}：{str(info)[:70]}')
                else:
                    _at['skipped'] += 1
                    _at['log'].append(f'– {title}：跳过（{str(info)[:50]}）')
                time.sleep(4)            # 成功也稍作停顿，平摊请求频率
            except Exception as e:  # noqa
                if tries < 2:
                    queue.append((s, tries + 1))
                    _at['retrying'] = _at.get('retrying', 0) + 1
                    _at['log'].append(f'↻ {title}：{e} → 等待限流窗口恢复后重试')
                    time.sleep(50)       # 退避：等 429 窗口过去
                    continue
                _at['failed'] += 1
                _at['log'].append(f'✗ {title}：{e}（已重试 {tries} 次）')
                time.sleep(4)
        _at['current'] = ''
        _at['running'] = False
        _at['ended'] = time.time()
        try:
            after_tagging(_at.get('done', 0))
        except Exception as e:  # noqa
            log_line('error', f'打标后收尾失败：{type(e).__name__}: {e}')
        finally:
            _at['finishing'] = ''

    threading.Thread(target=run, daemon=True).start()
    return True, f'已开始打标 {len(todo)} 套（可实时看进度，关闭页面不会中断）'


def autotag_status():
    st = dict(_at)
    st['elapsed'] = int((_at['ended'] or time.time()) - _at['started']) if _at['started'] else 0
    st['log'] = _at['log'][-200:]
    return st


def read_meta(set_dir):
    mp = os.path.join(set_dir, 'meta.json')
    if os.path.exists(mp):
        try:
            return json.load(open(mp, encoding='utf-8'))
        except Exception:
            return {}
    return {}


def set_images(set_dir):
    d = os.path.join(set_dir, 'images')
    if not os.path.isdir(d):
        return []
    return sorted(f for f in os.listdir(d) if os.path.splitext(f)[1].lower() in IMG_EXT)


def image_hashes(set_dir):
    """已有图片的内容指纹 → {hash: 文件名}（用于上传去重）"""
    out = {}
    for f in set_images(set_dir):
        try:
            out[hashlib.md5(open(os.path.join(set_dir, 'images', f), 'rb').read()).hexdigest()] = f
        except Exception:
            pass
    return out


def detect_resolution(set_dir):
    """从图片文件头读取真实尺寸 → (显示字符串, 详细信息)
    规则：统计所有原图尺寸，若全一致用该尺寸；否则用出现最多的尺寸，并附带最大尺寸说明。"""
    from collections import Counter
    sizes = {}
    for f in set_images(set_dir):
        try:
            with Image.open(os.path.join(set_dir, 'images', f)) as im:
                sizes[f] = im.size          # 只读文件头，不解码像素，很快
        except Exception:
            continue
    if not sizes:
        return '', {'count': 0, 'distinct': 0}
    cnt = Counter(sizes.values())
    common, common_n = cnt.most_common(1)[0]
    biggest = max(sizes.values(), key=lambda s: s[0] * s[1])
    txt = f'{common[0]}x{common[1]}'
    info = {'count': len(sizes), 'distinct': len(cnt), 'common': txt, 'commonCount': common_n,
            'biggest': f'{biggest[0]}x{biggest[1]}', 'sizes': {f'{w}x{h}': n for (w, h), n in cnt.most_common(6)}}
    if len(cnt) > 1:
        txt += f'（主要 {common_n}/{len(sizes)} 张，最大 {biggest[0]}x{biggest[1]}）'
    return txt, info


def dedupe_set(set_dir):
    """按内容指纹清理重复图片（保留文件名最靠前的一张），返回删除数量"""
    seen, removed = {}, 0
    for f in set_images(set_dir):
        p = os.path.join(set_dir, 'images', f)
        try:
            h = hashlib.md5(open(p, 'rb').read()).hexdigest()
        except Exception:
            continue
        if h in seen:
            os.remove(p)
            for extra in (os.path.join(set_dir, 'thumbs', os.path.splitext(f)[0] + '.jpg'),
                          os.path.join(set_dir, 'thumbs', os.path.splitext(f)[0] + '.lqip.jpg')):
                if os.path.exists(extra):
                    os.remove(extra)
            removed += 1
        else:
            seen[h] = f
    if removed:
        meta = read_meta(set_dir)
        meta['imageCount'] = len(set_images(set_dir))
        save_meta(set_dir, meta)
    return removed


def list_sets():
    if not os.path.isdir(SETS_DIR):
        return []
    out = []
    for name in sorted(os.listdir(SETS_DIR), reverse=True):
        d = os.path.join(SETS_DIR, name)
        if not os.path.isdir(d):
            continue
        meta = read_meta(d)
        imgs = set_images(d)
        cover = next((f for f in ('cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp') if os.path.exists(os.path.join(d, f))), None)
        thumb = os.path.join(d, 'thumbs', 'cover.jpg')
        out.append({
            'slug': name, 'meta': meta, 'count': len(imgs), 'cover': cover,
            'hasPack': os.path.exists(os.path.join(d, 'pack.zip')),
            'coverUrl': f'/preview/{quote(name)}/thumbs/cover.jpg' if os.path.exists(thumb) else (f'/preview/{quote(name)}/{cover}' if cover else ''),
        })
    return out


def save_meta(set_dir, data):
    json.dump(data, open(os.path.join(set_dir, 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)


# ───────────────────────── 自动打标（视觉模型） ─────────────────────────

def _vision_payload_b64(path, max_w=768):
    """把图片压到 max_w 宽再转 base64（省流量与 token）"""
    im = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    buf = BytesIO()
    im.save(buf, 'JPEG', quality=82)
    return base64.b64encode(buf.getvalue()).decode()


def _vision_text(data):
    """从各家返回体里掏出正文：OpenAI 风格在 choices[0].message.content，
    但有的模型会给 reasoning_content、有的把内容放在 choices[0].text，
    偶尔还会返回空 content（限流/拒答）——这里统一兜住，并给出可诊断的错误。"""
    try:
        ch = (data.get('choices') or [{}])[0]
    except Exception:  # noqa
        ch = {}
    msg = ch.get('message') or {}
    for cand in (msg.get('content'), msg.get('reasoning_content'), ch.get('text'), msg.get('reasoning')):
        if isinstance(cand, list):                       # 有些实现返回分段数组
            cand = ''.join(str(x.get('text', x)) if isinstance(x, dict) else str(x) for x in cand)
        if isinstance(cand, str) and cand.strip():
            return cand
    raise RuntimeError('模型返回里没有正文（%s）' % json.dumps(data, ensure_ascii=False)[:220])


def _extract_json(text):
    """把模型返回的正文解析成 dict：优先直接 JSON，其次从 ```json 块里抠，最后退化为关键词列表"""
    t = re.sub(r'^```(?:json)?|```$', '', (text or '').strip(), flags=re.M).strip()
    m = re.search(r'\{.*\}', t, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    tags = re.findall(r'[\"“]([^\"”\n]{2,8})[\"”]', t)
    return {'tags': tags[:10], 'description': t[:80]}


_vision_cooldown = {}          # 模型 → 冷却到期时间戳（被 429 后先别再去撞，省请求额度）

# 打标跑完后是否自动同步到线上（默认开：上传→打标→页面自己更新，不用手点）。
# 不想要就设环境变量 TAG_AUTOPUBLISH=0
TAG_AUTOPUBLISH = os.environ.get('TAG_AUTOPUBLISH', '1') not in ('0', 'false', 'no')


def vision_analyze(paths, timeout=150):
    """分析样图 → {tags, description, ...}；失败抛异常。
    按 _vision_chain() 逐家逐模型试：自家 key 的接口优先，再回落 OVH 免费链。"""
    content = [{'type': 'text', 'text': VISION_PROMPT}]
    for p in paths[:3]:
        content.append({'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + _vision_payload_b64(p)}})
    last = 'unknown'
    now = time.time()
    tried = []
    for prov in _vision_chain():
        base, key = prov['base'].rstrip('/'), prov['key']
        usable = [m for m in prov['models'] if _vision_cooldown.get(base + '|' + m, 0) <= now] or prov['models']
        for model in usable:
            try:
                body = json.dumps({
                    'model': model,
                    'messages': [{'role': 'user', 'content': content}],
                    'max_tokens': 700,
                    'temperature': 0.4,
                }).encode('utf-8')
                headers = {'Content-Type': 'application/json', 'User-Agent': 'img-site-admin'}
                if key:
                    headers['Authorization'] = 'Bearer ' + key
                req = urllib.request.Request(base + '/chat/completions', data=body, headers=headers)
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = json.loads(resp.read().decode('utf-8'))
                out = _extract_json(_vision_text(data))
                out['_model'] = model
                out['_provider'] = prov['name']
                return out
            except urllib.error.HTTPError as e:
                last = f'{prov["name"]}/{model}: HTTP {e.code}'
                tried.append(last + ' ' + e.read().decode('utf-8', 'replace')[:100])
                if e.code in (429, 402, 403):
                    _vision_cooldown[base + '|' + model] = time.time() + 75
            except Exception as e:  # noqa
                last = f'{prov["name"]}/{model}: {e}'
                tried.append(last)
                log_line('error', f'打标 {prov["name"]}/{model} 失败：{type(e).__name__}: {e}')
            time.sleep(0.5)
    raise RuntimeError('视觉模型均不可用；' + ' | '.join(tried[-4:] or [last]))


def autotag_set(set_dir, samples=3, make_description=True, force=False):
    """对一套图集自动打标：样图 → 视觉模型 → 写入 meta.tags / meta.autoTags / meta.modelInfo"""
    meta = read_meta(set_dir)
    if meta.get('tags') and meta.get('autoTags') and not force:
        return 0, '已有标签，跳过（如需重跑请勾选强制）', meta
    imgs = set_images(set_dir)
    if not imgs:
        return 0, '没有图片', meta
    # 取样：封面图优先，其次首/中/尾
    picks = []
    cover = next((c for c in ('cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp') if os.path.exists(os.path.join(set_dir, c))), None)
    order = [imgs[0], imgs[len(imgs) // 2], imgs[-1]]
    for f in ([cover] if cover else []) + order:
        p = os.path.join(set_dir, f) if f == cover else os.path.join(set_dir, 'images', f)
        if p and os.path.exists(p) and p not in picks:
            picks.append(p)
        if len(picks) >= samples:
            break

    res = vision_analyze(picks)
    tags = [str(t).strip() for t in (res.get('tags') or []) if str(t).strip()][:12]
    # 合并：保留用户已有标签，追加 AI 标签（去重）
    merged = list(dict.fromkeys(list(meta.get('tags') or []) + tags))
    meta['tags'] = merged
    meta['autoTags'] = tags
    meta['autoTaggedAt'] = date.today().isoformat()
    meta['autoTagModel'] = res.pop('_model', '')
    for k in ('scene', 'clothing', 'style'):
        if res.get(k):
            meta.setdefault('autoFacts', {})[k] = str(res[k]).strip()
    save_meta(set_dir, meta)
    return len(tags), '、'.join(tags), meta


# ───────────────────────── 样式 ─────────────────────────

CSS = """
:root{--bg:#0f1115;--panel:#171a21;--panel2:#1e222b;--line:#2a2f3a;--fg:#e8ebf0;--dim:#98a1b3;--accent:#5b8cff;--ok:#3ecf8e;--err:#ff6b6b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:22px 20px 60px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--dim);margin:0 0 18px;font-size:13px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:18px}
.panel h2{font-size:15px;margin:0 0 12px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
label{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}
input[type=text],input[type=date],textarea{width:100%;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--fg);outline:none;font:inherit}
input:focus,textarea:focus{border-color:var(--accent)}
.drop{margin-top:12px;border:2px dashed var(--line);border-radius:12px;padding:24px;text-align:center;color:var(--dim);cursor:pointer;transition:.15s}
.drop.on{border-color:var(--accent);background:rgba(91,140,255,.08);color:var(--fg)}
.drop strong{color:var(--fg)}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;border-radius:8px;border:1px solid transparent;background:var(--accent);color:#fff;font-weight:600;cursor:pointer;font:inherit;text-decoration:none}
.btn.ghost{background:var(--panel2);color:var(--fg);border-color:var(--line)}
.btn.danger{background:transparent;color:var(--err);border-color:rgba(255,107,107,.4)}
.btn.sm{padding:6px 12px;font-size:12px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}
.files{margin-top:10px;font-size:12px;color:var(--dim);max-height:110px;overflow:auto}
.sets{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px}
/* 紧凑列表视图：图集多时一屏能扫更多，缩略图缩小到 40px */
.sets[data-view="list"]{grid-template-columns:1fr;gap:6px}
.sets[data-view="list"] .set{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:8px}
.sets[data-view="list"] .set img{width:40px;height:53px;flex:0 0 40px;border-radius:5px;object-fit:cover}
.sets[data-view="list"] .set .body{flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding:0}
.sets[data-view="list"] .set .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px}
.sets[data-view="list"] .set .m{white-space:nowrap;color:var(--dim);font-size:12px}
.sets[data-view="list"] .set .acts{opacity:1;padding:0}
.sets[data-view="list"] .set .pick{position:static;margin-right:2px}
/* 分页（与前台同一套 Bootstrap 分页规范）*/
.pagination-wrap{display:flex;flex-direction:column;align-items:center;gap:8px;margin:18px 0 6px}
.pagination-wrap[hidden]{display:none}
.pagination{display:flex;flex-wrap:wrap;gap:5px;list-style:none;margin:0;padding:0;justify-content:center}
.pagination .page-link{display:block;min-width:34px;text-align:center;padding:6px 10px;border:1px solid var(--line);
  border-radius:8px;background:var(--panel2);color:var(--fg);text-decoration:none;font-size:13px;line-height:1.25}
.pagination .page-item:not(.disabled):not(.active) .page-link:hover{border-color:var(--accent);color:var(--accent)}
.pagination .page-item.active .page-link{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.pagination .page-item.disabled .page-link{opacity:.45;cursor:not-allowed}
.pagination-info{color:var(--dim);font-size:12.5px;margin:0}
.set{background:var(--panel2);border:1px solid var(--line);border-radius:10px;overflow:hidden;cursor:pointer;transition:border-color .15s,transform .15s}
.set:hover{border-color:var(--accent);transform:translateY(-2px)}
.set img{width:100%;aspect-ratio:3/4;object-fit:cover;background:#111;display:block}
.set .body{padding:10px}
.set .t{font-weight:600;font-size:13px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:36px}
.set .m{color:var(--dim);font-size:12px;margin:4px 0 8px}
.set .acts{display:flex;gap:6px;flex-wrap:wrap}
a.mini,button.mini{font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--fg);text-decoration:none;cursor:pointer}
a.mini:hover,button.mini:hover{border-color:var(--accent)}
.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.thumb{background:var(--panel2);border:1px solid var(--line);border-radius:10px;overflow:hidden;position:relative}
.thumb img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block}
.thumb .ops{display:flex;gap:4px;padding:6px;flex-wrap:wrap;justify-content:center}
.thumb .ops button{font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--fg);cursor:pointer}
.thumb .badge{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.7);color:#fff;font-size:11px;padding:1px 7px;border-radius:999px}
.thumb.is-cover{outline:2px solid var(--accent)}
.toast{position:fixed;right:20px;bottom:20px;padding:12px 18px;border-radius:10px;background:var(--panel);border:1px solid var(--line);max-width:460px;white-space:pre-wrap;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.4);z-index:99}
.toast.ok{border-color:var(--ok)}.toast.err{border-color:var(--err)}
code{background:rgba(255,180,84,.15);color:#ffb454;padding:1px 6px;border-radius:4px}
.crumb{font-size:13px;color:var(--dim);margin-bottom:12px}
.crumb a{color:var(--dim)}
/* 标签芯片 */
.chips{display:flex;flex-wrap:wrap;gap:8px;padding:10px;min-height:46px;background:var(--panel2);border:1px solid var(--line);border-radius:8px}
.chips:empty::before{content:'暂无标签，用下面的输入框添加';color:var(--dim);font-size:12px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:5px 6px 5px 12px;border-radius:999px;background:rgba(91,140,255,.14);border:1px solid rgba(91,140,255,.45);color:var(--fg);font-size:13px}
.chip button{border:none;background:rgba(255,255,255,.12);color:var(--fg);width:18px;height:18px;line-height:1;border-radius:50%;cursor:pointer;font-size:12px;padding:0}
.chip button:hover{background:var(--err);color:#fff}
.ok-chip{padding:4px 10px;background:rgba(78,201,154,.14);border-color:rgba(78,201,154,.45);color:#4ec99a;font-size:12px}
.chip-ai{background:rgba(255,180,84,.12);border-color:rgba(255,180,84,.5);color:var(--accent2);cursor:pointer;padding:4px 12px}
.chip-ai:hover{background:rgba(255,180,84,.25)}
.chip-add{display:flex;gap:8px;margin-top:8px}
.chip-add input{flex:1}
.field-wide{grid-column:1/-1}
/* 上传进度条 */
.progress{margin-top:10px;height:8px;border-radius:999px;background:var(--panel2);overflow:hidden}
.progress .bar{height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--ok));transition:width .25s}
/* 批量操作栏 */
.bulk{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px;padding:10px 12px;background:var(--panel2);border:1px solid var(--line);border-radius:8px}
.bulk input[type=text]{max-width:200px}
/* 网盘链接批量导入：预览表格 */
table.lk{width:100%;border-collapse:collapse;margin-top:14px;font-size:13px}
table.lk th,table.lk td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
table.lk th{color:var(--dim);font-weight:500;white-space:nowrap}
table.lk tr.bad td{color:#ff8a8a}
/* 批量导入：本次导入区块 */
.imp{border:1px solid var(--accent);border-radius:12px;padding:14px 16px;margin:12px 0;background:rgba(91,140,255,.07)}
.imp-title{font-weight:600;margin-bottom:10px;color:var(--accent)}
.imp label{font-size:13px}
.hint{color:var(--dim);font-weight:400;font-size:12px}
/* 发布面板 */
.pub{margin-top:14px;border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--panel2)}
.pub-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.pub pre{margin:0;max-height:280px;overflow:auto;font-size:12px;line-height:1.6;white-space:pre-wrap;
  font-family:ui-monospace,Consolas,monospace;color:var(--fg)}
.set .pick{position:absolute;top:8px;right:8px;width:20px;height:20px;cursor:pointer;z-index:2}
.set{position:relative}
/* 置顶标记：卡片左上角金标，带序号（第几位置顶） */
.pinbadge{position:absolute;left:8px;top:8px;z-index:3;background:rgba(255,180,84,.94);color:#1a1206;
  font-size:11px;font-weight:700;line-height:1;padding:4px 7px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.35)}
.sets[data-view="list"] .pinbadge{position:static;margin-right:2px}
.set.picked{outline:2px solid var(--accent)}
/* 封面裁剪器 */
.cropper{position:fixed;inset:0;z-index:200;background:rgba(8,10,14,.96);overflow:auto;padding:12px 20px}
/* 顶部按钮条吸顶：弹层内容比屏幕高时，滚动也不会把「保存」滚出视野 */
.crop-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:var(--fg);font-size:14px;
  position:sticky;top:0;z-index:6;background:rgba(8,10,14,.97);padding:8px 0 9px;margin-bottom:6px;
  border-bottom:1px solid var(--line)}
.crop-head select{padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--fg)}
.crop-warn{margin:0 0 8px;font-size:12px;color:var(--dim)}
.crop-warn b{color:var(--accent2)}
.crop-stage{position:relative;display:inline-block;max-width:100%;user-select:none;touch-action:none}
.crop-stage img{max-width:min(1100px,92vw);max-height:56vh;display:block;border-radius:8px}
.crop-box{position:absolute;border:2px solid var(--accent);box-shadow:0 0 0 9999px rgba(0,0,0,.55);cursor:move;border-radius:2px}
.crop-grip{position:absolute;right:-8px;bottom:-8px;width:18px;height:18px;background:var(--accent);border-radius:4px;cursor:nwse-resize;border:2px solid #fff}
.crop-head b{font-size:15px}
.crop-strip{display:flex;gap:6px;overflow-x:auto;padding:2px 0 8px;margin-bottom:4px}
.crop-strip img{width:40px;height:54px;object-fit:cover;border-radius:6px;cursor:pointer;opacity:.55;
  border:2px solid transparent;background:#111;flex:0 0 auto;transition:.15s}
.crop-strip img:hover{opacity:.9}
.crop-strip img.on{opacity:1;border-color:var(--accent)}
/* 首页大图：标出"会被标题文字压暗"的下半部分，避免重要内容裁进去却看不见 */
.crop-safe{position:absolute;left:0;right:0;bottom:0;height:38%;pointer-events:none;border-radius:0 0 8px 8px;
  background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.45) 55%,rgba(0,0,0,.8));
  display:flex;align-items:flex-end;padding:8px 10px;box-sizing:border-box}
.crop-safe span{font-size:12px;color:#fff;background:rgba(0,0,0,.5);padding:2px 8px;border-radius:999px;opacity:.9}
/* 选区实时预览：按最终的显示框裁出来，所见即所得（标题压暗效果也一起模拟） */
.crop-preview{position:relative;display:block;margin:10px 0 0;overflow:hidden;background:#000;
  border:1px solid var(--line);border-radius:10px;width:160px}
.crop-preview.wide{width:min(420px,92vw)}
.crop-preview:not(.wide){border-radius:22%}
.cp-inner{position:relative;width:100%;overflow:hidden}
.crop-preview.wide .cp-inner{aspect-ratio:32/9}
.crop-preview:not(.wide) .cp-inner{aspect-ratio:1}
.cp-inner img{position:absolute;max-width:none;display:block}
.cp-overlay{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;gap:6px;
  padding:9px 11px;box-sizing:border-box;pointer-events:none;
  background:linear-gradient(180deg,rgba(0,0,0,0) 0%,rgba(0,0,0,0) 46%,rgba(0,0,0,.24) 66%,rgba(0,0,0,.62) 86%,rgba(0,0,0,.82) 100%)}
.cp-overlay b{font-size:13px;font-weight:600;color:#fff}
.cp-badge{align-self:flex-start;background:rgba(255,180,84,.92);color:#1a1206;font-size:11px;font-weight:600;
  padding:2px 8px;border-radius:999px}
.crop-preview-note{font-size:12px;color:var(--dim);margin:6px 0 0}
/* 标签管理 */
.tagtable{width:100%;border-collapse:collapse;font-size:13px}
.tagtable th{text-align:left;color:var(--dim);font-weight:400;padding:6px 8px;border-bottom:1px solid var(--line)}
.tagtable td{padding:6px 8px;border-bottom:1px solid var(--line)}
.tagtable input[type=text]{padding:5px 8px;font-size:12px}
.tagtable .mini{font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--fg);cursor:pointer;margin-left:4px}
.taggroup{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;padding:10px 0;border-bottom:1px dashed var(--line)}
.taggroup:last-child{border-bottom:none}
.tg-list{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.tg-act{display:flex;gap:8px;align-items:center}
.tg-act select{padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--fg)}
"""

JS = """
function toast(msg,ok){document.querySelectorAll('.toast').forEach(t=>t.remove());const d=document.createElement('div');d.className='toast '+(ok===undefined?'':(ok?'ok':'err'));d.textContent=String(msg).slice(0,400);document.body.appendChild(d);if(ok!==undefined)setTimeout(()=>d.remove(),4500)}
// 任何脚本错误都弹出来，不要静默失败（本地工具，出错必须看得见）
window.onerror=function(m,src,line,col){try{toast('页面脚本出错（第 '+line+' 行）：'+m,false)}catch(e){}return false};
window.addEventListener('unhandledrejection',function(e){try{toast('页面脚本出错：'+((e.reason&&e.reason.message)||e.reason),false)}catch(x){}});
function rebuild(){toast('正在重建…');fetch('/rebuild',{method:'POST'}).then(r=>r.text()).then(t=>{toast(t,true);setTimeout(()=>location.reload(),900)}).catch(e=>toast('失败：'+e,false))}
// ── 一键同步到线上（构建+体检+打包+上传，约 40 秒）──
let pubTimer=null;
function pubBox(){return document.getElementById('pubBox')}
function pubTitle(t){var e=document.getElementById('pubTitle');if(e)e.textContent=t}
function publishNow(){
  if(!confirm('把当前内容同步到线上？\\n\\n会执行：构建（精简·公网模式）→ 体检 → 打包 → 上传。\\n约 40 秒，只上传有变化的文件，线上访问不受影响。'))return;
  fetch('/publish',{method:'POST'}).then(r=>r.json()).then(d=>{
    toast(d.msg,d.started);
    if(d.started){pubTitle('发布到线上');pubBox().hidden=false;pollPublish()}
  }).catch(e=>toast('启动失败：'+e,false));
}
function publishLog(){pubTitle('发布到线上');pubBox().hidden=false;pollPublish()}
function pollPublish(){
  clearTimeout(pubTimer);
  const box=pubBox(),log=document.getElementById('pubLog'),msg=document.getElementById('pubMsg');
  fetch('/publish/status').then(r=>r.json()).then(d=>{
    log.textContent=(d.lines||[]).join('\\n');log.scrollTop=log.scrollHeight;
    if(d.running){msg.textContent='⏳ 发布中…（开始于 '+d.started_at+'，已用 '+d.elapsed+' 秒）';pubTimer=setTimeout(pollPublish,1500)}
    else if(d.ok===true){msg.innerHTML='✅ 发布成功 · <a href="'+d.site+'" target="_blank">打开线上站点 ↗</a>'}
    else if(d.ok===false){msg.textContent='❌ 发布失败（详见下方日志）'}
    else{msg.textContent='还没有发布过'}
  }).catch(()=>{pubTimer=setTimeout(pollPublish,3000)});
}
// 进页面时若正在发布（或刚发布完）自动接着显示
fetch('/publish/status').then(r=>r.json()).then(d=>{if(d.running){pubBox().hidden=false;pollPublish()}}).catch(()=>{});
function post(url,body,reload){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(r=>r.text()).then(t=>{toast(t,true);if(reload!==false)setTimeout(()=>location.href=reload||location.href,700)})}
function del(slug){
  if(!confirm('删除图集 '+slug+' ？\\n\\n会移到 _trash/ 回收站（可手动找回），然后自动重建站点。'))return;
  toast('正在删除 '+slug+' …');
  fetch('/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug})})
    .then(function(r){return r.text().then(function(t){if(!r.ok)throw new Error(t);return t})})
    .then(function(t){toast(t,true);setTimeout(function(){location.href='/'},1000)})
    .catch(function(e){toast('删除失败：'+(e.message||e)+'（图集未受影响）',false)});
}
function togglePin(slug,on){
  toast((on?'正在置顶 ':'正在取消置顶 ')+slug+' …');
  fetch('/pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:slug,pinned:!!on})})
    .then(function(r){return r.text().then(function(t){if(!r.ok)throw new Error(t);return t})})
    .then(function(t){toast(t,true);setTimeout(function(){location.reload()},1200)})
    .catch(function(e){toast('操作失败：'+(e.message||e),false)});
}
function purgeTrash(){  if(!confirm('清空回收站 _trash/ ？\\n\\n里面是之前删除的图集，清空后无法恢复。'))return;
  toast('正在清空回收站…');
  fetch('/purge-trash',{method:'POST'})
    .then(function(r){return r.text().then(function(t){if(!r.ok)throw new Error(t);return t})})
    .then(function(t){toast(t,true)})
    .catch(function(e){toast('清空失败：'+(e.message||e),false)});
}
function setCover(slug,img){if(!confirm('把 '+img+' 设为封面？'))return;post('/setcover',{slug,img},'/edit?slug='+encodeURIComponent(slug))}
function delImage(slug,img){if(!confirm('删除图片 '+img+' ？不可恢复'))return;post('/deleteimage',{slug,img},'/edit?slug='+encodeURIComponent(slug))}
function dedupe(slug){if(!confirm('按内容清理重复图片（保留每组的第一张）？'))return;post('/dedupe',{slug},'/edit?slug='+encodeURIComponent(slug))}
function autotag(slug,force){toast('🤖 正在分析样图（约 10-30 秒）…');fetch('/autotag',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug,force:!!force,samples:3})}).then(r=>r.text()).then(t=>{toast(t,true);setTimeout(()=>location.reload(),1600)}).catch(e=>toast('失败：'+e,false))}
let atTimer=null;
function autotagAll(){
  if(!confirm('对未打标的图集批量自动打标？\\n\\n每套约 4-30 秒，下方会实时显示进度；\\n任务跑在服务端，中途关掉页面也不会中断。'))return;
  fetch('/autotag-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({force:false})})
    .then(r=>r.json()).then(d=>{toast(d.msg,d.started);if(d.started){document.getElementById('atBox').hidden=false;pollAutotag()}})
    .catch(e=>toast('启动失败：'+e,false));
}
function pollAutotag(){
  clearTimeout(atTimer);
  const log=document.getElementById('atLog'),msg=document.getElementById('atMsg'),bar=document.getElementById('atBar');
  fetch('/autotag-status').then(r=>r.json()).then(d=>{
    log.textContent=(d.log||[]).join('\\n');log.scrollTop=log.scrollHeight;
    const fin=(d.done||0)+(d.skipped||0)+(d.failed||0);
    const pct=d.total?Math.round(fin/d.total*100):0;
    bar.style.width=pct+'%';
    if(d.running){
      msg.textContent='⏳ '+pct+'%（'+fin+'/'+d.total+'）· 正在处理：'+(d.current||'…')+
        ' · 成功 '+d.done+' · 跳过 '+d.skipped+' · 失败 '+d.failed+' · 已用 '+d.elapsed+' 秒';
      atTimer=setTimeout(pollAutotag,2000);
    }else if(d.total){
      msg.innerHTML='✅ 完成：成功 '+d.done+' 套'+(d.skipped?('，跳过 '+d.skipped):'')+(d.failed?('，失败 '+d.failed):'')+
        ' · 用时 '+d.elapsed+' 秒 · <a href="/">刷新列表</a> <span class="sub">（打标后要点「🚀 同步到线上」才会显示在站点上）</span>';
    }else{msg.textContent='还没有打标任务'}
  }).catch(()=>{atTimer=setTimeout(pollAutotag,3000)});
}
// 进页面时若正在打标，自动接上进度
fetch('/autotag-status').then(r=>r.json()).then(d=>{if(d.running){document.getElementById('atBox').hidden=false;pollAutotag()}}).catch(()=>{});
function detectRes(slug){toast('📐 正在读取图片尺寸…');post('/detectres',{slug},'/edit?slug='+encodeURIComponent(slug))}
function detectResAll(){toast('正在检测所有图集…');fetch('/detectres-all',{method:'POST'}).then(r=>r.text()).then(t=>{toast(t,true);setTimeout(()=>location.reload(),1200)}).catch(e=>toast('失败：'+e,false))}
// 标签芯片编辑
let TAGS=[];
function renderTags(){const box=document.getElementById('tagChips');if(!box)return;box.innerHTML=TAGS.map((t,i)=>'<span class="chip">'+t+'<button type="button" onclick="removeTag('+i+')" title="删除">×</button></span>').join('');document.getElementById('tagsValue').value=TAGS.join(',')}
function addTagValue(v){v=(v||'').trim();if(!v)return;if(TAGS.includes(v)){toast('标签已存在：'+v);return}TAGS.push(v);renderTags()}
function addTag(){const i=document.getElementById('tagInput');addTagValue(i.value);i.value='';i.focus()}
function removeTag(i){TAGS.splice(i,1);renderTags()}
function pullAiTags(){document.querySelectorAll('.chip-ai').forEach(b=>addTagValue(b.textContent))}
document.addEventListener('DOMContentLoaded',()=>{const v=document.getElementById('tagsValue');if(v){TAGS=(v.value||'').split(',').map(s=>s.trim()).filter(Boolean);renderTags()}const ti=document.getElementById('tagInput');if(ti){ti.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();addTag()}})}initDrag()});
function backfill(){toast('正在补齐缩略图…');fetch('/backfill',{method:'POST'}).then(r=>r.text()).then(t=>{toast(t,true);setTimeout(()=>location.reload(),1200)}).catch(e=>toast('失败：'+e,false))}
function dupCheck(){toast('正在比对全库内容…');fetch('/dupcheck',{method:'POST'}).then(r=>r.text()).then(t=>{alert(t);toast('检查完成',true)}).catch(e=>toast('失败：'+e,false))}
function healthCheck(){var b=document.getElementById('pubBox'),m=document.getElementById('pubMsg'),p=document.getElementById('pubLog');pubTitle('🩺 站点体检');b.hidden=false;m.textContent='正在体检…';p.textContent='';toast('正在体检站点…');fetch('/healthcheck',{method:'POST'}).then(r=>r.text()).then(function(t){p.textContent=t;var ok=t.indexOf('❌')<0;m.textContent=ok?'体检通过':'发现问题';toast(ok?'✅ 体检通过':'❌ 发现问题，看下方明细',ok)}).catch(function(e){p.textContent='体检失败：'+e;m.textContent='失败';toast('体检失败：'+e,false)})}
// ── 以下为跨页面公共函数（编辑页/批量页/首页都会用到，必须放共享 JS，否则其他页面报 not defined）──
const IMG_RE=/\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;
function readEntries(rd){return new Promise(res=>{const all=[];const step=()=>rd.readEntries(es=>{if(!es.length)return res(all);all.push(...es);step()});step()})}
async function walkEntry(entry,acc){
  if(!entry)return;
  if(entry.isFile){acc.push(entry);return}
  if(entry.isDirectory){for(const e of await readEntries(entry.createReader()))await walkEntry(e,acc)}
}
async function walkItems(items){
  const entries=[];
  for(const it of items){const en=it.webkitGetAsEntry&&it.webkitGetAsEntry();if(en)await walkEntry(en,entries)}
  const out=[];
  for(const en of entries){
    if(!IMG_RE.test(en.name))continue;
    const f=await new Promise(r=>en.file(r));
    try{f.relPath=en.fullPath}catch(e){}
    out.push(f);
  }
  return {files:out,rootName:(entries[0]&&entries[0].fullPath||'').split('/')[1]||''};
}
let dragEl=null;
function initDrag(){
  const box=document.getElementById('thumbs');if(!box)return;
  box.querySelectorAll('.thumb').forEach(el=>{
    el.addEventListener('dragstart',e=>{dragEl=el;el.style.opacity='.4';e.dataTransfer.effectAllowed='move'});
    el.addEventListener('dragend',()=>{el.style.opacity='';reindex()});
    el.addEventListener('dragover',e=>{
      e.preventDefault();if(!dragEl||dragEl===el)return;
      const r=el.getBoundingClientRect();
      const after=(e.clientX-r.left)>r.width/2;
      box.insertBefore(dragEl,after?el.nextSibling:el);
    });
  });
}
function reindex(){document.querySelectorAll('#thumbs .thumb').forEach((el,i)=>{const b=el.querySelector('.badge');if(b)b.textContent=i+1})}
function saveOrder(slug){
  const order=[...document.querySelectorAll('#thumbs .thumb')].map(el=>el.dataset.img);
  toast('正在重排文件…');
  fetch('/reorder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug,order})})
    .then(r=>r.text()).then(t=>{toast(t,true);setTimeout(()=>location.reload(),1200)}).catch(e=>toast('失败：'+e,false));
}
function resetOrder(){location.reload()}
// ─────────── 裁剪器：封面(3:4) / 置顶 Banner(32:9) / 模特头像(1:1) 共用一套拖拽逻辑 ───────────
// 封面与 Banner 的图来自【本套图】，头像的图来自【该模特名下任意一套图】（先选图集再选图）
let CROP={mode:'cover',slug:'',model:'',img:'',ratio:3/4,ow:0,oh:0,x:0,y:0,w:0,h:0,dispW:0,dispH:0,list:[]};
const CROP_META={
  cover:{title:'✂ 裁剪封面',tip:'拖动选区移动 · 拖右下角调整大小 · 目标比例 3:4 · 输出 800×1067',save:'保存封面',url:'/cropcover'},
  banner:{title:'🖼 裁剪首页大图（置顶轮播）',tip:'建议挑横构图 · 输出 1600×450（32:9）· 只有置顶图集会显示在首页轮播 · 下半部分暗色区会被标题压住',save:'保存大图',url:'/cropbanner'},
  avatar:{title:'🙂 裁剪模特头像',tip:'挑一张脸清晰的正方形区域 · 输出 320×320 圆形展示',save:'保存头像',url:'/cropavatar'}
};
function cropImages(slug,cb){
  fetch('/setimages?slug='+encodeURIComponent(slug)).then(r=>r.json()).then(function(d){
    if(!d.images||!d.images.length){toast('这套图还没有图片',true);return}
    cb(d.images);
  }).catch(function(e){toast('读取图片列表失败：'+e,true)});
}
// 短暂提示：2.5 秒后自己消失（toast() 不带 ok 时不会自动消失，会让"读取中…"一直挂着）
function toastSpin(msg){
  toast(msg);
  const t=document.querySelector('.toast');
  if(t)setTimeout(function(){if(t.parentNode)t.remove()},2500);
}
function openCropper(slug){openCropFor(slug,'cover')}
function openBannerCropper(slug){openCropFor(slug,'banner')}
function openCropFor(slug,mode){
  toastSpin('读取图片列表…');
  cropImages(slug,function(list){
    CROP={mode:mode,slug:slug,model:'',img:list[0].img,ratio:(mode==='banner'?32/9:3/4),list:list,x:0,y:0,w:0,h:0,ow:0,oh:0,dispW:0,dispH:0};
    buildCropModal();
    fillCropSelect();
    setCropImage(list[0].img);
  });
}
function openAvatarCropper(model){
  const sets=(window.MODEL_SETS||{})[model]||[];
  if(!sets.length){toast('该模特名下还没有图集',false);return}
  CROP={mode:'avatar',slug:sets[0].slug,model:model,img:'',ratio:1,list:[],x:0,y:0,w:0,h:0,ow:0,oh:0,dispW:0,dispH:0};
  buildCropModal();
  const ss=document.getElementById('cropSet');
  sets.forEach(function(s){const o=document.createElement('option');o.value=s.slug;o.textContent=s.title+'（'+s.slug+'）';ss.appendChild(o)});
  ss.value=CROP.slug;
  ss.onchange=function(){CROP.slug=ss.value;loadCropImages()};
  loadCropImages();
}
function loadCropImages(){
  toastSpin('读取图片列表…');
  cropImages(CROP.slug,function(list){
    CROP.list=list;CROP.img=list[0].img;
    fillCropSelect();setCropImage(list[0].img);
  });
}
function fillCropSelect(){
  const sel=document.getElementById('cropImg');if(!sel)return;
  sel.innerHTML='';
  CROP.list.forEach(function(it){const o=document.createElement('option');o.value=it.img;o.textContent=it.img;sel.appendChild(o)});
  sel.value=CROP.img;
  sel.onchange=function(){setCropImage(sel.value)};
  const strip=document.getElementById('cropStrip');
  if(strip){
    strip.innerHTML='';
    CROP.list.forEach(function(it){
      const im=document.createElement('img');im.src=it.thumb;im.title=it.img;im.loading='lazy';
      im.onclick=function(){setCropImage(it.img)};
      strip.appendChild(im);
    });
  }
}
function markStrip(img){
  const strip=document.getElementById('cropStrip');if(!strip)return;
  [...strip.children].forEach(function(el){el.classList.toggle('on',el.title===img)});
}
function buildCropModal(){
  const old=document.getElementById('cropper');if(old)old.remove();
  const m=CROP_META[CROP.mode];
  const box=document.createElement('div');
  box.id='cropper';box.className='cropper';
  box.innerHTML=[
    '<div class="crop-head"><b>'+m.title+'</b>',
    CROP.mode==='avatar'?'<select id="cropSet" title="选择图集"></select>':'',
    '<select id="cropImg" title="选择图片"></select>',
    '<button class="btn sm" id="cropSave">'+m.save+'</button>',
    '<button class="btn ghost sm" id="cropReset" title="把选区恢复成默认大小（居中）">↺ 重置选区</button>',
    '<button class="btn ghost sm" id="cropCancel">取消</button>',
    '<span class="sub" id="cropTip">'+m.tip+'</span></div>',
    '<p class="crop-warn">拖好选区后<b>必须点「'+m.save+'」</b>才生效（直接关掉弹层＝放弃这次裁剪）· Enter 也能保存 / Esc 取消</p>',
    '<div class="crop-strip" id="cropStrip"></div>',
    '<div class="crop-stage" id="cropStage"><img id="cropImgEl" alt=""><div class="crop-box'+(CROP.mode==='avatar'?' round':'')+'" id="cropBox"></div>',
    CROP.mode==='banner'?'<div class="crop-safe"><span>标题文字区（会被压暗/遮住）</span></div>':'',
    '</div>',
    '<div class="crop-preview'+(CROP.mode==='banner'?' wide':'')+'" id="cropPreview" title="最终显示效果（所见即所得）">',
    '<div class="cp-inner"><img id="cropPvImg" alt=""></div>',
    CROP.mode==='banner'?'<span class="cp-overlay"><span class="cp-badge">📌 置顶推荐</span><b>标题 &amp; 信息会显示在这里</b></span>':'',
    '</div>',
    '<p class="sub" id="cropInfo" style="margin:8px 0 0"></p>'
  ].join('');
  document.body.appendChild(box);
  document.getElementById('cropCancel').onclick=function(){cancelCrop()};
  document.getElementById('cropSave').onclick=function(){saveCropNow()};
  const rb=document.getElementById('cropReset');
  if(rb)rb.onclick=function(){resetCropBox()};
  CROP.dirty=false;
  // 弹层开着且有改动时，页面要跳走/刷新（例如表单保存完成、手滑刷新）先拦一下，
  // 否则裁剪白做：编辑页点「保存」是整页 POST，响应回来时会把弹层一起刷掉
  window.onbeforeunload=function(e){
    const c=document.getElementById('cropper');
    if(c&&CROP.dirty){e.preventDefault();e.returnValue='';return ''}
  };
  document.onkeydown=function(e){
    const c=document.getElementById('cropper');if(!c)return;
    if(e.key==='Escape'){e.preventDefault();cancelCrop()}
    else if(e.key==='Enter'){e.preventDefault();saveCropNow()}
  };
}
function closeCropModal(){
  CROP.dirty=false;window.onbeforeunload=null;document.onkeydown=null;
  const c=document.getElementById('cropper');if(c)c.remove();
}
function cancelCrop(){
  if(CROP.dirty&&!confirm('放弃这次裁剪？（没点「保存」的话不会生效）'))return;
  closeCropModal();
}
function setCropImage(img){
  CROP.img=img;
  const sel=document.getElementById('cropImg');if(sel&&sel.value!==img)sel.value=img;
  markStrip(img);
  const it=CROP.list.filter(function(x){return x.img===img})[0]||{};
  CROP.ow=it.w||0;CROP.oh=it.h||0;
  const el=document.getElementById('cropImgEl');
  el.onload=function(){initCropBox()};
  el.src=it.thumb||('/preview/'+encodeURIComponent(CROP.slug)+'/images/'+encodeURIComponent(img));
  const pv=document.getElementById('cropPvImg');
  if(pv){
    pv.onload=function(){drawCropPreview()};
    pv.src=el.src;
  }
}
function cropScale(){
  // 屏幕显示像素 → 原图像素：必须用"显示宽度"，不是 <img> 的原始像素！
  // （预览图是 1280 长的缩略图，屏幕上只有 400~500px 宽；用 naturalWidth 会把选区缩小约 2.5~3 倍，
  //   表现就是"我框的是整幅，保存下来只有中间一小块"）
  return {
    sx:(CROP.ow&&CROP.dispW)?CROP.ow/CROP.dispW:1,
    sy:(CROP.oh&&CROP.dispH)?CROP.oh/CROP.dispH:1
  };
}
function initCropBox(){
  const el=document.getElementById('cropImgEl'),boxEl=document.getElementById('cropBox');
  CROP.dispW=el.clientWidth;CROP.dispH=el.clientHeight;
  if(CROP.mode==='avatar'){
    // 头像：默认框在"偏上一点"的位置（人像的脸大多在上半部），取宽度的 45%
    let w=Math.min(CROP.dispW*0.45,CROP.dispH*0.45),h=w;
    CROP.x=(CROP.dispW-w)/2;CROP.y=Math.min(CROP.dispH-h,Math.max(0,CROP.dispH*0.14));
    CROP.w=w;CROP.h=h;
  }else{
    // 封面 / Banner：默认居中、尽量大的选区（按目标比例）
    let w=CROP.dispW,h=w/CROP.ratio;
    if(h>CROP.dispH){h=CROP.dispH;w=h*CROP.ratio}
    CROP.x=(CROP.dispW-w)/2;CROP.y=(CROP.dispH-h)/2;CROP.w=w;CROP.h=h;
  }
  const draw=function(){
    boxEl.style.left=CROP.x+'px';boxEl.style.top=CROP.y+'px';
    boxEl.style.width=CROP.w+'px';boxEl.style.height=CROP.h+'px';
    const sc=cropScale();
    document.getElementById('cropInfo').textContent='选区（原图坐标）：'
      +Math.round(CROP.x*sc.sx)+', '+Math.round(CROP.y*sc.sy)+' · '
      +Math.round(CROP.w*sc.sx)+'×'+Math.round(CROP.h*sc.sy)+' px'
      +(CROP.ow?'（原图 '+CROP.ow+'×'+CROP.oh+'，占宽 '+Math.round(CROP.w*sc.sx/CROP.ow*100)+'%）':'');
    drawCropPreview();
  };
  draw();
  let mode=null,sx0=0,sy0=0,c0=null;
  const pt=function(e){const r=el.getBoundingClientRect();const t=e.touches?e.touches[0]:e;return{x:t.clientX-r.left,y:t.clientY-r.top}};
  const onDown=function(e,m){mode=m;const p=pt(e);sx0=p.x;sy0=p.y;c0=Object.assign({},CROP);e.preventDefault();e.stopPropagation()};
  const onMove=function(e){
    if(!mode)return;const p=pt(e);
    const dx=p.x-sx0,dy=p.y-sy0;
    if(Math.abs(dx)>1||Math.abs(dy)>1)CROP.dirty=true;
    if(mode==='move'){
      CROP.x=Math.max(0,Math.min(CROP.dispW-CROP.w,c0.x+dx));
      CROP.y=Math.max(0,Math.min(CROP.dispH-CROP.h,c0.y+dy));
    }else{
      let w=Math.max(40,c0.w+dx),h=w/CROP.ratio;
      if(c0.y+h>CROP.dispH){h=CROP.dispH-c0.y;w=h*CROP.ratio}
      if(w>CROP.dispW){w=CROP.dispW;h=w/CROP.ratio}
      CROP.w=w;CROP.h=h;
    }
    draw();e.preventDefault();
  };
  const onUp=function(){mode=null};
  boxEl.onmousedown=function(e){onDown(e,'move')};
  boxEl.ontouchstart=function(e){onDown(e,'move')};
  if(!boxEl.querySelector('.crop-grip')){
    const grip=document.createElement('div');grip.className='crop-grip';
    grip.onmousedown=function(e){onDown(e,'size')};grip.ontouchstart=function(e){onDown(e,'size')};
    boxEl.appendChild(grip);
  }
  el.onmousedown=function(e){onDown(e,'move')};
  document.addEventListener('mousemove',onMove);document.addEventListener('touchmove',onMove,{passive:false});
  document.addEventListener('mouseup',onUp);document.addEventListener('touchend',onUp);
}
function resetCropBox(){
  const el=document.getElementById('cropImgEl');
  if(el&&el.naturalWidth)initCropBox();
}
/** 选区实时预览：按"最终显示的框"裁出选区内容，所见即所得 */
function drawCropPreview(){
  const pv=document.getElementById('cropPreview');if(!pv)return;
  const img=pv.querySelector('img');if(!img)return;
  const isBanner=CROP.mode==='banner';
  const boxW=isBanner?Math.min(420,pv.clientWidth||420):160;
  const scale=boxW/Math.max(1,CROP.w);
  img.style.width=(CROP.dispW*scale)+'px';
  img.style.height=(CROP.dispH*scale)+'px';
  img.style.left=(-CROP.x*scale)+'px';
  img.style.top=(-CROP.y*scale)+'px';
  const inner=pv.querySelector('.cp-inner');
  inner.style.height=(CROP.h*scale)+'px';
}
function saveCropNow(){
  const sc=cropScale();
  const payload={slug:CROP.slug,img:CROP.img,
    x:Math.round(CROP.x*sc.sx),y:Math.round(CROP.y*sc.sy),
    w:Math.round(CROP.w*sc.sx),h:Math.round(CROP.h*sc.sy)};
  if(CROP.mode==='avatar')payload.model=CROP.model;
  const btn=document.getElementById('cropSave');
  if(btn){btn.disabled=true;btn.textContent='保存中…'}
  toast('正在生成并重建（约 6 秒）…');
  fetch(CROP_META[CROP.mode].url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){return r.text().then(function(t){return {ok:r.ok,t:t}})})
    .then(function(res){
      if(!res.ok){
        // 失败就别关弹层：选区还在，改完能重试（原来无论成败都关掉+刷新，看着像"没保存就退出来了"）
        toast('保存失败：'+res.t,false);
        if(btn){btn.disabled=false;btn.textContent=CROP_META[CROP.mode].save}
        return;
      }
      toast(res.t,true);
      CROP.dirty=false;window.onbeforeunload=null;
      const c=document.getElementById('cropper');if(c)c.remove();
      setTimeout(function(){location.reload()},1400);
    })
    .catch(function(e){
      toast('失败：'+e,false);
      if(btn){btn.disabled=false;btn.textContent=CROP_META[CROP.mode].save}
    });
}
function clearAvatar(model){
  if(!confirm('清除「'+model+'」的自定义头像？（退回用最新一套的封面）'))return;
  toast('处理中…');
  fetch('/clearavatar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:model})})
    .then(function(r){return r.text()}).then(function(t){toast(t,true);setTimeout(function(){location.reload()},1400)})
    .catch(function(e){toast('失败：'+e,false)});
}
function clearBanner(slug){
  if(!confirm('清除这套图的自定义 Banner？（首页轮播退回用封面）'))return;
  toast('处理中…');
  fetch('/clearbanner',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:slug})})
    .then(function(r){return r.text()}).then(function(t){toast(t,true);setTimeout(function(){location.reload()},1400)})
    .catch(function(e){toast('失败：'+e,false)});
}
// ── 隐藏套图：快速开关 + 全局密码 ──
function togglePwView(){
  const i=document.getElementById('hidPw'),b=document.getElementById('pwEye');
  if(!i)return;
  const masked=i.type==='password';
  i.type=masked?'text':'password';
  if(b)b.textContent=masked?'👁 遮住':'👁 显示';
}
function copyText(t,label){
  if(!t){toast('没有可复制的内容',false);return}
  const done=function(){toast('已复制'+label+'：'+t,true)};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done).catch(function(){fallbackCopy(t,done)})}
  else fallbackCopy(t,done);
}
function fallbackCopy(t,done){
  const ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';
  document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');done()}catch(e){toast('复制失败，请手动选中复制',false)}
  ta.remove();
}
function toggleHidden(slug,on){
  if(on&&!confirm('隐藏这套图？列表里只会显示模糊封面，点不进去；要输密码才能查看。'))return;
  toast('处理中…');
  fetch('/sethidden',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:slug,hidden:!!on})})
    .then(function(r){return r.text()}).then(function(t){toast(t,true);setTimeout(function(){location.reload()},1400)})
    .catch(function(e){toast('失败：'+e,false)});
}
function saveHiddenCfg(){
  const pw=document.getElementById('hidPw').value.trim(),hint=document.getElementById('hidHint').value.trim();
  if(!pw&&!confirm('密码留空＝关闭隐藏功能（已隐藏的套图会重新变成公开）。继续？'))return;
  toast('保存并重建中…');
  fetch('/hidden',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw,hint:hint})})
    .then(function(r){return r.text()}).then(function(t){toast(t,true);setTimeout(function(){location.reload()},1600)})
    .catch(function(e){toast('失败：'+e,false)});
}
"""


def page(title, body, extra_js=''):
    return f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title>
<style>{CSS}</style></head><body><div class="wrap">{body}</div>
<script>{JS}{extra_js}</script></body></html>"""


def filter_sort_sets(sets, q='', sort='date-desc'):
    """后台图集列表的服务端筛选与排序（数量上千也不会卡）"""
    q = (q or '').strip().lower()
    if q:
        parts = [p for p in q.split() if p]
        def hit(s):
            m = s['meta']
            hay = ' '.join([str(m.get('title') or ''), s['slug'], str(m.get('model') or ''),
                            str(m.get('series') or ''), ' '.join(m.get('tags') or []), str(m.get('date') or '')]).lower()
            return all(p in hay for p in parts)
        sets = [s for s in sets if hit(s)]
    if sort == 'date-asc':
        sets = sorted(sets, key=lambda s: str(s['meta'].get('date') or ''))
    elif sort == 'title-asc':
        sets = sorted(sets, key=lambda s: str(s['meta'].get('title') or s['slug']))
    elif sort == 'count-desc':
        sets = sorted(sets, key=lambda s: -int(s['count'] or 0))
    elif sort == 'size-desc':
        sets = sorted(sets, key=lambda s: -set_dir_size(os.path.join(SETS_DIR, s['slug'])))
    else:
        sets = sorted(sets, key=lambda s: str(s['meta'].get('date') or ''), reverse=True)
    return sets


_dir_size_cache = {}


def set_dir_size(d):
    """原图总字节数。按目录 mtime 缓存：图集多时（按体积排序要算全部套）不会每次都遍历图片"""
    p = os.path.join(d, 'images')
    if not os.path.isdir(p):
        return 0
    try:
        st = os.stat(p)
    except OSError:
        return 0
    key = (st.st_mtime, st.st_size)
    hit = _dir_size_cache.get(p)
    if hit and hit[0] == key:
        return hit[1]
    n = 0
    try:
        for f in os.listdir(p):
            fp = os.path.join(p, f)
            if os.path.isfile(fp):
                n += os.path.getsize(fp)
    except OSError:
        return 0
    _dir_size_cache[p] = (key, n)
    return n


def pager_html(page, total_pages, base_qs):
    """后台分页（和前台同一套 Bootstrap 分页规范）"""
    if total_pages <= 1:
        return ''
    W = 2
    nums = {1, total_pages}
    for p in range(page - W, page + W + 1):
        if 1 <= p <= total_pages:
            nums.add(p)
    arr = sorted(nums)
    it = lambda inner, cls='': f'<li class="page-item{" " + cls if cls else ""}">{inner}</li>'
    lk = lambda p, label: it(f'<a class="page-link" href="?{base_qs}&amp;page={p}">{label}</a>')
    dead = lambda label: it(f'<span class="page-link">{label}</span>', 'disabled')
    out = [lk(1, '« 首页') if page > 1 else dead('« 首页'),
           lk(page - 1, '‹ 上一页') if page > 1 else dead('‹ 上一页')]
    prev = 0
    for p in arr:
        if prev and p - prev > 1:
            out.append(it('<span class="page-link">…</span>', 'disabled'))
        out.append(it(f'<span class="page-link" aria-current="page">{p}</span>', 'active') if p == page else lk(p, str(p)))
        prev = p
    out.append(lk(page + 1, '下一页 ›') if page < total_pages else dead('下一页 ›'))
    out.append(lk(total_pages, '末页 »') if page < total_pages else dead('末页 »'))
    return (f'<nav class="pagination-wrap" aria-label="分页导航"><ul class="pagination">{"".join(out)}</ul>'
            f'<p class="pagination-info">第 {page} / {total_pages} 页</p></nav>')


def sets_cards(sets, view='card'):
    cards = []
    for s in sets:
        m = s['meta']
        img = f'<img src="{s["coverUrl"]}" alt="" loading="lazy">' if s['coverUrl'] else '<div style="aspect-ratio:3/4;background:#111"></div>'
        title = (m.get('title') or s['slug'])
        size = fmt_size(set_dir_size(os.path.join(SETS_DIR, s['slug'])))
        search = f"{title} {s['slug']} {m.get('model') or ''} {' '.join(m.get('tags') or [])}".lower()
        pin_badge = (f'<span class="pinbadge" title="置顶第 {m.get("pinOrder") or "-"} 位'
                     + (f'，到 {m["pinUntil"]} 失效' if m.get('pinUntil') else '') + '">📌'
                     + (str(m.get('pinOrder')) if m.get('pinOrder') else '') + '</span>') if m.get('pinned') else ''
        cards.append(f"""<div class="set" data-slug="{s['slug']}" data-search="{esc_attr(search)}"
             onclick="location.href='/edit?slug={quote(s['slug'])}'" title="点击编辑这套图集">
          <input type="checkbox" class="pick" data-slug="{s['slug']}" onclick="event.stopPropagation();togglePick(this)" title="选择用于批量操作">{pin_badge}{img}<div class="body">
          <div class="t">{title}</div>
          <div class="m">{m.get('date','')} · {s['count']}P{(' · ' + size) if size else ''}{' · 含压缩包' if s['hasPack'] else ''}{(' · ' + str(m.get('model'))) if m.get('model') else ''}</div>
          <div class="acts">
            <a class="mini" href="/edit?slug={quote(s['slug'])}" onclick="event.stopPropagation()">编辑</a>
            <a class="mini" href="http://127.0.0.1:8090/set/{quote(s['slug'])}/index.html" target="_blank" onclick="event.stopPropagation()">预览</a>
            <button class="mini" onclick="event.stopPropagation();togglePin('{s['slug']}',{0 if m.get('pinned') else 1})"
                    title="置顶后出现在首页顶部推荐轮播">{"取消置顶" if m.get("pinned") else "📌 置顶"}</button>
            <button class="mini" data-slug="{esc_attr(s['slug'])}" onclick="event.stopPropagation();openBannerCropper(this.dataset.slug)"
                    title="从本套图里选一张裁成首页轮播大图（1600×450）；只有置顶图集才会出现在首页轮播">🖼 大图</button>
            <button class="mini" data-slug="{esc_attr(s['slug'])}" onclick="event.stopPropagation();openCropper(this.dataset.slug)"
                    title="从本套图里选一张裁封面（3:4，列表卡片用）">✂ 封面</button>
            <button class="mini" data-slug="{esc_attr(s['slug'])}" onclick="event.stopPropagation();toggleHidden(this.dataset.slug,{0 if m.get('hidden') else 1})"
                    title="隐藏后列表只显示模糊封面、点不进去，需密码查看">{"🔓 取消隐藏" if m.get("hidden") else "🔒 隐藏"}</button>
            <button class="mini" onclick="event.stopPropagation();del('{s['slug']}')">删除</button>
          </div></div></div>""")
    return ''.join(cards) or '<p class="sub">没有匹配的图集</p>'


def fmt_size(n):
    if not n:
        return ''
    gb = n / 1073741824
    return f'{gb:.2f}GB' if gb >= 1 else f'{n / 1048576:.0f}MB'


def links_page(msg=''):
    """网盘链接批量导入页：粘贴 → 自动匹配图集 → 预览 → 应用"""
    sets = list_sets()
    samples = '\n'.join([
        'NO.001 | 天翼云盘 | https://cloud.189.cn/t/xxxxxxxx | 8a2k',
        'NO.002 | 天翼云盘 | https://cloud.189.cn/t/yyyyyyyy',
        'OL制服 | 百度网盘 | https://pan.baidu.com/s/1abcdef | 1234',
    ])
    return page('批量导入网盘链接', f"""
<a class="btn ghost sm" href="/">← 返回后台</a>
<form class="panel" id="lk">
  <h2>网盘链接批量导入（{len(sets)} 套图集）</h2>
  <p class="sub">每行一套，用 <code>|</code> 分隔（也支持逗号或制表符）：<br>
    <code>关键词 | 网盘名(可省) | 链接 | 提取码(可省)</code><br>
    「关键词」会去匹配图集的标题/目录名，支持 <code>NO.001</code> 这种编号，也支持中文片段。</p>
  <div class="row">
    <label style="margin:0">默认网盘名</label>
    <input type="text" id="dft" value="天翼云盘" style="max-width:200px">
    <label style="margin:0"><input type="checkbox" id="onlyEmpty" checked> 只覆盖尚未填链接的图集</label>
  </div>
  <textarea id="txt" rows="12" placeholder="{samples}" style="width:100%;background:var(--panel2);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:12px;font-family:ui-monospace,Consolas,monospace;font-size:13px"></textarea>
  <div class="row">
    <button type="button" class="btn ghost" onclick="lkRun(false)">① 预览匹配结果</button>
    <button type="button" class="btn" onclick="lkRun(true)">② 确认并应用</button>
    <span class="sub" id="lkMsg" style="margin:0"></span>
  </div>
  <div id="lkOut"></div>
</form>""", extra_js="""
function lkRun(apply){
  const txt=document.getElementById('txt').value.trim();
  if(!txt){toast('请先粘贴内容',false);return}
  const msg=document.getElementById('lkMsg');msg.textContent=apply?'应用中…':'匹配中…';
  fetch('/links',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:txt,defaultNetdisk:document.getElementById('dft').value,onlyEmpty:document.getElementById('onlyEmpty').checked,apply:apply})})
  .then(r=>r.json()).then(d=>{
    msg.textContent=d.summary||'';
    const rows=d.rows.map(r=>'<tr class="'+(r.status==='ok'?'':'bad')+'"><td>'+r.keyword+'</td><td>'+(r.title||'—')+'</td><td>'+(r.netdisk||'—')+'</td><td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(r.url||'—')+'</td><td>'+(r.code||'—')+'</td><td>'+r.msg+'</td></tr>').join('');
    document.getElementById('lkOut').innerHTML='<table class="lk"><thead><tr><th>关键词</th><th>匹配到的图集</th><th>网盘</th><th>链接</th><th>提取码</th><th>状态</th></tr></thead><tbody>'+rows+'</tbody></table>';
    if(apply&&d.applied){toast('已应用 '+d.applied+' 套，正在重建站点…',true)}
  }).catch(e=>{msg.textContent='失败：'+e});
}
""")


def parse_link_lines(text, default_netdisk=''):
    """把粘贴的文本解析成 [{keyword, netdisk, url, code}]

    支持写法（分隔符可用 | 、制表符、逗号）：
        关键词 | 网盘名 | 链接 | 提取码
        关键词 | 链接 | 提取码
        关键词 | 链接            （网盘名用默认值）
    也支持把提取码写在链接里：?pwd=8a2k，或「提取码: 8a2k / 密码：1234」
    """
    out = []
    for raw in (text or '').splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        parts = [p.strip() for p in re.split(r'\s*[|\t]\s*|\s*,\s*', line) if p.strip() != '']
        if len(parts) < 2:
            continue
        kw = parts[0]
        rest = parts[1:]
        url_i = next((i for i, p in enumerate(rest) if 'http' in p), -1)
        url = rest[url_i] if url_i >= 0 else ''
        before = rest[:url_i] if url_i >= 0 else rest[:-1]
        after = rest[url_i + 1:] if url_i >= 0 else rest[-1:]
        netdisk = before[0] if before else default_netdisk
        code = after[0] if after else ''
        # 兜底一：链接里带 ?pwd=xxxx
        m = re.search(r'[?&](?:pwd|password|passcode)=([0-9a-zA-Z]{2,10})', url)
        if m and not code:
            code = m.group(1)
        # 兜底二：任意位置写了「提取码/密码: xxxx」
        if not code:
            m = re.search(r'(?:提取码|访问码|密码|pwd|code)\s*[:：=]?\s*([0-9a-zA-Z]{2,10})', line, re.I)
            if m:
                code = m.group(1)
        # 兜底三：没识别到链接时，把最后一段当链接
        if not url:
            url = rest[-1]
        # 链接字段里夹了说明文字时，抽出真正的网址
        m = re.search(r'https?://[^\s|]+', url)
        if m:
            url = m.group(0).rstrip('，。.,;；、')
        out.append({'keyword': kw, 'netdisk': netdisk, 'url': url, 'code': code})
    return out


def match_set(keyword, sets):
    """按关键词找图集：目录名精确 > 标题/目录名/模特/系列包含 > 用模特·系列消歧 > 编号匹配

    同名作品（不同模特或不同系列）很多时，允许写成「标题 模特」或「标题/系列」来精确指定。
    """
    kw = (keyword or '').strip().lower()
    if not kw:
        return None, 'empty'
    for s in sets:
        if s['slug'].lower() == kw:
            return s, 'exact'

    def hay(s):
        m = s['meta']
        return ' '.join([str(m.get('title') or ''), s['slug'], str(m.get('model') or ''),
                         str(m.get('series') or '')]).lower()

    tokens = [t for t in re.split(r'[\s,，/|、]+', kw) if t]
    hits = [s for s in sets if all(t in hay(s) for t in tokens)] if len(tokens) > 1 \
        else [s for s in sets if kw in hay(s)]
    if len(hits) == 1:
        return hits[0], 'ok'
    if len(hits) > 1:
        # ① 模特名 / 系列名正好等于某个词 → 用它消歧（例：「油菜花 措措」）
        dis = [s for s in hits
               if str(s['meta'].get('model') or '').strip().lower() in tokens
               or str(s['meta'].get('series') or '').strip().lower() in tokens]
        if len(dis) == 1:
            return dis[0], 'ok'
        if len(dis) > 1:
            hits = dis
        # ② 优先「编号完全相同」的那个（NO.001 / no-001 / 001）
        num = re.search(r'\d+', kw)
        if num:
            n = int(num.group())
            same = [s for s in hits
                    if re.search(r'no[.\-_ ]?0*%d(?:\D|$)' % n, s['slug'].lower())
                    or re.search(r'no[.\-_ ]?0*%d(?:\D|$)' % n, (s['meta'].get('title') or '').lower())]
            if len(same) == 1:
                return same[0], 'ok'
        _names = '、'.join(f'{s["slug"]}'
                          + (f'（{s["meta"].get("model") or s["meta"].get("series")}）'
                             if (s['meta'].get('model') or s['meta'].get('series')) else '')
                          for s in hits[:4])
        return None, f'匹配到 {len(hits)} 套：{_names} —— 请写更精确的关键词（可加模特名或系列名）'
    return None, '没找到匹配的图集'


# ───────────── 批量重命名（标题清洗 + 可选的目录改名）─────────────
def apply_title_rules(title, rules=None):
    """按规则算出一个新标题（只算不写，供预览）。

    规则（都可选，按顺序应用）：
      no    去掉开头的 NO 编号（NO.012 / no-12 / NO 12）
      num   去掉开头的纯数字编号（01 / 第 03 期 / 2024-01）
      tail  去掉结尾的 [28P-447MB]、【…】、（…）（可连续去掉多个）
      find/re 查找替换（re=true 时按正则）
      prefix/suffix  加前缀 / 后缀
      space 合并多余空格并去首尾（默认开）
    """
    rules = rules or {}
    t = str(title or '')
    if rules.get('no'):
        t = re.sub(r'^\s*(?:no|No|NO|ＮＯ)\s*[.\-_、]?\s*\d{1,4}\s*', '', t)
    if rules.get('num'):
        t = re.sub(r'^\s*(?:第\s*)?\d{1,4}\s*(?:期|[.\-_、])?\s*', '', t)
    if rules.get('tail'):
        for _ in range(4):
            new = re.sub(r'\s*[\[【（(][^\]】）)]*[\]】）)]\s*$', '', t)
            if new == t:
                break
            t = new
    if rules.get('find'):
        if rules.get('re'):
            try:
                t = re.sub(rules['find'], rules.get('rep', ''), t)
            except re.error:
                pass
        else:
            t = t.replace(rules['find'], rules.get('rep', ''))
    if rules.get('prefix'):
        t = rules['prefix'] + t
    if rules.get('suffix'):
        t = t + rules['suffix']
    if rules.get('space', True):
        t = re.sub(r'[ \t\u3000]{2,}', ' ', t).strip()
    return t.strip()


def batch_rename(items, rename_dirs=False):
    """按预览结果批量改标题（items: [{slug, title}]）；rename_dirs=True 时连目录一起改名。

    返回 (改了几套, [跳过原因], [目录改名记录], [新的 slug 映射])
    """
    changed, skipped, moves, slugmap = 0, [], [], []
    for it in (items or []):
        slug = str(it.get('slug') or '').strip()
        new = str(it.get('title') or '').strip()
        d = os.path.join(SETS_DIR, slug)
        if not slug or not os.path.isdir(d):
            skipped.append(f'{slug or "(空)"}: 图集不存在')
            continue
        if not new:
            skipped.append(f'{slug}: 新标题是空的，已跳过')
            continue
        meta = read_meta(d)
        old = str(meta.get('title') or '').strip()
        meta['title'] = new
        meta.pop('displayTitle', None)     # 清掉缓存的展示标题，列表按新标题重建
        save_meta(d, meta)
        if new != old:
            changed += 1
        if rename_dirs:
            want = f'{meta.get("date") or date.today().isoformat()}-{slugify(new)}'
            new_slug = unique_slug(want, meta.get('model'), meta.get('series'))
            if new_slug != slug:
                try:
                    os.rename(d, os.path.join(SETS_DIR, new_slug))
                    moves.append(f'{slug} → {new_slug}')
                    slugmap.append((slug, new_slug))
                    slug = new_slug
                except Exception as e:  # noqa
                    skipped.append(f'{slug}: 目录改名失败（{e}）')
    return changed, skipped, moves, slugmap


def rename_page(msg=''):
    """批量重命名页：选范围 → 选规则 → 预览（可直接改）→ 应用"""
    sets = list_sets()
    models = sorted({(s['meta'].get('model') or '').strip() for s in sets if (s['meta'].get('model') or '').strip()})
    series = sorted({(s['meta'].get('series') or '').strip() for s in sets if (s['meta'].get('series') or '').strip()})
    data = [{'slug': s['slug'], 'title': s['meta'].get('title') or s['slug'],
             'model': (s['meta'].get('model') or '').strip(), 'series': (s['meta'].get('series') or '').strip(),
             'hidden': bool(s['meta'].get('hidden'))} for s in sets]
    return page('批量重命名', f"""
<a class="btn ghost sm" href="/">← 返回后台</a>
<div class="panel">
  <h2>✏️ 批量重命名（标题清洗）</h2>
  <p class="sub">选范围 → 勾规则 → 点「预览」→ 表格里可以直接改 → 点「应用」。<br>
    只改<b>标题</b>（站点上显示的文字）；目录名默认不动，所以隐藏套图的分享链接不会失效。</p>
  <div class="grid2" style="margin-top:10px">
    <div>
      <label>处理范围</label>
      <select id="rScope" onchange="scopeChanged()">
        <option value="picked">首页勾选的图集</option>
        <option value="model">某个模特的全部作品</option>
        <option value="series">某个系列的全部作品</option>
        <option value="all">全部图集（{len(data)} 套）</option>
      </select>
      <select id="rModel" hidden>{''.join(f'<option value="{esc_attr(m)}">{esc_attr(m)}</option>' for m in models)}</select>
      <select id="rSeries" hidden>{''.join(f'<option value="{esc_attr(x)}">{esc_attr(x)}</option>' for x in series)}</select>
      <span class="sub" id="rCount" style="margin-left:8px"></span>
    </div>
    <div>
      <label>规则（按顺序应用）</label>
      <label style="display:block"><input type="checkbox" id="rNo" checked style="width:auto"> 去掉开头的 NO 编号（NO.012 / no-12）</label>
      <label style="display:block"><input type="checkbox" id="rNum" style="width:auto"> 去掉开头的纯数字编号（01 / 第 03 期）</label>
      <label style="display:block"><input type="checkbox" id="rTail" checked style="width:auto"> 去掉结尾的 [28P-447MB]、【…】、（…）</label>
      <label style="display:block"><input type="checkbox" id="rSpace" checked style="width:auto"> 合并多余空格、去首尾空格</label>
    </div>
    <div>
      <label>查找替换（可选）</label>
      <input type="text" id="rFind" placeholder="要替换的文字" style="max-width:200px">
      <span class="dim">→</span>
      <input type="text" id="rRep" placeholder="替换成（可留空＝删掉）" style="max-width:200px">
      <label style="display:inline-flex;align-items:center;gap:6px;margin-left:6px">
        <input type="checkbox" id="rRe" style="width:auto"> 正则
      </label>
    </div>
    <div>
      <label>加前缀 / 后缀（可选）</label>
      <input type="text" id="rPre" placeholder="前缀" style="max-width:140px">
      <input type="text" id="rSuf" placeholder="后缀" style="max-width:140px">
    </div>
  </div>
  <div class="row" style="margin-top:12px">
    <label style="display:flex;align-items:center;gap:8px;margin:0">
      <input type="checkbox" id="rDir" style="width:auto"> 同时把目录名改成「日期-新标题」
      <span class="sub" style="margin:0">（⚠️ URL 会变：隐藏套图的分享链接会失效，需要重新复制）</span>
    </label>
  </div>
  <div class="row" style="margin-top:12px">
    <button class="btn" onclick="renamePreview()">① 预览新标题</button>
    <button class="btn ghost" onclick="renameApply()">② 应用</button>
    <span class="sub" id="rState" style="margin:0"></span>
  </div>
  {f'<p class="sub" style="margin-top:8px">{esc(msg)}</p>' if msg else ''}
</div>
<div id="rTable"></div>
<script>window.ALL_SETS={json.dumps(data, ensure_ascii=False)};</script>
""", extra_js="""
function scopeSets(){
  const scope=document.getElementById('rScope').value;
  const all=window.ALL_SETS||[];
  if(scope==='all')return all;
  if(scope==='model'){const m=document.getElementById('rModel').value;return all.filter(s=>s.model===m)}
  if(scope==='series'){const x=document.getElementById('rSeries').value;return all.filter(s=>s.series===x)}
  const st=pickedStore();
  return all.filter(s=>st.has(s.slug));
}
function scopeChanged(){
  const scope=document.getElementById('rScope').value;
  document.getElementById('rModel').hidden = scope!=='model';
  document.getElementById('rSeries').hidden = scope!=='series';
  const n=scopeSets().length;
  const el=document.getElementById('rCount');
  el.textContent = scope==='picked' ? ('已勾选 '+n+' 套'+(n?'':'（去首页勾选，或换成本页其它范围）')) : ('共 '+n+' 套');
}
document.getElementById('rModel').onchange=scopeChanged;
document.getElementById('rSeries').onchange=scopeChanged;
window.addEventListener('DOMContentLoaded',scopeChanged);
function renameRules(){
  return {
    no:document.getElementById('rNo').checked, num:document.getElementById('rNum').checked,
    tail:document.getElementById('rTail').checked, space:document.getElementById('rSpace').checked,
    find:document.getElementById('rFind').value, rep:document.getElementById('rRep').value,
    re:document.getElementById('rRe').checked,
    prefix:document.getElementById('rPre').value, suffix:document.getElementById('rSuf').value
  };
}
function renamePreview(){
  const slugs=scopeSets().map(s=>s.slug);
  if(!slugs.length){toast('这个范围里没有图集',false);return}
  document.getElementById('rState').textContent='正在算…';
  fetch('/rename-preview',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({slugs:slugs,rules:renameRules()})})
    .then(r=>r.json()).then(d=>{
      const rows=(d.rows||[]).map(function(r){
        const chg=r.new!==r.old;
        return '<tr'+(chg?'':' class="dim"')+'><td><code>'+escHtml(r.slug)+'</code>'+(r.hidden?' 🔒':'')+'</td>'
          +'<td>'+escHtml(r.old)+'</td>'
          +'<td><input type="text" data-slug="'+escHtml(r.slug)+'" value="'+escHtml(r.new)+'" style="min-width:280px"></td></tr>';
      }).join('');
      const changed=(d.rows||[]).filter(r=>r.new!==r.old).length;
      document.getElementById('rTable').innerHTML =
        '<div class="panel"><h2>预览（'+changed+' / '+(d.rows||[]).length+' 套会被改）</h2>'
        +'<p class="sub">表格里可以直接手改；不想要的把它改回原样即可。改完点上面的「② 应用」。</p>'
        +'<table class="tagtable"><tr><th>目录</th><th>现在的标题</th><th>改成</th></tr>'+rows+'</table></div>';
      document.getElementById('rState').textContent='预览完成，确认后点「② 应用」';
      document.getElementById('rTable').scrollIntoView({behavior:'smooth',block:'start'});
    })
    .catch(e=>{document.getElementById('rState').textContent='预览失败：'+e;toast('预览失败：'+e,false)});
}
function escHtml(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function renameApply(){
  const inputs=[...document.querySelectorAll('#rTable input[data-slug]')];
  if(!inputs.length){toast('先点「① 预览新标题」',false);return}
  const items=inputs.map(i=>({slug:i.dataset.slug,title:i.value.trim()}));
  const changed=items.filter(i=>i.title).length;
  const dirs=document.getElementById('rDir').checked;
  if(!confirm('应用 '+changed+' 套的新标题'+(dirs?'，并同时改目录名（URL 会变）':'')+'？'))return;
  document.getElementById('rState').textContent='正在应用并重建…';
  fetch('/rename-apply',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({items:items,renameDirs:dirs})})
    .then(r=>r.text()).then(t=>{toast(t,true);setTimeout(()=>location.reload(),1800)})
    .catch(e=>{document.getElementById('rState').textContent='失败：'+e;toast('失败：'+e,false)});
}
""")

def batch_page():
    """批量导入多个文件夹：每个子文件夹 = 一套图集，标题默认用文件夹名"""
    return page('批量导入文件夹', f"""
<a class="btn ghost sm" href="/">← 返回后台</a>
<div class="panel">
  <h2>批量导入多个文件夹</h2>
  <p class="sub">
    <b>按模特 / 系列批量导入</b>：每次导入先填这次的<b>模特</b>或<b>系列</b>（会套用到本批全部图集），
    再选中该模特（或系列）目录 —— 里面每个子文件夹自动成为一套图集。<br>
    标题默认取文件夹名（填了模特会自动把文件夹名开头的模特名去掉），生成后可在列表里逐个手动编辑。
  </p>
  <div class="imp">
    <div class="imp-title">本次导入</div>
    <div class="grid2">
      <div><label>模特 <span class="hint" id="bModelHint">（从文件夹自动识别，可改）</span></label>
        <input type="text" id="bModel" placeholder="例：许岚 —— 本批全部图集都用它"></div>
      <div><label>系列 <span class="hint">（可空）</span></label>
        <input type="text" id="bSeries" placeholder="例：YITUYU艺图语"></div>
      <div><label>标签（逗号分隔，可空）</label><input type="text" id="bTags" placeholder="例：制服,黑丝"></div>
      <div><label>日期</label><input type="date" id="bDate" value="{date.today().isoformat()}"></div>
      <div><label>每套图集位于第几层</label>
        <select id="bDepth">
          <option value="0" selected>自动（推荐）</option>
          <option value="1">指定第 1 层（选中「许岚」，下面直接是各套图）</option>
          <option value="2">指定第 2 层（选中「天翼云盘(crypt)」，许岚/NO.001 这样）</option>
          <option value="3">指定第 3 层</option>
        </select></div>
    </div>
  </div>
  <div class="row">
    <label style="margin:0"><input type="checkbox" id="bAutoTag"> 同时 AI 打标（很慢：每套 10-30 秒，建议导入后统一跑「批量自动打标」）</label>
  </div>
  <div class="drop" id="bdrop">
    <div><strong>拖拽多个文件夹到这里</strong> 或 <strong>点击选择父文件夹</strong></div>
    <div style="font-size:12px;margin-top:6px">自动按文件名排序 · 非图片自动忽略 · 单张缩略图长边 {PREVIEW_LONG}px</div>
    <input type="file" id="bfolder" webkitdirectory directory multiple hidden>
  </div>
  <div id="bList"></div>
  <div class="row">
    <button class="btn" id="bStart" disabled>开始导入</button>
    <span class="sub" id="bMsg" style="margin:0"></span>
  </div>
  <div class="progress" id="bWrap" hidden><div class="bar" id="bBar"></div></div>
  <div id="bLog" class="sub" style="margin-top:12px;max-height:260px;overflow:auto;font-family:ui-monospace,Consolas,monospace"></div>
</div>""", extra_js="""
const bdrop=document.getElementById('bdrop'),bfolder=document.getElementById('bfolder');
const IMGRE2=/\\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;
let groups=[];   // [{name, files:[File]}]
let lastFiles=[]; // 最近一次选中的全部文件（改层级/模特时重新分组用）
bdrop.onclick=()=>bfolder.click();
bdrop.ondragover=e=>{e.preventDefault();bdrop.classList.add('on')};
bdrop.ondragleave=()=>bdrop.classList.remove('on');
bdrop.ondrop=async e=>{
  e.preventDefault();bdrop.classList.remove('on');
  const items=[...(e.dataTransfer.items||[])].map(i=>i.webkitGetAsEntry&&i.webkitGetAsEntry()).filter(Boolean);
  if(!items.length){lastFiles=[...e.dataTransfer.files];setGroups(buildGroups(lastFiles));return}
  toast('正在读取文件夹…');
  const entries=[];
  for(const en of items)await walkEntry(en,entries);
  const files=[];
  for(const en of entries){
    if(!IMGRE2.test(en.name))continue;
    const f=await new Promise(r=>en.file(r));
    try{Object.defineProperty(f,'webkitRelativePath',{value:(en.fullPath||'').replace(/^\\//,'')})}catch(err){}
    files.push(f);
  }
  lastFiles=files;syncModel(parseInt(document.getElementById('bDepth').value,10));setGroups(buildGroups(files));
};
bfolder.onchange=()=>{lastFiles=[...bfolder.files];syncModel(parseInt(document.getElementById('bDepth').value,10));setGroups(buildGroups(lastFiles))};
// ── 分组：定位「图集目录」在相对路径里的下标 ──
// 路径有两种形态：选父文件夹 = [根, 图集, 文件…]；拖入图集目录 = [图集, 文件…]
// 自动模式：段数 >= 3 取第 1 段（图集），否则取第 0 段（拖进来的就是图集目录）
function setIndexOf(rel,depth){
  if(depth>0)return Math.min(depth,rel.length-1);
  return rel.length>=3?1:0;
}
function buildGroups(files){
  const depth=parseInt(document.getElementById('bDepth').value||'0',10);
  const map=new Map();
  files.filter(f=>IMGRE2.test(f.name)).forEach(f=>{
    const rel=(f.webkitRelativePath||f.name).split('/');
    const si=setIndexOf(rel,depth);
    const parts=rel.slice(1,si+1);
    const key=(parts.length?parts.join(' / '):rel[si])||'(未命名)';
    if(!map.has(key))map.set(key,[]);
    map.get(key).push(f);
  });
  return [...map.entries()].map(([name,fs])=>{
    fs.sort((a,b)=>(a.webkitRelativePath||a.name).localeCompare(b.webkitRelativePath||b.name,'zh',{numeric:true}));
    // 标题取路径最后一段（即图集目录名），多层时不要带上中间路径
    const seg=name.split(' / ');
    return {name,title:seg[seg.length-1],files:fs};
  }).sort((a,b)=>a.name.localeCompare(b.name,'zh',{numeric:true}));
}
function titleOf(g){
  const model=(document.getElementById('bModel').value||'').trim();
  let t=(g&&g.title)||(typeof g==='string'?g:'');
  if(model&&t.startsWith(model))t=t.slice(model.length).trim();
  return t||((g&&g.title)||g||'');
}
function setGroups(g){
  groups=g;
  const model=(document.getElementById('bModel').value||'').trim();
  document.getElementById('bList').innerHTML=groups.length?('<table class="lk"><thead><tr><th>#</th><th>来源文件夹</th><th>图片数</th><th>体积</th><th>将作为标题</th></tr></thead><tbody>'+
    groups.map((x,i)=>'<tr><td>'+(i+1)+'</td><td>'+x.name+'</td><td>'+x.files.length+'</td><td>'+(x.files.reduce((s,f)=>s+f.size,0)/1048576).toFixed(1)+' MB</td><td><b>'+titleOf(x)+'</b></td></tr>').join('')+
    '</tbody></table>'):'<p class="sub">还没选到文件夹（选中的目录里没有图片）</p>';
  const btn=document.getElementById('bStart');
  btn.disabled=!groups.length;
  const total=groups.reduce((s,x)=>s+x.files.length,0);
  btn.textContent=groups.length?('开始导入 '+groups.length+' 套'):'开始导入';
  document.getElementById('bMsg').innerHTML=groups.length
    ? ('本次导入：<b>'+(model?('模特 '+model):'未填模特')+'</b>'+
       ((document.getElementById('bSeries').value||'').trim()?(' · 系列 '+document.getElementById('bSeries').value.trim()):'')+
       ' · <b>'+groups.length+' 套</b> · '+total+' 张图片')
    : '';
}
// 从文件夹路径识别模特：图集目录的上一层就是模特目录（选中「许岚」时即选中目录本身）
function detectModel(files,depth){
  const valid=files.filter(x=>IMGRE2.test(x.name));
  if(!valid.length)return '';
  const relOf=f=>(f.webkitRelativePath||f.name).split('/');
  const rel=relOf(valid[0]);
  const si=setIndexOf(rel,depth);
  if(si<1)return '';                            // 拖进来的是图集目录本身，上面没有模特层
  const cand=rel[si-1]||'';
  if(!cand||cand===rel[si])return '';
  return cand;
}
function syncModel(depth){
  const hint=document.getElementById('bModelHint'),inp=document.getElementById('bModel');
  const det=detectModel(lastFiles,depth);
  if(det&&!inp.value.trim()){
    inp.value=det;
    try{localStorage.setItem('batch-bModel',det)}catch(e){}
    hint.textContent='（已从文件夹识别：'+det+'，可改）';
  }else if(det){
    hint.textContent='（文件夹里的模特是「'+det+'」，当前填的是别的）';
  }else{
    hint.textContent='（从文件夹自动识别，可改）';
  }
}
document.getElementById('bModel').addEventListener('input',()=>setGroups(groups));
document.getElementById('bSeries').addEventListener('input',()=>setGroups(groups));
// 记住上次填的模特/系列/标签/层级（同一个模特常连着导好几批）
['bModel','bSeries','bTags','bDepth'].forEach(id=>{
  const el=document.getElementById(id);if(!el)return;
  try{const v=localStorage.getItem('batch-'+id);if(v&&!el.value)el.value=v}catch(e){}
  const save=()=>{try{localStorage.setItem('batch-'+id,el.value)}catch(e){}};
  el.addEventListener('change',save);el.addEventListener('input',save);
});
if(document.getElementById('bModel').value)document.getElementById('bModelHint').textContent='（上次填的，可改）';
document.getElementById('bDepth').addEventListener('change',()=>{if(lastFiles.length){syncModel(parseInt(document.getElementById('bDepth').value,10));setGroups(buildGroups(lastFiles))}});
// 逐套上传（串行，便于看进度；不逐套重建，最后统一重建一次）
async function startBatch(){
  if(!groups.length)return;
  const btn=document.getElementById('bStart');btn.disabled=true;
  const date=document.getElementById('bDate').value;
  const series=document.getElementById('bSeries').value.trim();
  const model=document.getElementById('bModel').value.trim();
  const tags=document.getElementById('bTags').value.trim();
  const autotag=document.getElementById('bAutoTag').checked;
  const log=document.getElementById('bLog'),wrap=document.getElementById('bWrap'),bar=document.getElementById('bBar'),msg=document.getElementById('bMsg');
  wrap.hidden=false;log.textContent='';
  let done=0,fail=0;
  for(const g of groups){
    const title=titleOf(g);
    msg.textContent='正在处理 第 '+(done+fail+1)+'/'+groups.length+' 套：'+title+' …';
    const fd=new FormData();
    fd.append('title',title);fd.append('date',date);
    if(series)fd.append('series',series);
    if(model)fd.append('model',model);
    if(tags)fd.append('tags',tags);
    fd.append('norebuild','1');
    if(autotag)fd.append('autotag','1');
    g.files.forEach(f=>fd.append('images',f,f.name));
    try{
      const r=await fetch('/upload',{method:'POST',body:fd});
      const j=await r.json();
      if(j.ok){done++;log.textContent+='✓ ['+(done+fail)+'/'+groups.length+'] '+title+' — '+(j.unchanged?('无新增（'+j.dup+' 张内容已存在）'):(j.images+' 张（共 '+j.total+'）'+(j.dup?(' · 跳过重复 '+j.dup):'')))+(j.dup_of&&j.dup_of.length?('  ⚠️ 与已有图集内容相同：'+j.dup_of.join(', ')):(j.same_title&&j.same_title.length?('  ⚠️ 已有同名图集：'+j.same_title.join(', ')):''))+'\\n'}
      else{fail++;log.textContent+='✗ '+title+' — '+(j.error||'失败')+'\\n'}
    }catch(e){fail++;log.textContent+='✗ '+title+' — '+e+'\\n'}
    bar.style.width=Math.round((done+fail)/groups.length*100)+'%';
    log.scrollTop=log.scrollHeight;
  }
  msg.textContent='正在重建站点（'+done+' 套成功'+(fail?(', '+fail+' 套失败'):'')+'）…';
  try{await fetch('/rebuild',{method:'POST'})}catch(e){}
  msg.innerHTML='✅ 完成：成功 '+done+' 套'+(fail?(', 失败 '+fail+' 套'):'')+' · <a href="/">返回后台查看</a>（可在列表里逐个编辑标题/标签）'+
    '<br><button class="btn" style="margin-top:10px" onclick="location.href=\'/\'">去后台同步到线上 →</button>';
  toast('批量导入完成：成功 '+done+' 套',fail===0);
  btn.disabled=false;
}
document.getElementById('bStart').onclick=startBatch;
""")


def esc_attr(s):
    """HTML 属性/文本转义（标签名可能含引号等字符）"""
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            .replace('"', '&quot;').replace("'", '&#39;'))


def delete_set(slug):
    """删除图集：先整体移到 _trash/（同盘改名、秒完成、可恢复），再重建站点。
    为什么要这样：Windows 上 shutil.rmtree 遇到被占用的文件（预览服务正在读缩略图、
    杀软扫描）会「删一半再报错」，图集目录被掏空却还在，而且异常直接把连接掐断，
    前端什么都看不到。改名是原子的 —— 要么成功、要么原样不动。"""
    slug = (slug or '').strip()
    if not slug:
        return False, '缺少 slug'
    p = os.path.normpath(os.path.join(SETS_DIR, slug))
    if not p.startswith(SETS_DIR + os.sep) or not os.path.isdir(p):
        return False, '未找到该图集'
    files = sum(len(f) for _, _, f in os.walk(p))
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(p) for f in fs)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    trash_dir = os.path.join(ROOT, '_trash')
    os.makedirs(trash_dir, exist_ok=True)
    dst = os.path.join(trash_dir, f'{stamp}-{slug}')
    try:
        # 必须用 os.rename：shutil.move 在改名失败（文件被占用）时会退化成「复制 + 删源」，
        # 结果就是复制一半、源目录被删一半 —— 比直接报错糟糕得多。rename 是原子的。
        os.rename(p, dst)
    except OSError as e:
        return False, (f'删除失败：无法移动图集目录（{type(e).__name__}: {e}）\n'
                       '  图集保持原样未动。多半是文件被占用 —— 关掉正在放图的页面/预览服务，稍后重试。')
    return True, (f'已删除「{slug}」（{files} 个文件 / {size / 1048576:.0f} MB）\n'
                  f'  已移到回收站：_trash/{os.path.basename(dst)}（确认无误可点「清空回收站」）')


def purge_trash():
    """清空 _trash/（回收站里的图集彻底删除）"""
    d = os.path.join(ROOT, '_trash')
    if not os.path.isdir(d):
        return True, '回收站是空的'
    names = os.listdir(d)
    if not names:
        return True, '回收站是空的'
    total = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(d) for f in fs)
    left = rm_tree_retry(d)
    if left:
        return False, f'回收站里有 {left} 项被占用删不掉（关掉占用的程序后重试）'
    return True, f'已清空回收站（{len(names)} 项 / {total / 1048576:.0f} MB）'


def rm_tree_retry(path, tries=3):
    """带重试的整目录删除；返回删不掉的顶层项数量"""
    for i in range(tries):
        if not os.path.exists(path):
            return 0
        try:
            shutil.rmtree(path)
            return 0
        except Exception:  # noqa
            time.sleep(0.4 * (i + 1))
    left = 0
    if os.path.isdir(path):
        for name in os.listdir(path):
            try:
                shutil.rmtree(os.path.join(path, name), ignore_errors=False)
            except Exception:  # noqa
                left += 1
    return left


def model_stats(slugs):
    """某模特的统计：套数、张数、真实总大小、最近日期、封面图"""
    total = count = 0
    latest, cover = '', ''
    for sl in slugs:
        d = os.path.join(SETS_DIR, sl)
        meta = read_meta(d)
        count += int(meta.get('imageCount') or len(set_images(d)) or 0)
        img_dir = os.path.join(d, 'images')
        if os.path.isdir(img_dir):
            for f in os.listdir(img_dir):
                p = os.path.join(img_dir, f)
                if os.path.isfile(p):
                    total += os.path.getsize(p)
        dt = str(meta.get('date') or '')
        if dt > latest:
            latest = dt
            c = next((f for f in ('cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp') if os.path.exists(os.path.join(d, f))), None)
            thumb = os.path.join(d, 'thumbs', 'cover.jpg')
            cover = f'/preview/{quote(sl)}/thumbs/cover.jpg' if os.path.exists(thumb) else (f'/preview/{quote(sl)}/{c}' if c else '')
    gb = total / 1073741824
    size = (f'{gb:.2f} GB' if gb >= 1 else f'{total / 1048576:.0f} MB') if total else ''
    return {'sets': len(slugs), 'images': count, 'size': size, 'latest': latest, 'cover': cover}


def rename_model(old, new):
    """批量改名/合并：把 sets/*/meta.json 里的模特名从 old 改成 new，并迁移资料文件。
    这是「改了一处、只有一个详情页生效」的正解 —— 模特名是每套图各存一份的。"""
    old, new = (old or '').strip(), (new or '').strip()
    if not old or not new:
        return False, '模特名不能为空'
    if old == new:
        return False, '新旧名称相同'
    changed, skipped = [], []
    for s in list_sets():
        d = os.path.join(SETS_DIR, s['slug'])
        meta = read_meta(d)
        if (meta.get('model') or '').strip() != old:
            continue
        meta['model'] = new
        # 缓存的展示标题/描述里也可能带着旧名字，清掉让构建重新生成
        for k in ('displayTitle', 'modelInfo'):
            if isinstance(meta.get(k), str) and old in meta[k]:
                if k == 'displayTitle':
                    meta.pop(k, None)
                else:
                    meta[k] = meta[k].replace(old, new)
        try:
            save_meta(d, meta)
            changed.append(s['slug'])
        except Exception as e:  # noqa
            skipped.append(f'{s["slug"]}: {e}')
    # 资料文件跟着改名；目标已存在则合并（目标优先，缺失字段从旧资料补）
    src = os.path.join(ROOT, 'models', f'{old}.json')
    dst = os.path.join(ROOT, 'models', f'{new}.json')
    moved = ''
    if os.path.isfile(src):
        try:
            old_prof = json.load(open(src, encoding='utf-8'))
        except Exception:  # noqa
            old_prof = {}
        if os.path.isfile(dst):
            try:
                cur = json.load(open(dst, encoding='utf-8'))
            except Exception:  # noqa
                cur = {}
            for k, v in old_prof.items():
                cur.setdefault(k, v)
            write_model_profile(new, cur)
            os.remove(src)
            moved = f'资料已合并进「{new}」'
        else:
            os.rename(src, dst)
            moved = f'资料文件已改名为 {new}.json'
    return True, (f'✓ 已把「{old}」改名为「{new}」，更新 {len(changed)} 套图集'
                  + (f'（{moved}）' if moved else '')
                  + (f'\n! {len(skipped)} 套写入失败：' + '；'.join(skipped[:3]) if skipped else ''))


def list_models_page_data():
    """模特列表数据（后台用）：按套数排序，带统计与资料完整度"""
    by_model = {}
    for s in list_sets():
        m = (s['meta'].get('model') or '').strip()
        if m:
            by_model.setdefault(m, []).append(s['slug'])
    return by_model


def models_page(msg=''):
    """模特资料：按模特统一维护（models/<模特>.json），改一次该模特全部图集生效"""
    by_model = {}
    for s in list_sets():
        m = (s['meta'].get('model') or '').strip()
        if m:
            by_model.setdefault(m, []).append(s['slug'])
    if not by_model:
        return page('模特资料', '<a class="btn ghost sm" href="/">← 返回后台</a>'
                    '<div class="panel"><h2>模特资料</h2><p class="sub">还没有图集填写「模特」字段。'
                    '在编辑页填上模特名，这里就能按模特统一维护资料。</p></div>')

    FIELDS = [
        ('birth', '出生', '如 1998 年'), ('sign', '星座', '如 巨蟹座'), ('city', '常驻', '如 广东深圳'),
        ('height', '身高', '如 168cm'), ('weight', '体重', '如 45kg'), ('measure', '三围', '如 86-60-88'),
        ('shoes', '鞋码', '如 37'), ('style', '风格', '如 清纯甜美'),
        ('weibo', '微博', '如 @许岚LAN'), ('douyin', '抖音', '如 许岚lan'),
        ('bilibili', 'B站', '选填'), ('xhs', '小红书', '选填'), ('other', '其他', '籍贯/特长等'),
    ]
    blocks = []
    model_sets_js = {}
    for model, slugs in sorted(by_model.items(), key=lambda kv: -len(kv[1])):
        pf = read_model_profile(model)
        st = model_stats(slugs)
        filled = sum(1 for k, _, _ in FIELDS if pf.get(k))
        # 头像裁剪器的"选图集"下拉：按日期倒序
        ordered = sorted(slugs, key=lambda sl: str(read_meta(os.path.join(SETS_DIR, sl)).get('date') or ''), reverse=True)
        model_sets_js[model] = [{'slug': sl, 'title': read_meta(os.path.join(SETS_DIR, sl)).get('title') or sl}
                                for sl in ordered]
        av = avatar_path(model)
        av_img = (f'<img src="/avatar/{quote(model_safe(model))}?t={int(os.path.getmtime(av))}" alt="" '
                  f'style="width:64px;height:64px;object-fit:cover;border-radius:50%;background:#111;border:2px solid var(--line)">'
                  if av else (f'<img src="{esc_attr(st["cover"])}" alt="" title="未设置头像，暂用最新一套的封面" '
                              f'style="width:64px;height:64px;object-fit:cover;border-radius:50%;background:#111;border:2px dashed var(--line);opacity:.6">'
                              if st['cover'] else '<span class="sub">无图</span>'))
        av_state = ('<span class="chip ok-chip">已用自定义头像</span>' if av
                    else '<span class="sub">暂用封面当头像</span>')
        inputs = ''.join(
            f'<div><label>{label}</label><input type="text" data-f="{k}" value="{esc_attr(pf.get(k, ""))}" placeholder="{ph}"></div>'
            for k, label, ph in FIELDS)
        blocks.append(f"""<div class="panel" data-model="{esc_attr(model)}">
  <h2 style="display:flex;align-items:center;gap:14px">
    {av_img}
    <span>👤 {esc_attr(model)}
      <span class="sub" style="font-weight:400">· {st['sets']} 套 · {st['images']} 张{(' · 合计 ' + st['size']) if st['size'] else ''}{(' · 最新 ' + st['latest']) if st['latest'] else ''}</span>
      <span class="sub" style="display:block;font-weight:400">资料 {filled} / {len(FIELDS)} 字段{'' if filled else '（全空）'}</span>
    </span>
    <span style="margin-left:auto;display:flex;align-items:center;gap:10px">
      {av_state}
      <button class="btn sm" data-m="{esc_attr(model)}" onclick="openAvatarCropper(this.dataset.m)">🙂 设置头像</button>
      {f'<button class="btn ghost sm" data-m="{esc_attr(model)}" onclick="clearAvatar(this.dataset.m)">清除</button>' if av else ''}
    </span>
  </h2>
  <div class="grid2" style="margin-top:12px">{inputs}</div>
  <div class="row" style="margin-top:12px">
    <button class="btn" onclick="saveModel(this)">保存并重建</button>
    <button class="btn danger sm" onclick="clearModel(this)">清空资料</button>
    <span class="sub" style="margin:0 0 0 16px">改名 / 合并到 →</span>
    <input type="text" class="mname" placeholder="新名字（填已有名字＝合并）" style="max-width:230px">
    <button class="btn ghost sm" onclick="renameModel(this)">应用到这 {st['sets']} 套</button>
    <a class="btn ghost sm" href="/?q={quote(model)}" target="_blank">筛选这 {st['sets']} 套</a>
    <span class="sub mstate" style="margin:0"></span>
  </div>
</div>""")
    return page('模特资料', f"""
<a class="btn ghost sm" href="/">← 返回后台</a>
<div class="panel"><h2>模特资料（按模特统一维护）</h2>
  <ul class="sub" style="margin:6px 0 0;padding-left:20px;line-height:1.9">
    <li>这里改一次，该模特名下<b>所有图集</b>都生效；留空的字段不会在站点展示，某套要特殊资料可在该图集的编辑页单独填（覆盖这里的值）。</li>
    <li><b>资料只在「模特页」展示</b>：图集详情页侧栏只显示模特名 + 作品入口，不带出生/身高这类资料。</li>
    <li><b>头像</b>：点「🙂 设置头像」→ 选图集 → 选图片 → 拖正方形选区 → 保存；不设置就用该模特最新一套的封面。</li>
    <li><b>改名 / 合并</b>：填一个新名字＝改组内所有图集的模特名；填一个已存在的名字＝把两位模特合并。</li>
  </ul>
</div>
{''.join(blocks)}
<script>window.MODEL_SETS={json.dumps(model_sets_js, ensure_ascii=False)};</script>""", extra_js="""
function collectModel(box){const o={};box.querySelectorAll('input[data-f]').forEach(function(i){const v=i.value.trim();if(v)o[i.dataset.f]=v});return o}
function saveModel(btn){
  const box=btn.closest('.panel'),model=box.dataset.model,profile=collectModel(box);
  btn.disabled=true;const st=box.querySelector('.mstate');st.textContent='保存并重建中…';
  fetch('/models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:model,profile:profile})})
    .then(function(r){return r.text()}).then(function(t){toast(t,true);st.textContent=t;btn.disabled=false})
    .catch(function(e){toast('失败：'+e,false);st.textContent='';btn.disabled=false});
}
function clearModel(btn){
  const box=btn.closest('.panel'),model=box.dataset.model;
  if(!confirm('清空「'+model+'」的全部资料？（该模特名下所有图集都不再展示资料）'))return;
  box.querySelectorAll('input[data-f]').forEach(function(i){i.value=''});
  saveModel(box.querySelector('.btn'));
}
function renameModel(btn){
  const box=btn.closest('.panel'),old=box.dataset.model;
  const nw=(box.querySelector('.mname').value||'').trim();
  if(!nw){toast('新名称不能为空',false);return}
  if(nw===old){toast('名称没变',false);return}
  if(!confirm('把「'+old+'」改名为「'+nw+'」？\\n\\n会写入该模特名下所有图集的元数据并重建站点。\\n如果「'+nw+'」已存在，相当于合并（资料会并入）。'))return;
  btn.disabled=true;const st=box.querySelector('.mstate');st.textContent='改名并重建中…';
  fetch('/model-rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:old,to:nw})})
    .then(function(r){return r.text()}).then(function(t){toast(t,true);st.textContent=t.split('\\n')[0];setTimeout(function(){location.reload()},1500)})
    .catch(function(e){toast('失败：'+e,false);st.textContent='';btn.disabled=false});
}
""")


def read_model_profile(model):
    """读取 models/<模特>.json"""
    safe = str(model).strip().replace('/', '_').replace('\\\\', '_')
    p = os.path.join(ROOT, 'models', safe + '.json')
    if not os.path.isfile(p):
        return {}
    try:
        return json.load(open(p, encoding='utf-8'))
    except Exception:  # noqa
        return {}


def write_model_profile(model, profile):
    safe = str(model).strip().replace('/', '_').replace('\\\\', '_')
    d = os.path.join(ROOT, 'models')
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, safe + '.json')
    if profile:
        json.dump(profile, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    elif os.path.exists(p):
        os.remove(p)
    return p


# ───────────── 隐藏套图（模糊封面 + 密码解锁）─────────────
# 原理：隐藏套图的页面与图片不放在公开的 set/<slug>/ 下，而是放在 h/<token>/ 下，
#      token = sha256(密码 + '|' + slug) 的前 16 位 —— 不知道密码就算不出这个路径，
#      而且生成的 HTML 里只出现模糊小图与提示，不出现 token。
#      密码放在 .hidden.json（已 gitignore，不进仓库、不随站点发布）。
HIDDEN_CFG_PATH = os.path.join(ROOT, '.hidden.json')


def read_hidden_cfg():
    try:
        return json.load(open(HIDDEN_CFG_PATH, encoding='utf-8'))
    except Exception:  # noqa
        return {}


def write_hidden_cfg(cfg):
    json.dump(cfg, open(HIDDEN_CFG_PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    return HIDDEN_CFG_PATH


def hidden_pw():
    """全局隐藏密码（没设就返回空串）"""
    return str((read_hidden_cfg() or {}).get('password') or '')


def hidden_hint():
    return str((read_hidden_cfg() or {}).get('hint') or '这套图已隐藏，输入密码后查看')


def hidden_token(slug, password):
    """与 build.mjs 的 hiddenToken() 完全一致：sha256(密码 + '|' + slug) 前 16 位"""
    return hashlib.sha256(((password or '') + '|' + slug).encode('utf-8')).hexdigest()[:16]


def set_hidden(slug, on, own_pw=None):
    """开关隐藏 + 生成模糊小图（锁定卡片用的公开底图）"""
    set_dir = os.path.join(SETS_DIR, slug)
    if not os.path.isdir(set_dir):
        return False, '图集不存在', None
    meta = read_meta(set_dir)
    pw = (own_pw if own_pw is not None else str(meta.get('hidePassword') or '')).strip()
    if on and not (pw or hidden_pw()):
        return False, '还没有设置隐藏密码：先在首页「🔒 隐藏套图」面板里设一个总密码，或给这套单独填一个', None
    meta['hidden'] = bool(on)
    if not on:
        meta.pop('hidden', None)          # 取消隐藏就把字段清掉，meta.json 干净
    if pw:
        meta['hidePassword'] = pw
    elif not on:
        meta.pop('hidePassword', None)
    save_meta(set_dir, meta)
    if on:
        try:
            make_blur(set_dir)
        except Exception as e:  # noqa
            log_line('error', f'生成模糊封面失败 {slug}: {e}')
    eff = pw or hidden_pw()
    return True, ('✓ 已隐藏（密码：' + ('单套密码' if pw else '全局密码') + '）' if on else '✓ 已取消隐藏'), hidden_token(slug, eff)


def make_blur(set_dir):
    """公开的模糊小图：压到 120px 再整体高斯模糊，肉眼认不出画面，只剩一团柔和的色光。

    尺寸别太小：卡片上的糊图要放大到 ~215×287（手机 ~180×240、轮播更宽），
    原来压到 24px 时一个像素被拉成十几个像素，放大后边缘会出现明显的方块锯齿，
    而且模糊半径盖不住 -> 边缘发虚发脏。120px 底图自带 6px 高斯模糊，
    浏览器端再补一点点模糊就足够顺滑了（文件仍然只有几 KB）。
    产物：sets/<slug>/blur.jpg 与 sets/<slug>/thumbs/blur.webp
    """
    from PIL import ImageFilter
    cover = next((f for f in ('cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp')
                  if os.path.exists(os.path.join(set_dir, f))), None)
    if not cover:
        return None
    im = ImageOps.exif_transpose(Image.open(os.path.join(set_dir, cover))).convert('RGB')
    im.thumbnail((120, 120), Image.LANCZOS)
    im = im.filter(ImageFilter.GaussianBlur(6))
    out = os.path.join(set_dir, 'blur.jpg')
    im.save(out, 'JPEG', quality=68)
    tdir = os.path.join(set_dir, 'thumbs')
    os.makedirs(tdir, exist_ok=True)
    if WEBP_ENABLED:
        try:
            im.save(os.path.join(tdir, 'blur.webp'), 'WEBP', quality=68, method=6)
        except Exception:  # noqa
            pass
    return out


def model_safe(model):
    """模特名 → 文件名安全串（与 build.mjs 的 avatarUrl() 规则保持一致）"""
    return re.sub(r'[\\/:*?"<>|]', '_', str(model)).strip()


def avatar_path(model):
    """该模特的自定义头像文件（models/avatar/<模特>.jpg|webp），没有返回 None"""
    d = os.path.join(ROOT, 'models', 'avatar')
    safe = model_safe(model)
    for ext in ('.webp', '.jpg', '.jpeg', '.png'):
        p = os.path.join(d, safe + ext)
        if os.path.isfile(p):
            return p
    return None


def crop_region(src, box, out_w, out_h):
    """按选区裁剪 + 缩放到 out_w×out_h（用 EXIF 摆正后的原图坐标）"""
    im = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
    W, H = im.size
    x1 = max(0, min(W - 1, int(box[0])))
    y1 = max(0, min(H - 1, int(box[1])))
    x2 = max(x1 + 10, min(W, int(box[2])))
    y2 = max(y1 + 10, min(H, int(box[3])))
    return im.crop((x1, y1, x2, y2)).resize((out_w, out_h), Image.LANCZOS), (x1, y1, x2, y2)


def save_banner(slug, img, box):
    """置顶轮播的自定义 Banner：从【本套图】里选一张裁成 BANNER_W×BANNER_H"""
    set_dir = os.path.join(SETS_DIR, slug)
    src = os.path.join(set_dir, 'images', img)
    if not os.path.isfile(src):
        return False, '图片不存在（请刷新页面重选）'
    crop, (x1, y1, x2, y2) = crop_region(src, box, BANNER_W, BANNER_H)
    crop.save(os.path.join(set_dir, 'banner.jpg'), 'JPEG', quality=90, optimize=True, progressive=True)
    tdir = os.path.join(set_dir, 'thumbs')
    os.makedirs(tdir, exist_ok=True)
    crop.save(os.path.join(tdir, 'banner.jpg'), 'JPEG', quality=88)
    if WEBP_ENABLED:
        try:
            crop.save(os.path.join(tdir, 'banner.webp'), 'WEBP', quality=WEBP_Q, method=6)
        except Exception:  # noqa
            pass
    meta = read_meta(set_dir)
    meta['banner'] = {'img': img, 'x': x1, 'y': y1, 'w': x2 - x1, 'h': y2 - y1,
                      'out': f'{BANNER_W}x{BANNER_H}'}
    save_meta(set_dir, meta)
    tip = ''
    if not meta.get('pinned'):
        tip = ('\n⚠️ 这套还没置顶：首页轮播只显示置顶图集，现在保存了也看不到。'
               '先在后台卡片上点「📌 置顶」再发布。')
    elif meta.get('pinUntil') and str(meta['pinUntil']) < time.strftime('%Y-%m-%d'):
        tip = f'\n⚠️ 置顶已于 {meta["pinUntil"]} 到期，首页轮播不会显示这套。'
    return True, f'✓ Banner 已裁剪：{img} 的 {x2 - x1}×{y2 - y1} 区域 → {BANNER_W}×{BANNER_H}{tip}'


def save_avatar(model, slug, img, box):
    """模特头像：从【该模特名下任意一套图】里选一张裁成方形 AVATAR_PX×AVATAR_PX"""
    src = os.path.join(SETS_DIR, slug, 'images', img)
    if not os.path.isfile(src):
        return False, '图片不存在（请刷新页面重选）'
    crop, (x1, y1, x2, y2) = crop_region(src, box, AVATAR_PX, AVATAR_PX)
    d = os.path.join(ROOT, 'models', 'avatar')
    os.makedirs(d, exist_ok=True)
    safe = model_safe(model)
    crop.save(os.path.join(d, safe + '.jpg'), 'JPEG', quality=92, optimize=True, progressive=True)
    if WEBP_ENABLED:
        try:
            crop.save(os.path.join(d, safe + '.webp'), 'WEBP', quality=WEBP_Q, method=6)
        except Exception:  # noqa
            pass
    prof = read_model_profile(model)
    prof['avatar'] = {'set': slug, 'img': img, 'x': x1, 'y': y1, 'w': x2 - x1, 'h': y2 - y1}
    write_model_profile(model, prof)
    return True, f'✓ 「{model}」头像已更新：{img} 的 {x2 - x1}×{y2 - y1} 区域 → {AVATAR_PX}×{AVATAR_PX}'


def clear_avatar(model):
    """删掉自定义头像（页面自动退回用封面当头像）"""
    d = os.path.join(ROOT, 'models', 'avatar')
    safe = model_safe(model)
    n = 0
    for ext in ('.jpg', '.jpeg', '.webp', '.png'):
        p = os.path.join(d, safe + ext)
        if os.path.isfile(p):
            try:
                os.remove(p)
                n += 1
            except Exception:  # noqa
                pass
    prof = read_model_profile(model)
    if prof.pop('avatar', None) is not None:
        write_model_profile(model, prof)
    return n


def clear_banner(slug):
    """删掉自定义 Banner（置顶轮播自动退回封面）"""
    set_dir = os.path.join(SETS_DIR, slug)
    n = 0
    for p in [os.path.join(set_dir, 'banner.jpg'), os.path.join(set_dir, 'banner.jpeg'),
              os.path.join(set_dir, 'banner.png'), os.path.join(set_dir, 'banner.webp'),
              os.path.join(set_dir, 'thumbs', 'banner.jpg'), os.path.join(set_dir, 'thumbs', 'banner.webp')]:
        if os.path.isfile(p):
            try:
                os.remove(p)
                n += 1
            except Exception:  # noqa
                pass
    meta = read_meta(set_dir)
    if meta.pop('banner', None) is not None:
        save_meta(set_dir, meta)
    return n


def all_tags():
    """汇总全站标签 → {标签: [使用它的图集slug...]}"""
    out = {}
    for s in list_sets():
        for t in (s['meta'].get('tags') or []):
            t = str(t).strip()
            if t:
                out.setdefault(t, []).append(s['slug'])
    return out


# 语义相近判定：归一化后相等、包含关系、常见同义词组
TAG_SYNONYMS = [
    {'制服', '校服', 'jk', 'jk制服'},
    {'日系风格', '日系风', '日系'},
    {'黑丝', '黑丝袜'},
    {'暖色调', '暖色', '暖光'},
    {'自然光', '自然光效', '日光'},
    {'清纯', '清纯风', '清纯系'},
    {'学院风', '校园风', '学院'},
    {'户外', '室外', '外景'},
    {'夜景', '夜晚', '夜间'},
    {'古典', '古风', '国风'},
    {'长发', '长头发'}, {'短发', '短头发'},
    {'性感', '妩媚'}, {'甜美', '甜系'},
    # 暗色/色调类
    {'暗黑系', '黑色系', '暗调', '暗色调', '暗色系', '黑色调'},
    {'暖色调', '暖色', '暖光', '暖调'}, {'冷色调', '冷色', '冷光', '冷调'},
    {'柔和光线', '柔和色调', '柔光', '柔光色调'},
    # 常见重复
    {'居家', '家居'}, {'室内', '室内拍摄', '室内摄影', '室内照', '室内布景'},
    {'日系', '日系风', '日系风格', '日本风'},
    {'欧美', '欧美风', '欧美风格'}, {'韩系', '韩式', '韩系风格', '韩风'},
    {'清新', '小清新'}, {'复古', '复古风', '复古风格'},
    {'简约', '简约风', '简约风格', '极简', '极简风'},
    {'青春', '青春活力', '青春感'}, {'温馨', '温馨氛围', '温暖氛围'},
    {'美食', '食物'}, {'泳池', '游泳池', '泳池边', '泳池拍摄'},
    # 袜类：统一用统称「丝袜」（黑丝/连裤袜/长筒袜都是它的子类；网袜保留纹理区分）
    {'丝袜', '黑丝', '连裤袜', '裤袜', '长筒袜', '黑丝袜', '白色丝袜', '白丝袜', '黑色丝袜'},
]


def norm_tag(t):
    return re.sub(r'[\s\-_·、,，。.！!~～&（）()\[\]「」【】]+', '', str(t)).lower()


def tag_similar_groups():
    """把全站标签按相似度分组 → [ {'tags': [...], 'count': n} ]"""
    tags = all_tags()
    names = sorted(tags.keys(), key=lambda t: -len(tags[t]))
    syn_groups = [{norm_tag(w) for w in g} for g in TAG_SYNONYMS]   # 归一化后的同义词组
    groups, used = [], set()
    for i, a in enumerate(names):
        if a in used:
            continue
        group = [a]
        na = norm_tag(a)
        for b in names[i + 1:]:
            if b in used:
                continue
            nb = norm_tag(b)
            # ① 落在同一个同义词组里；② 或一个包含另一个（如「日系风」⊂「日系风格」）
            same_syn = any((na in g) and (nb in g) for g in syn_groups)
            contained = bool(na and nb) and (na in nb or nb in na) and 2 <= min(len(na), len(nb))
            if same_syn or contained:
                group.append(b)
        if len(group) > 1:
            used.update(group)
            groups.append({'tags': group, 'count': sum(len(tags.get(t, [])) for t in group)})
    return groups


def tags_page(msg=''):
    tags = all_tags()
    groups = tag_similar_groups()
    rows = sorted(tags.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    table = ''.join(
        f'<tr><td><span class="chip" style="padding:4px 10px">{esc_attr(t)}</span></td><td>{len(sl)}</td>'
        f'<td class="dim" style="font-size:12px">{"、".join(sl[:3])}{"…" if len(sl) > 3 else ""}</td>'
        f'<td><input type="text" class="rename" data-from="{t}" placeholder="改成…" style="max-width:140px">'
        f'<button class="mini" onclick="renameTag(this)">重命名</button>'
        f'<button class="mini" onclick="delTag(this)" data-tag="{esc_attr(t)}">全站删除</button></td></tr>'
        for t, sl in rows)
    ghtml = ''
    for g in groups:
        opts = ''.join(f'<option value="{t}">{t}（{len(tags.get(t, []))}）</option>' for t in g['tags'])
        ghtml += (f'<div class="taggroup"><div class="tg-list">'
                  + ' + '.join(f'<span class="chip" data-tag="{esc_attr(t)}">{esc_attr(t)}</span>' for t in g['tags'])
                  + f'</div><div class="tg-act"><span class="sub" style="margin:0">合并为：</span>'
                  + f'<select class="mergeto">{opts}</select>'
                  + f'<button class="btn sm" onclick="mergeGroup(this)">合并</button></div></div>')
    body = f"""
<div class="crumb"><a href="/">← 图集列表</a></div>
<h1>标签管理</h1>
<p class="sub">共 {len(tags)} 个标签 · 检测到 {len(groups)} 组语义相近标签（合并后旧标签从全站图集移除并替换为新标签）</p>

<div class="panel"><h2>🔀 语义相近标签（建议合并）</h2>
  {ghtml or '<p class="sub">没有检测到需要合并的相近标签 👍</p>'}
</div>

<div class="panel"><h2>🏷 全部标签（{len(tags)} 个）</h2>
  <div class="row" style="margin:0 0 10px">
    <input type="text" id="tagFilter" placeholder="筛选标签…" style="max-width:220px">
    <button class="btn ghost sm" onclick="location.reload()">刷新</button>
  </div>
  <table class="tagtable" id="tagTable">
    <thead><tr><th>标签</th><th>图集数</th><th>用于</th><th>操作</th></tr></thead>
    <tbody>{table or '<tr><td colspan="4" class="sub">暂无标签</td></tr>'}</tbody>
  </table>
</div>"""
    extra = """
function renameTag(btn){
  const inp=btn.parentElement.querySelector('.rename'),from=inp.dataset.from,to=inp.value.trim();
  if(!to){toast('请填写新标签名',false);return}
  if(!confirm('把全站「'+from+'」重命名为「'+to+'」？'))return;
  toast('正在重命名并重建站点，请稍候…');
  post('/tagmerge',{from:[from],to},'/tags');
}
function delTag(btn){
  const t=btn.dataset.tag;
  if(btn.dataset.armed!=='1'){
    btn.dataset.armed='1';btn.textContent='确认删除';
    toast('再点一次确认：从全站删除标签「'+t+'」');
    setTimeout(()=>{if(btn.dataset.armed==='1'){btn.dataset.armed='0';btn.textContent='全站删除'}},5000);
    return;
  }
  toast('正在删除并重建站点…');post('/tagmerge',{from:[t],to:''},'/tags');
}
function mergeGroup(btn){
  const sel=btn.parentElement.querySelector('.mergeto');
  const to=sel.value;
  const group=[...btn.closest('.taggroup').querySelectorAll('.chip')].map(c=>c.dataset.tag||c.textContent.trim());
  const from=group.filter(t=>t!==to);
  if(!from.length){toast('这一组只有一个标签，无需合并',false);return}
  // 两步确认：不依赖浏览器 confirm 弹窗（弹窗被拦截时会静默失败，点了像没反应）
  if(btn.dataset.armed!=='1'){
    btn.dataset.armed='1';btn.textContent='确认合并';btn.classList.add('danger');
    toast('再点一次确认：把 '+from.join('、')+' 合并进「'+to+'」');
    setTimeout(()=>{if(btn.dataset.armed==='1'){btn.dataset.armed='0';btn.textContent='合并';btn.classList.remove('danger')}},5000);
    return;
  }
  btn.dataset.armed='0';btn.textContent='合并';btn.classList.remove('danger');
  toast('正在合并并重建站点，请稍候…');
  post('/tagmerge',{from,to},'/tags');
}
const tf=document.getElementById('tagFilter');
if(tf)tf.addEventListener('input',()=>{const q=tf.value.trim().toLowerCase();let n=0;document.querySelectorAll('#tagTable tbody tr').forEach(tr=>{const hit=!q||tr.textContent.toLowerCase().includes(q);tr.hidden=!hit;if(hit)n++})});
"""
    if msg:
        extra += f'window.addEventListener("load",()=>toast({json.dumps(msg, ensure_ascii=False)},true));'
    return page('标签管理', body, extra)


SORTS = [('date-desc', '最新在前'), ('date-asc', '最早在前'), ('title-asc', '按标题'),
         ('count-desc', '图片最多'), ('size-desc', '体积最大')]


def home_page(msg='', q='', page_no=1, per=24, sort='date-desc', view='card'):
    # 注意：页码参数不能叫 page —— 会遮蔽模块级的 page() 渲染函数（踩过一次）
    all_sets = list_sets()
    filtered = filter_sort_sets(all_sets, q, sort)
    total_all, total_hit = len(all_sets), len(filtered)
    try:
        page_no = max(1, int(page_no))
    except Exception:  # noqa
        page_no = 1
    try:
        per = int(per)
    except Exception:  # noqa
        per = 24
    if per <= 0:                      # per=0 → 显示全部（老习惯：想看全部就选它）
        per = total_hit or 1
    total_pages = max(1, (total_hit + per - 1) // per)
    page_no = min(page_no, total_pages)
    start = (page_no - 1) * per
    page_sets = filtered[start:start + per]
    range_from = start + 1 if total_hit else 0
    range_to = min(start + per, total_hit)
    base_qs = '&'.join([f'q={quote(q)}'] if q else []) + (f'&sort={sort}' if sort != 'date-desc' else '') \
        + (f'&per={per}' if per != 24 else '') + (f'&view={view}' if view != 'card' else '')
    base_qs = base_qs.lstrip('&') or 'per=24'
    sets = all_sets  # 顶部统计/其它区块仍用全量
    untagged = sum(1 for s in all_sets if not (s['meta'].get('autoTags') or []))
    hidden_names = [s['meta'].get('title') or s['slug'] for s in all_sets if s['meta'].get('hidden')]
    hidden_n = len(hidden_names)
    body = f"""
<h1>图集管理后台</h1>
<p class="sub">上传 → 自动生成缩略图(长边 {PREVIEW_LONG}px)+模糊占位图 → 写入 sets/ → 重建静态站 · 端口 {PORT}</p>
<form class="panel" id="f" method="post" action="/upload" enctype="multipart/form-data">
  <h2>① 新建图集</h2>
  <div class="grid2">
    <div><label>标题（主题名）*</label><input type="text" name="title" required placeholder="例：油菜花 一一"></div>
    <div><label>系列</label><input type="text" name="series" placeholder="例：YITUYU艺图语"></div>
    <div><label>日期</label><input type="date" name="date" value="{date.today().isoformat()}"></div>
    <div><label>模特</label><input type="text" name="model" placeholder="例：一一"></div>
    <div><label>标签（逗号分隔）</label><input type="text" name="tags" placeholder="油菜花,清新,户外"></div>
    <div><label>图片像素（留空自动检测）</label><input type="text" name="resolution" placeholder="留空 = 自动从上传图片读取真实尺寸"></div>
    <div><label>解压密码</label><input type="text" name="password" placeholder="例：vx666878787"></div>
    <div><label>下载网盘</label><input type="text" name="netdisk" placeholder="例：天翼云盘 / 百度网盘"></div>
    <div><label>网盘下载外链（可选）</label><input type="text" name="downloadUrl" placeholder="https://..."></div>
    <div><label>网盘提取码（可选）</label><input type="text" name="shareCode" placeholder="例：8a2k"></div>
    <div><label>目录名（可选）</label><input type="text" name="slug" placeholder="留空自动生成"></div>
  </div>
  <div><label style="margin-top:12px">描述（可选）</label><textarea name="description" rows="2"></textarea></div>
  <div class="drop" id="drop"><div><strong>拖拽图片/文件夹到这里</strong> 或 <strong>点击选择图片</strong>（可多选）</div>
    <div style="font-size:12px;margin-top:6px">缩略图 {PREVIEW_LONG}px 自动生成 · 封面自动 {COVER_W}×{COVER_H} 裁切</div>
    <input type="file" id="imgs" name="images" accept="image/*" multiple hidden></div>
  <div class="row"><button type="button" class="btn ghost sm" id="pickFolder">📁 选择整个文件夹导入</button>
    <span class="sub" style="margin:0">按文件名排序（00001→00041）· 自动用文件夹名填标题</span>
    <input type="file" id="folder" webkitdirectory directory multiple hidden></div>
  <div class="files" id="files"></div>
  <div class="row"><label style="margin:0"><input type="checkbox" id="mkcover"> 另选封面图</label>
    <input type="file" id="coverfile" name="cover" accept="image/*" hidden>
    <button type="button" class="btn ghost sm" id="pickcover" disabled>选择封面</button><span id="covername" class="sub" style="margin:0"></span></div>
  <div class="row"><label style="margin:0">压缩包 pack.zip（可选）</label><input type="file" name="pack" accept=".zip"></div>
  <div class="row"><label style="margin:0"><input type="checkbox" name="autotag" value="1" checked> 🤖 上传后自动打标（视觉模型分析样图 → 生成标签与描述，可在编辑页手动调整）</label></div>
  <div class="row"><button class="btn" type="submit" id="submit">上传并生成站点</button>
    <span class="sub" id="upProgress" style="margin:0"></span></div>
  <div class="progress" id="progWrap" hidden><div class="bar" id="progBar"></div></div>
</form>
<details class="panel"{' open' if not hidden_pw() else ''}>
  <summary style="cursor:pointer;font-weight:600;font-size:15px">🔒 隐藏套图（模糊封面 + 密码查看）
    <span class="sub" style="font-weight:400"> · {hidden_n} 套已隐藏 · {('密码已设置（点开查看 / 修改）' if hidden_pw() else '⚠️ 还没设置密码')}</span></summary>
  <div class="row" style="align-items:center;margin-top:12px">
    <label style="margin:0">全局密码</label>
    <input type="text" id="hidPw" value="{esc_attr(hidden_pw())}" placeholder="留空＝关闭隐藏功能" style="max-width:240px">
    <button class="btn ghost sm" type="button" onclick="togglePwView()" id="pwEye" title="临时遮住密码（截图/有人看着时用）">👁 遮住</button>
    <button class="btn ghost sm" type="button" onclick="copyText(document.getElementById('hidPw').value,'密码')">📋 复制密码</button>
    <label style="margin:0 0 0 10px">解锁提示语</label>
    <input type="text" id="hidHint" value="{esc_attr(hidden_hint())}" placeholder="私密套图，请输入密码查看" style="max-width:300px">
    <button class="btn" onclick="saveHiddenCfg()">保存并重建</button>
  </div>
  <p class="sub" style="margin:8px 0 4px"><b>改密码会让所有隐藏套图的地址一起变</b>（已发出去的旧链接失效，需要重新复制）；留空保存＝关闭隐藏功能，已隐藏的套图会重新变成公开。</p>
  <p class="sub" style="margin:6px 0 0">勾了「隐藏」的套图：列表里只显示<b>模糊封面</b>、点不进去，输密码后才能打开。密码只存在本机
    <code>.hidden.json</code>（已 gitignore，不进仓库、不随站点发布）；隐藏套图的页面与图片放在
    <code>/h/&lt;密码算出来的随机串&gt;/</code> 下 —— 不知道密码就算不出地址，站点源码里也不出现它。</p>
  {f'<p class="sub" style="margin:8px 0 0">已隐藏 {hidden_n} 套：{"、".join(hidden_names[:6])}{"…" if hidden_n > 6 else ""}　' + '<a href="/?q=">在列表里筛选</a></p>' if hidden_names else '<p class="sub" style="margin:8px 0 0">还没有隐藏任何套图：在卡片上点「🔒 隐藏」，或在编辑页勾选。</p>'}
  <p class="sub" style="margin:6px 0 0">单套想用别的密码：打开那套图的编辑页，勾「隐藏」后填「单套密码」即可（留空＝用这里的全局密码）。</p>
</details>
<div class="panel"><h2>② 已有图集（{total_all} 套{(' · 筛选出 ' + str(total_hit) + ' 套') if q else ''}）<span class="sub" style="font-weight:400"> · 点击卡片即可编辑</span>
  {f'<span class="sub" style="font-weight:400"> · 🤖 {untagged} 套还没打标</span>' if untagged else ''}
  {f'<span class="sub" style="font-weight:400"> · 🤖 打标队列进行中（{_at.get("done", 0)}/{_at.get("total", 0)}）</span>' if _at.get('running') else ''}
  </h2>
  <form class="row" method="get" action="/" style="margin:0 0 12px;align-items:center">
    <input type="search" name="q" value="{esc_attr(q)}" placeholder="搜索标题 / 模特 / 标签 / 系列 / 目录名（回车=全库搜索）" style="max-width:340px">
    <select name="sort" onchange="this.form.submit()" style="padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--fg)">
      {''.join(f'<option value="{v}"{" selected" if sort == v else ""}>{label}</option>' for v, label in SORTS)}
    </select>
    <select name="per" onchange="this.form.submit()" style="padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--fg)">
      {''.join(f'<option value="{v}"{" selected" if per == v else ""}>每页 {v if v else "全部"} 套</option>' for v in (12, 24, 48, 96, 0))}
    </select>
    <button class="btn ghost sm" type="submit">搜索</button>
    {f'<a class="btn ghost sm" href="/">清除筛选</a>' if q else ''}
    <span class="sub" style="margin:0">显示第 <b>{range_from}</b>–<b>{range_to}</b> 条，共 <b>{total_hit}</b> 套</span>
    <span style="flex:1"></span>
    <select id="viewSel" onchange="setView(this.value)" style="padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--fg)">
      <option value="card">卡片视图</option>
      <option value="list">紧凑列表</option>
    </select>
  </form>
  <div class="sets" id="setsGrid">{sets_cards(page_sets)}</div>
  <p class="sub" id="setEmpty" hidden>当前页没有匹配的图集（试试按回车做全库搜索）</p>
  {pager_html(page_no, total_pages, base_qs)}
  <div class="bulk">
    <span class="sub" style="margin:0">已选 <b id="pickCount">0</b> 套<span id="pickOther"></span>：</span>
    <input type="text" id="bulkSeries" placeholder="批量设置系列">
    <button class="btn ghost sm" onclick="bulkSetSeries()">应用系列</button>
    <input type="text" id="bulkTags" placeholder="批量追加标签（逗号分隔）">
    <button class="btn ghost sm" onclick="bulkAddTags()">追加标签</button>
    <button class="btn ghost sm" onclick="bulkAutoTag()">🤖 批量打标</button>
    <a class="btn ghost sm" href="/rename" title="只处理已勾选的（勾选框右上角）">✏️ 批量重命名选中</a>
    <button class="btn danger sm" onclick="bulkDelete()">删除选中</button>
    <button class="btn ghost sm" onclick="clearPick()">清空选择</button>
  </div>
  <div class="row"><button class="btn ghost" onclick="rebuild()">重新构建站点</button>
  <button class="btn" onclick="publishNow()">🚀 同步到线上</button>
  <button class="btn ghost" onclick="publishLog()">查看发布日志</button>
  <button class="btn ghost" onclick="backfill()">补齐所有缩略图</button>
  <button class="btn ghost" onclick="detectResAll()">📐 自动检测所有图集像素</button>
  <button class="btn ghost" onclick="autotagAll()">🤖 批量自动打标（未打标的图集）</button>
  <button class="btn ghost" onclick="dupCheck()">🔍 查重复图集</button>
  <button class="btn ghost" onclick="healthCheck()">🩺 站点体检</button>
  <button class="btn ghost" onclick="purgeTrash()">🗑 清空回收站</button>
  <a class="btn ghost" href="/tags">🏷 标签管理</a>
  <a class="btn ghost" href="/rename">✏️ 批量重命名</a>
  <a class="btn ghost" href="/links">🔗 批量导入网盘链接</a>
  <a class="btn ghost" href="/batch">📚 批量导入文件夹（多套）</a>
  <a class="btn ghost" href="/models">👤 模特资料（按模特统一维护）</a>
  <a class="btn ghost" href="http://127.0.0.1:8090/" target="_blank">打开站点预览 ↗</a></div>
  <div class="pub" id="pubBox" hidden>
    <div class="pub-head"><b id="pubTitle">发布到线上</b><span id="pubMsg" class="sub" style="margin:0"></span></div>
    <pre id="pubLog"></pre>
  </div>
    <div class="pub" id="atBox" hidden>
      <div class="pub-head"><b>批量自动打标</b><span id="atMsg" class="sub" style="margin:0"></span></div>
      <div class="progress" id="atWrap"><div class="bar" id="atBar"></div></div>
      <pre id="atLog"></pre>
    </div>
  </div>"""
    extra = """
const drop=document.getElementById('drop'),imgs=document.getElementById('imgs'),files=document.getElementById('files');
const mk=document.getElementById('mkcover'),cf=document.getElementById('coverfile'),pc=document.getElementById('pickcover'),cn=document.getElementById('covername');
let chosen=[];                       // 实际上传的文件（保持顺序）
const IMGRE=/\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;
drop.onclick=()=>imgs.click();
drop.ondragover=e=>{e.preventDefault();drop.classList.add('on')};
drop.ondragleave=()=>drop.classList.remove('on');
drop.ondrop=async e=>{
  e.preventDefault();drop.classList.remove('on');
  const hasDir=[...(e.dataTransfer.items||[])].some(i=>{const en=i.webkitGetAsEntry&&i.webkitGetAsEntry();return en&&en.isDirectory});
  if(hasDir){
    toast('正在读取文件夹…');
    const got=await walkItems(e.dataTransfer.items);
    applyFolder(got.files,got.rootName);
  }else{
    chosen=[...e.dataTransfer.files];show();
  }
};
imgs.onchange=()=>{chosen=[...imgs.files];show()};
// ── 文件夹导入：选择整个文件夹 → 按文件名排序 → 用文件夹名填标题 ──
const folderInput=document.getElementById('folder');
document.getElementById('pickFolder').onclick=()=>folderInput.click();
folderInput.onchange=()=>{
  const fs=[...folderInput.files].filter(f=>IMGRE.test(f.name));
  const root=(folderInput.files[0]&&folderInput.files[0].webkitRelativePath||'').split('/')[0]||'';
  applyFolder(fs,root);
};
function applyFolder(fs,rootName){
  fs.sort((a,b)=>(a.webkitRelativePath||a.name).localeCompare(b.webkitRelativePath||b.name,'zh',{numeric:true}));
  chosen=fs;
  if(fs.length){
    const t=document.querySelector('input[name=title]');
    const model=(document.querySelector('input[name=model]').value||'').trim();
    let name=rootName||'';
    // 文件夹名形如「许岚 NO.001 教室JK黑丝」→ 去掉开头的模特名，作为标题
    if(model&&name.startsWith(model))name=name.slice(model.length).trim();
    if(name&&!t.value.trim())t.value=name;
    toast('已选 '+fs.length+' 张：'+(rootName?('文件夹「'+rootName+'」'):''));
  }else{toast('这个文件夹里没有图片',false)}
  show();
}
// 递归读取拖入的文件夹：readEntries / walkEntry / walkItems 已移到共享 JS
function show(){files.innerHTML=chosen.map((f,i)=>'<div>'+(i+1)+'. '+f.name+' · '+(f.size/1048576).toFixed(2)+'MB</div>').join('');document.getElementById('submit').textContent=chosen.length?('上传 '+chosen.length+' 张并生成站点'):'上传并生成站点'}
mk.onchange=()=>{pc.disabled=!mk.checked;if(!mk.checked){cf.value='';cn.textContent=''}};
pc.onclick=()=>cf.click();cf.onchange=()=>{cn.textContent=cf.files[0]?cf.files[0].name:'（未选）'};
document.getElementById('f').onsubmit=()=>{if(!chosen.length){toast('请至少选择一张图片或一个文件夹',false);return false}const b=document.getElementById('submit');b.disabled=true;b.textContent='上传中，请稍候…'};
// 上传进度（XHR 上报进度 + 服务端处理阶段提示）
const upForm=document.getElementById('f');
if(upForm&&window.XMLHttpRequest){
  upForm.addEventListener('submit',function(ev){
    if(!chosen.length)return;
    ev.preventDefault();
    const fd=new FormData(upForm);
    // 用选定顺序（文件夹导入已按文件名排序）替换表单自带的文件列表
    fd.delete('images');
    chosen.forEach(f=>fd.append('images',f,f.name));
    const xhr=new XMLHttpRequest();
    const wrap=document.getElementById('progWrap'),bar=document.getElementById('progBar'),hint=document.getElementById('upProgress');
    wrap.hidden=false;bar.style.width='0%';hint.textContent='上传中…';
    xhr.upload.onprogress=function(e){if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);bar.style.width=p+'%';hint.textContent='上传中 '+p+'%（'+ (e.loaded/1048576).toFixed(1) +'MB / '+ (e.total/1048576).toFixed(1) +'MB）';}};
    xhr.upload.onload=function(){bar.style.width='100%';hint.textContent='上传完成，正在生成缩略图并重建站点…（大图集需要一会儿）'};
    xhr.onload=function(){document.open();document.write(xhr.responseText);document.close()};
    xhr.onerror=function(){toast('上传失败，请重试',false);hint.textContent='';wrap.hidden=true;document.getElementById('submit').disabled=false};
    xhr.open('POST',upForm.action);xhr.send(fd);
  });
}
// 批量操作
function picked(){return [...document.querySelectorAll('.pick:checked')].map(c=>c.dataset.slug)}
function togglePick(cb){cb.closest('.set').classList.toggle('picked',cb.checked);document.getElementById('pickCount').textContent=picked().length}
function clearPick(){document.querySelectorAll('.pick').forEach(c=>{c.checked=false;c.closest('.set').classList.remove('picked')});document.getElementById('pickCount').textContent=0}
function bulkSend(action,payload,label){const slugs=picked();if(!slugs.length){toast('请先勾选图集（卡片右上角复选框）',false);return}if(label&&!confirm(label+'（共 '+slugs.length+' 套）？'))return;toast('处理中…');fetch('/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action,slugs},payload||{}))}).then(r=>r.text()).then(t=>{toast(t,true);setTimeout(()=>location.reload(),1200)}).catch(e=>toast('失败：'+e,false))}
function bulkSetSeries(){const v=document.getElementById('bulkSeries').value.trim();if(!v){toast('请填写系列名',false);return}bulkSend('setSeries',{value:v})}
function bulkAddTags(){const v=document.getElementById('bulkTags').value.trim();if(!v){toast('请填写标签',false);return}bulkSend('addTags',{value:v})}
function bulkAutoTag(){bulkSend('autotag',{},'对选中图集批量 AI 打标')}
function bulkDelete(){bulkSend('delete',{},'删除选中图集（不可恢复）')}
// 裁剪器（封面 / 置顶 Banner / 模特头像）已挪到全站公共 JS，编辑页与模特页也能用
// 图集筛选
const sf=document.getElementById('setFilter'),sg=document.getElementById('setsGrid'),se=document.getElementById('setEmpty');
if(sf&&sg){sf.addEventListener('input',()=>{const q=sf.value.trim().toLowerCase();let n=0;[...sg.querySelectorAll('.set')].forEach(c=>{const hit=!q||(c.dataset.search||'').includes(q);c.hidden=!hit;if(hit)n++});if(se)se.hidden=n!==0})}
// ── 视图切换（卡片 / 紧凑列表），记住选择 ──
function setView(v){v=(v==='list')?'list':'card';document.getElementById('setsGrid').dataset.view=v;
  var sel=document.getElementById('viewSel');if(sel)sel.value=v;try{localStorage.setItem('adminSetView',v)}catch(e){}}
(function(){var v='__VIEW__';try{v=localStorage.getItem('adminSetView')||v}catch(e){}setView(v)})();
// ── 跨页勾选：勾中的 slug 存在 sessionStorage，翻页/搜索后依然记得 ──
function pickedStore(){try{return new Set(JSON.parse(sessionStorage.getItem('adminPicked')||'[]'))}catch(e){return new Set()}}
function savePicked(s){try{sessionStorage.setItem('adminPicked',JSON.stringify([...s]))}catch(e){}}
function refreshPickUI(){
  const st=pickedStore();const onPage=[...document.querySelectorAll('.pick')];
  document.querySelectorAll('.pick').forEach(cb=>{cb.checked=st.has(cb.dataset.slug);cb.closest('.set').classList.toggle('picked',cb.checked)});
  const here=onPage.filter(c=>st.has(c.dataset.slug)).length;
  const el=document.getElementById('pickCount');if(el)el.textContent=st.size;
  const o=document.getElementById('pickOther');if(o)o.textContent=(st.size>here?('（本页 '+here+' 套，其余 '+(st.size-here)+' 套在其他页）'):'');
}
""".replace('__VIEW__', view or 'card')
    extra += """
function togglePick(cb){const st=pickedStore();if(cb.checked)st.add(cb.dataset.slug);else st.delete(cb.dataset.slug);savePicked(st);refreshPickUI()}
function clearPick(){savePicked(new Set());refreshPickUI()}
// 批量操作取"跨页勾选"的全集（分页后 DOM 里只有当前页）
function picked(){return [...pickedStore()]}
window.addEventListener('DOMContentLoaded',refreshPickUI);
"""
    if msg:
        extra += f'window.addEventListener("load",()=>toast({json.dumps(msg, ensure_ascii=False)},true));'
    return page('图集管理后台', body, extra)


def edit_page(slug, msg=''):
    set_dir = os.path.join(SETS_DIR, slug)
    if not os.path.isdir(set_dir):
        return page('未找到', '<p>未找到该图集</p><p><a class="btn ghost" href="/">返回</a></p>')
    m = read_meta(set_dir)
    imgs = set_images(set_dir)
    cover = next((c for c in ('cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp') if os.path.exists(os.path.join(set_dir, c))), None)
    # 判断当前封面来自哪张原图（按字节相同）
    cover_src_img = None
    if cover:
        cb = open(os.path.join(set_dir, cover), 'rb').read()
        for f in imgs:
            try:
                if open(os.path.join(set_dir, 'images', f), 'rb').read() == cb:
                    cover_src_img = f; break
            except Exception:
                pass
    thumbs = ''.join(f"""<div class="thumb {'is-cover' if cover_src_img == f else ''}" draggable="true" data-img="{f}">
      <span class="badge">{i+1}</span>
      <img src="/preview/{quote(slug)}/thumbs/{os.path.splitext(f)[0]}.jpg" alt="" loading="lazy">
      <div class="ops">
        <button onclick="setCover('{slug}','{f}')">设为封面</button>
        <button onclick="delImage('{slug}','{f}')">删除</button>
      </div></div>""" for i, f in enumerate(imgs))
    # 重复图片数量（按内容指纹）+ 像素检测提示
    _hashes = {}
    dupes = 0
    for f in imgs:
        try:
            h = hashlib.md5(open(os.path.join(set_dir, 'images', f), 'rb').read()).hexdigest()
        except Exception:
            continue
        if h in _hashes:
            dupes += 1
        else:
            _hashes[h] = f
    _res_txt, _res_info = detect_resolution(set_dir)
    _res_hint = (f'已检测：{_res_txt}（共 {_res_info["count"]} 张，{_res_info["distinct"]} 种尺寸）'
                 if _res_txt else '暂无图片可检测')
    pf = m.get('profile') or {}
    # 隐藏套图的分享地址（f-string 里不能出现反斜杠，所以这段先在外面拼好）
    _hid_pw = m.get('hidePassword') or hidden_pw()
    _hid_tok = hidden_token(slug, _hid_pw) if (m.get('hidden') and _hid_pw) else ''
    hid_url_html = (
        '<p class="sub" style="margin:-2px 0 8px">本套访问地址（不知道密码算不出来，可直接发给朋友）：'
        '<code id="hidUrl">https://pixnest.dpdns.org/h/' + _hid_tok + '/</code> '
        '<button type="button" class="btn ghost sm" onclick="copyText(this.previousElementSibling.textContent.trim(),&#39;分享链接&#39;)">📋 复制链接</button>'
        '<button type="button" class="btn ghost sm" onclick="copyText(document.getElementById(&#39;hidPwHint&#39;)?document.getElementById(&#39;hidPwHint&#39;).textContent.trim():&#39;&#39;,&#39;密码&#39;)">📋 复制密码</button>'
        '<span class="sub">（密码：<b id="hidPwHint">' + esc_attr(_hid_pw) + '</b>' + ('· 单套密码' if m.get('hidePassword') else '· 全局密码') + '）</span></p>'
    ) if _hid_tok else ''

    body = f"""
<div class="crumb"><a href="/">← 图集列表</a></div>
<h1>编辑：{m.get('title') or slug}</h1>
<p class="sub">目录 <code>{slug}</code> · 共 {len(imgs)} 张图片{(' · 当前封面：' + cover_src_img) if cover_src_img else ''}</p>

<form class="panel" method="post" action="/save" enctype="multipart/form-data">
  <h2>① 修改发布信息</h2>
  <input type="hidden" name="slug" value="{slug}">
  <div class="grid2">
    <div><label>标题 *</label><input type="text" name="title" value="{m.get('title','')}" required></div>
  </div>
  <div class="grid2">
    <div class="grid2">
      <div class="field-wide"><label>标签（点 × 删除 · 输入后回车或点「+ 添加」）</label>
        <div class="chips" id="tagChips"></div>
        <div class="chip-add">
          <input type="text" id="tagInput" placeholder="输入标签，如「教室」（回车添加）">
          <button type="button" class="btn ghost sm" onclick="addTag()">+ 添加</button>
          <button type="button" class="btn ghost sm" onclick="pullAiTags()" title="把上次 AI 生成的标签追加进来">↺ 采纳 AI 标签</button>
        </div>
        <input type="hidden" name="tags" id="tagsValue" value="{','.join(m.get('tags',[]))}">
        {f'<div class="sub" style="margin-top:6px">AI 建议（点一下加入）：' + ''.join(f'<button type="button" class="chip chip-ai" onclick="addTagValue(this.textContent)">{t}</button>' for t in m.get('autoTags', []) if t not in m.get('tags', [])) + '</div>' if any(t not in m.get('tags', []) for t in m.get('autoTags', [])) else ''}
      </div>
    </div>
    <div class="grid2">
      <div><label>系列</label><input type="text" name="series" value="{m.get('series','')}"></div>
      <div><label>模特</label><input type="text" name="model" value="{m.get('model','')}"></div>
      <div><label>图片像素（留空自动检测）</label><input type="text" name="resolution" value="{m.get('resolution','')}" placeholder="留空 = 自动从图片读取"></div>
      <div><label>解压密码</label><input type="text" name="password" value="{m.get('password','')}"></div>
      <div><label>下载网盘</label><input type="text" name="netdisk" value="{m.get('netdisk','')}"></div>
      <div><label>网盘外链（留空则用本地 pack.zip）</label><input type="text" name="downloadUrl" value="{m.get('downloadUrl','')}"></div>
      <div><label>网盘提取码</label><input type="text" name="shareCode" value="{m.get('shareCode','')}" placeholder="例：8a2k"></div>
      <div><label>展示的预览图数量</label><input type="text" name="previewCount" value="{m.get('previewCount','')}" placeholder="留空=默认 8 或全部"></div>
      <div><label>日期</label><input type="date" name="date" value="{m.get('date','')}"></div>
    </div>
    <div><label style="margin-top:12px">置顶推荐（勾选后出现在首页顶部轮播）</label></div>
    <div class="grid2">
      <div><label style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" name="pinned" value="1" style="width:auto"{" checked" if m.get('pinned') else ""}> 置顶推荐
      </label></div>
      <div><label>置顶顺序（1 在最前，留空自动排到最后）</label><input type="number" min="1" name="pinOrder" value="{m.get('pinOrder','')}"></div>
      <div><label>置顶到期日（留空=长期有效，到期自动从轮播撤下）</label><input type="date" name="pinUntil" value="{m.get('pinUntil','')}"></div>
    </div>
    <div><label style="margin-top:12px">🔒 隐藏这套图（列表里只显示模糊封面、点不进去；输入密码才看得到）</label></div>
    <div class="grid2">
      <div><label style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" name="hidden" value="1" style="width:auto"{" checked" if m.get('hidden') else ""}> 隐藏这套图
      </label></div>
      <div><label>单套密码（留空＝用全局密码；填了这套就用它）</label><input type="text" name="hidePassword" value="{m.get('hidePassword','')}" placeholder="{('当前全局密码已设置' if hidden_pw() else '⚠️ 还没设置全局密码，先去首页「🔒 隐藏套图」里设一个')}"></div>
    </div>
    {hid_url_html}
    <div><label style="margin-top:12px">模特资料（选填 · 填了才在详情页展示 · AI 不会自动生成这些）</label></div>
    <div class="grid2">
      <div><label>出生</label><input type="text" name="p_birth" value="{pf.get('birth','')}" placeholder="如 1998"></div>
      <div><label>星座</label><input type="text" name="p_sign" value="{pf.get('sign','')}" placeholder="如 巨蟹座"></div>
      <div><label>常驻</label><input type="text" name="p_city" value="{pf.get('city','')}" placeholder="如 广东深圳"></div>
      <div><label>身高</label><input type="text" name="p_height" value="{pf.get('height','')}" placeholder="如 168cm"></div>
      <div><label>体重</label><input type="text" name="p_weight" value="{pf.get('weight','')}" placeholder="如 45kg"></div>
      <div><label>三围</label><input type="text" name="p_measure" value="{pf.get('measure','')}" placeholder="如 86-60-88"></div>
      <div><label>鞋码</label><input type="text" name="p_shoes" value="{pf.get('shoes','')}" placeholder="如 37"></div>
      <div><label>风格</label><input type="text" name="p_style" value="{pf.get('style','')}" placeholder="如 清纯甜美"></div>
      <div><label>微博</label><input type="text" name="p_weibo" value="{pf.get('weibo','')}" placeholder="如 @许岚LAN"></div>
      <div><label>抖音</label><input type="text" name="p_douyin" value="{pf.get('douyin','')}" placeholder="如 许岚lan"></div>
      <div><label>B站</label><input type="text" name="p_bilibili" value="{pf.get('bilibili','')}" placeholder="选填"></div>
      <div><label>小红书</label><input type="text" name="p_xhs" value="{pf.get('xhs','')}" placeholder="选填"></div>
      <div><label>其他（籍贯/特长等）</label><input type="text" name="p_other" value="{pf.get('other','')}" placeholder="选填"></div>
    </div>
    <div><label style="margin-top:12px">图集简介（选填 · 不填则不显示）</label><textarea name="description" rows="2" placeholder="留空即不展示（推荐留空，让访客直接看图）">{m.get('description','')}</textarea></div>
  <div class="row" style="margin-top:10px">
    <button type="button" class="btn ghost sm" onclick="detectRes('{slug}')">📐 重新检测图片像素</button>
    <span class="sub" style="margin:0">{_res_hint}</span>
  </div>
  <div class="row" style="margin-top:10px">
    <button type="button" class="btn ghost sm" onclick="autotag('{slug}',true)">🤖 自动打标（AI 分析样图）</button>
    <span class="sub" style="margin:0">{f'上次 AI 标签（{m.get("autoTaggedAt","")}）：' + "、".join(m.get("autoTags", [])) if m.get("autoTags") else "尚未自动打标 · 点左侧按钮由视觉模型生成标签与描述"}</span>
  </div>
  <div class="row"><label style="margin:0">追加图片（可多选，会附加到末尾）</label><input type="file" name="images" accept="image/*" multiple></div>
  <div class="row"><label style="margin:0">替换压缩包 pack.zip</label><input type="file" name="pack" accept=".zip"></div>
  <div class="row"><button class="btn" type="submit">保存并重建站点</button>
    <a class="btn ghost" href="http://127.0.0.1:8090/{('h/' + hidden_token(slug, m.get('hidePassword') or hidden_pw())) if (m.get('hidden') and (m.get('hidePassword') or hidden_pw())) else ('set/' + quote(slug))}/index.html" target="_blank">打开详情页 ↗</a></div>
</form>

<div class="panel"><h2>② 图片管理（{len(imgs)} 张）</h2>
  <p class="sub">蓝框 = 当前封面 · 点「设为封面」重设封面 · <b>拖动卡片可调整顺序</b>（改完点「保存顺序」）· 删除会同时移除缩略图
    {f'· ⚠️ 检测到 {dupes} 张重复图片，建议清理' if dupes else ''}</p>
  <div class="row" style="margin:0 0 12px">
    <button class="btn sm" onclick="saveOrder('{slug}')">💾 保存顺序</button>
    <button class="btn ghost sm" onclick="resetOrder()">↺ 还原</button>
    <button class="btn ghost sm" onclick="dedupe('{slug}')">清理重复图片</button>
    <button class="btn ghost sm" onclick="openCropper(this.dataset.slug)" data-slug="{esc_attr(slug)}">✂ 裁剪封面</button>
    <button class="btn ghost sm" onclick="openBannerCropper(this.dataset.slug)" data-slug="{esc_attr(slug)}">🖼 裁剪首页大图</button>
    <span class="sub" style="margin:0">按文件内容比对，保留每组的第一张（新上传已自动去重）</span>
  </div>
  <div class="sub" style="margin:-6px 0 10px">封面/大图都从本套图里选一张裁剪：封面 3:4（800×1067，列表卡片用）；首页大图 32:9（1600×450，<b>只有置顶图集</b>会出现在首页顶部轮播里）。点按钮后在弹层里换图、拖拽选区；大图弹层下半部分的暗色区域＝首页标题文字压住的位置，重要内容别放那儿。</div>
  <div class="thumbs" id="thumbs">{thumbs or '<p class="sub">暂无图片</p>'}</div>
</div>"""
    if msg:
        body += f'<script>window.addEventListener("load",()=>toast({json.dumps(msg, ensure_ascii=False)},true))</script>'
    return page(f'编辑 {slug}', body)


# ───────────────────────── 请求处理 ─────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = 'SetAdmin/2.0'

    def log_message(self, fmt, *args):
        sys.stderr.write('[admin] ' + fmt % args + '\n')

    def _authed(self):
        """简单口令校验（ADMIN_PASSWORD 为空时不校验；仅本机使用时可不设）"""
        if not ADMIN_PASSWORD:
            return True
        from http.cookies import SimpleCookie
        c = SimpleCookie(self.headers.get('Cookie', ''))
        return bool(c.get('dsh_admin')) and c['dsh_admin'].value == ADMIN_PASSWORD

    def _deny(self):
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="img-site-admin"')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _send(self, code, body: bytes, ctype='text/html; charset=utf-8'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        # 后台是本地工具，页面/接口一律不缓存：否则改了代码浏览器还在跑旧页面
        # （曾导致「按钮点了没反应」——页面里还是修复前的坏脚本）
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.end_headers()
        self.wfile.write(body)

    def _text(self, s, code=200):
        self._send(code, s.encode('utf-8'), 'text/plain; charset=utf-8')

    def _html(self, s, code=200):
        self._send(code, s.encode('utf-8'))

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode('utf-8'),
                   'application/json; charset=utf-8')

    def _json_body(self):
        n = int(self.headers.get('Content-Length', 0))
        try:
            from urllib.parse import unquote
            return json.loads(unquote(self.rfile.read(n).decode('utf-8')))
        except Exception:
            return {}

    @staticmethod
    def _form_get(form, key, default=''):
        """安全取表单字段：字段重复提交时 cgi 返回 list，这里统一取第一个值"""
        v = form.getvalue(key)
        if v is None:
            return default
        if isinstance(v, list):
            v = v[0] if v else default
        try:
            return str(v).strip()
        except Exception:
            return default

    def _serve_file(self, rel):
        p = os.path.normpath(os.path.join(SETS_DIR, rel))
        if not p.startswith(SETS_DIR) or not os.path.isfile(p):
            return self._text('not found', 404)
        return self._serve_abs(p)

    def _serve_abs(self, p):
        """发送任意本地图片文件（头像在 models/ 下，不在 sets/ 里）"""
        if not os.path.isfile(p):
            return self._text('not found', 404)
        ext = os.path.splitext(p)[1].lower()
        ctype = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif'}.get(ext, 'application/octet-stream')
        with open(p, 'rb') as f:
            self._send(200, f.read(), ctype)

    def do_GET(self):
        if not self._authed():
            return self._deny()
        u = urlparse(self.path)
        if u.path in ('/', '/index.html'):
            from urllib.parse import parse_qs, unquote as _unq
            qs = parse_qs(u.query or '')
            g = lambda k, d='': (_unq(qs.get(k, [d])[0]) if qs.get(k) else d)
            return self._html(home_page(
                q=g('q'),
                page_no=g('page', '1'),
                per=g('per', '24'),
                sort=g('sort', 'date-desc'),
                view=g('view', 'card'),
            ))
        if u.path == '/edit':
            qs = dict(p.split('=', 1) for p in u.query.split('&') if '=' in p)
            from urllib.parse import unquote
            return self._html(edit_page(unquote(qs.get('slug', ''))))
        if u.path == '/tags':
            return self._html(tags_page())
        if u.path == '/links':
            return self._html(links_page())
        if u.path == '/rename':
            return self._html(rename_page())
        if u.path == '/batch':
            return self._html(batch_page())
        if u.path == '/models':
            return self._html(models_page())
        if u.path == '/publish/status':
            return self._json(publish_status())
        if u.path == '/autotag-status':
            return self._json(autotag_status())
        if u.path == '/setimages':
            # 给"头像裁剪"用：列出一套图里的全部图片 + 可直接显示的缩略图地址
            from urllib.parse import parse_qs, unquote as _unq
            qs = parse_qs(u.query or '')
            slug = _unq((qs.get('slug') or [''])[0])
            d = os.path.join(SETS_DIR, slug)
            if not os.path.isdir(d):
                return self._text('图集不存在', 404)
            items = []
            for f in set_images(d):
                base = os.path.splitext(f)[0]
                thumb = ''
                for ext in ('.webp', '.jpg'):
                    if os.path.exists(os.path.join(d, 'thumbs', base + ext)):
                        thumb = f'/preview/{quote(slug)}/thumbs/{quote(base + ext)}'
                        break
                # 原图像素：裁剪时用它在"原图坐标"与"预览图坐标"之间换算
                # 只读文件头（Image.open 是惰性的）——这里千万别 exif_transpose：那会把每张图整张解码，
                # 48 张 4000×6000 的图要几十秒，裁剪弹层会一直转圈打不开
                w = h = 0
                try:
                    with Image.open(os.path.join(d, 'images', f)) as im:
                        w, h = im.size
                        try:
                            orient = (im.getexif() or {}).get(274)
                        except Exception:  # noqa
                            orient = None
                        if orient in (5, 6, 7, 8):   # 竖拍旋转 90°：裁剪切图会摆正，宽高要对调
                            w, h = h, w
                except Exception:  # noqa
                    pass
                items.append({'img': f, 'thumb': thumb or f'/preview/{quote(slug)}/images/{quote(f)}', 'w': w, 'h': h})
            return self._json({'slug': slug, 'count': len(items), 'images': items})
        if u.path.startswith('/avatar/'):
            # 后台预览模特头像（models/avatar/<名>.jpg|webp）
            from urllib.parse import unquote as _unq2
            name = _unq2(u.path[len('/avatar/'):])
            p = avatar_path(name)
            if not p:
                return self._text('该模特还没有自定义头像', 404)
            return self._serve_abs(p)
        if u.path.startswith('/preview/'):
            from urllib.parse import unquote
            return self._serve_file(unquote(u.path[len('/preview/'):]))
        self._text('not found', 404)

    def do_POST(self):
        # 全局兜底：任何未预期异常都要变成一句人能看懂的话（否则异常会掐断连接，
        # 前端 fetch 拿不到响应、页面上什么都不显示 —— 之前「删除图集点了没反应」就是这个）
        t0 = time.time()
        try:
            r = self._do_post()
            cost = time.time() - t0
            if cost > 2:                      # 慢操作记一笔，方便排查"卡住"
                log_line('admin', f'POST {self.path} 用时 {cost:.1f}s 长度 {self.headers.get("Content-Length", "?")}')
            return r
        except Exception as e:  # noqa
            import traceback
            tb = traceback.format_exc()
            traceback.print_exc()
            log_line('error', f'POST {self.path} 出错：{type(e).__name__}: {e}\n{tb}')
            try:
                self._text('✗ 后台执行出错：%s: %s' % (type(e).__name__, e), 500)
            except Exception:  # noqa
                pass

    def _do_post(self):
        if not self._authed():
            return self._deny()
        u = urlparse(self.path)
        if u.path == '/upload':
            return self.handle_upload()
        if u.path == '/save':
            return self.handle_save()
        if u.path == '/links':
            return self.handle_links()
        if u.path == '/delete':
            d = self._json_body()
            ok, msg = delete_set(d.get('slug', ''))
            if not ok:
                return self._text('✗ ' + msg, 400)
            okb, out = rebuild()
            first = next((l for l in (out or '').splitlines() if l.strip()), '')
            return self._text(msg + '\n' + ('  ✓ 站点已重建：' + first if okb else '  ✗ 站点重建失败：' + (out or '')[:200]))
        if u.path == '/purge-trash':
            ok, msg = purge_trash()
            return self._text(('✓ ' if ok else '✗ ') + msg, 200 if ok else 400)
        if u.path == '/setcover':
            d = self._json_body()
            slug, img = d.get('slug', ''), d.get('img', '')
            src = os.path.join(SETS_DIR, slug, 'images', img)
            if os.path.isfile(src):
                set_dir = os.path.join(SETS_DIR, slug)
                make_thumb(open(src, 'rb').read(), os.path.join(set_dir, 'cover.jpg'), COVER_W, 88, box=(COVER_W, COVER_H))
                make_thumb(open(src, 'rb').read(), os.path.join(set_dir, 'thumbs', 'cover.jpg'), 640, 88, box=(640, 854))
                ok, out = rebuild()
                return self._text(f'封面已更新为 {img}（{out.splitlines()[0] if out else ""}）')
            return self._text('图片不存在', 404)
        if u.path == '/deleteimage':
            d = self._json_body()
            slug, img = d.get('slug', ''), d.get('img', '')
            set_dir = os.path.join(SETS_DIR, slug)
            src = os.path.join(set_dir, 'images', img)
            if os.path.isfile(src):
                os.remove(src)
                for extra in (os.path.join(set_dir, 'thumbs', os.path.splitext(img)[0] + '.jpg'),
                              os.path.join(set_dir, 'thumbs', os.path.splitext(img)[0] + '.lqip.jpg')):
                    if os.path.exists(extra):
                        os.remove(extra)
                meta = read_meta(set_dir)
                meta['imageCount'] = len(set_images(set_dir))
                save_meta(set_dir, meta)
                ok, out = rebuild()
                return self._text(f'已删除 {img}，剩余 {meta["imageCount"]} 张')
            return self._text('图片不存在', 404)
        if u.path == '/detectres':
            d = self._json_body()
            slug = d.get('slug', '')
            set_dir = os.path.join(SETS_DIR, slug)
            if not os.path.isdir(set_dir):
                return self._text('图集不存在', 404)
            txt, info = detect_resolution(set_dir)
            meta = read_meta(set_dir)
            meta['resolution'] = txt.split('（')[0]
            meta['resolutionInfo'] = info
            save_meta(set_dir, meta)
            ok, out = rebuild()
            return self._text(f'📐 检测完成：{txt}\n共 {info["count"]} 张，{info["distinct"]} 种尺寸')
        if u.path == '/detectres-all':
            n = 0
            for s in list_sets():
                set_dir = os.path.join(SETS_DIR, s['slug'])
                txt, info = detect_resolution(set_dir)
                if not txt:
                    continue
                meta = read_meta(set_dir)
                meta['resolution'] = txt.split('（')[0]
                meta['resolutionInfo'] = info
                save_meta(set_dir, meta)
                n += 1
            ok, out = rebuild()
            return self._text(f'已为 {n} 套图集自动检测像素')
        if u.path == '/autotag':
            d = self._json_body()
            slug = d.get('slug', '')
            set_dir = os.path.join(SETS_DIR, slug)
            if not os.path.isdir(set_dir):
                return self._text('图集不存在', 404)
            try:
                n, info, _ = autotag_set(set_dir, samples=int(d.get('samples', 3)), force=bool(d.get('force')))
                if n:
                    after_tagging(n)          # 重建站点 +（默认）自动同步到线上，页面立刻能看到新标签
                return self._text(f'🤖 自动打标完成：{n} 个标签\n{info}\n（已在站点上生效，可继续在编辑页手动调整）' if n else f'跳过：{info}')
            except Exception as e:  # noqa
                return self._text(f'自动打标失败：{e}', 500)
        if u.path == '/autotag-all':
            done, skipped, failed, log = 0, 0, 0, []
            for s in list_sets():
                sd = os.path.join(SETS_DIR, s['slug'])
                if (s['meta'].get('tags') or []) and s['meta'].get('autoTags'):
                    skipped += 1; continue
                try:
                    n, info, _ = autotag_set(sd, samples=3)
                    if n:
                        done += 1; log.append(f'{s["slug"]}: {info[:40]}')
                    else:
                        skipped += 1
                    time.sleep(1.5)          # 控制频率，避免触发限流
                except Exception as e:  # noqa
                    failed += 1; log.append(f'{s["slug"]}: 失败 {e}')
            after_tagging(done)
            return self._text(f'批量打标：成功 {done} 套，跳过 {skipped} 套，失败 {failed} 套\n' + '\n'.join(log[:20]))
        if u.path == '/bulk':
            d = self._json_body()
            action = d.get('action', '')
            slugs = [s for s in (d.get('slugs') or []) if s and os.path.isdir(os.path.join(SETS_DIR, s))]
            if not slugs:
                return self._text('没有有效的图集', 400)
            done, failed = [], []
            for slug in slugs:
                sd = os.path.join(SETS_DIR, slug)
                try:
                    if action == 'delete':
                        shutil.rmtree(sd); done.append(slug); continue
                    meta = read_meta(sd)
                    if action == 'setSeries':
                        meta['series'] = d.get('value', '')
                    elif action == 'addTags':
                        new = [t.strip() for t in re.split(r'[,，]', d.get('value', '')) if t.strip()]
                        meta['tags'] = list(dict.fromkeys(list(meta.get('tags') or []) + new))
                    elif action == 'autotag':
                        autotag_set(sd, samples=3)
                        time.sleep(1.2)
                    else:
                        return self._text('未知操作', 400)
                    save_meta(sd, meta)
                    done.append(slug)
                except Exception as e:  # noqa
                    failed.append(f'{slug}: {e}')
            ok, out = rebuild()
            return self._text(f'批量{action} 完成：成功 {len(done)} 套'
                              + (f'，失败 {len(failed)}：' + '; '.join(failed[:3]) if failed else '')
                              + '\n' + out.splitlines()[0] if out else f'批量{action} 完成')
        if u.path == '/tagmerge':
            d = self._json_body()
            froms = [str(t).strip() for t in (d.get('from') or []) if str(t).strip()]
            to = str(d.get('to') or '').strip()
            if not froms:
                return self._text('没有要处理的标签', 400)
            changed = 0
            for s in list_sets():
                sd = os.path.join(SETS_DIR, s['slug'])
                meta = read_meta(sd)
                tags = list(meta.get('tags') or [])
                if not any(t in froms for t in tags):
                    continue                     # 只有含旧标签的图集才处理
                new = [t for t in tags if t not in froms]
                if to and to not in new:
                    new.append(to)
                if new != tags:
                    meta['tags'] = new
                    save_meta(sd, meta)
                    changed += 1
            ok, out = rebuild()
            act = f'合并为「{to}」' if to else '删除'
            return self._text(f'✓ 标签{act}完成：{len(froms)} 个标签，更新 {changed} 套图集')
        if u.path == '/cropcover':
            d = self._json_body()
            slug, img = d.get('slug', ''), d.get('img', '')
            set_dir = os.path.join(SETS_DIR, slug)
            src = os.path.join(set_dir, 'images', img)
            if not os.path.isfile(src):
                return self._text('图片不存在', 404)
            try:
                box = (int(d['x']), int(d['y']), int(d['x']) + int(d['w']), int(d['y']) + int(d['h']))
            except Exception:
                return self._text('裁剪参数错误', 400)
            im = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
            W, H = im.size
            # 边界收敛
            x1 = max(0, min(W - 1, box[0])); y1 = max(0, min(H - 1, box[1]))
            x2 = max(x1 + 10, min(W, box[2])); y2 = max(y1 + 10, min(H, box[3]))
            crop = im.crop((x1, y1, x2, y2)).resize((COVER_W, COVER_H), Image.LANCZOS)
            crop.save(os.path.join(set_dir, 'cover.jpg'), 'JPEG', quality=90, optimize=True, progressive=True)
            thumb = crop.copy(); thumb.thumbnail((640, 854), Image.LANCZOS)
            thumb.save(os.path.join(set_dir, 'thumbs', 'cover.jpg'), 'JPEG', quality=88)
            if WEBP_ENABLED:
                try:
                    thumb.save(os.path.join(set_dir, 'thumbs', 'cover.webp'), 'WEBP', quality=WEBP_Q, method=6)
                except Exception:
                    pass
            ok, out = rebuild()
            return self._text(f'✓ 封面已按自定义区域裁剪（{x2 - x1}×{y2 - y1} → {COVER_W}×{COVER_H}）\n重建：' + ('成功' if ok else '失败'))
        if u.path == '/rename-preview':
            d = self._json_body()
            slugs = [str(x) for x in (d.get('slugs') or [])]
            rules = d.get('rules') or {}
            rows = []
            for s in list_sets():
                if slugs and s['slug'] not in slugs:
                    continue
                old = str(s['meta'].get('title') or s['slug'])
                rows.append({'slug': s['slug'], 'old': old, 'new': apply_title_rules(old, rules),
                             'hidden': bool(s['meta'].get('hidden')),
                             'model': (s['meta'].get('model') or ''), 'series': (s['meta'].get('series') or '')})
            return self._json({'count': len(rows), 'rows': rows})
        if u.path == '/rename-apply':
            d = self._json_body()
            items = d.get('items') or []
            if not items:
                return self._text('没有要改的内容（先点「预览」）', 400)
            changed, skipped, moves, slugmap = batch_rename(items, bool(d.get('renameDirs')))
            ok, out = rebuild()
            msg = [f'✓ 已更新 {changed} 套标题']
            if moves:
                msg.append(f'  目录改名 {len(moves)} 个：' + '；'.join(moves[:5]) + ('…' if len(moves) > 5 else ''))
                msg.append('  ⚠️ 目录变了 → 隐藏套图的分享链接需要重新复制（编辑页里能看新地址）')
            if skipped:
                msg.append(f'  跳过 {len(skipped)} 套：' + '；'.join(skipped[:5]))
            msg.append('重建：' + ('成功' if ok else '失败'))
            return self._text('\n'.join(msg))
        if u.path == '/cropbanner':
            d = self._json_body()
            slug, img = d.get('slug', ''), d.get('img', '')
            try:
                box = (int(d['x']), int(d['y']), int(d['x']) + int(d['w']), int(d['y']) + int(d['h']))
            except Exception:
                return self._text('裁剪参数错误', 400)
            ok, m = save_banner(slug, img, box)
            if not ok:
                return self._text(m, 404)
            ok2, out = rebuild()
            return self._text(m + '\n重建：' + ('成功' if ok2 else '失败'))
        if u.path == '/cropavatar':
            d = self._json_body()
            model, slug, img = d.get('model', ''), d.get('slug', ''), d.get('img', '')
            if not model:
                return self._text('缺少模特名', 400)
            try:
                box = (int(d['x']), int(d['y']), int(d['x']) + int(d['w']), int(d['y']) + int(d['h']))
            except Exception:
                return self._text('裁剪参数错误', 400)
            ok, m = save_avatar(model, slug, img, box)
            if not ok:
                return self._text(m, 404)
            ok2, out = rebuild()
            return self._text(m + '\n重建：' + ('成功' if ok2 else '失败'))
        if u.path == '/clearavatar':
            d = self._json_body()
            n = clear_avatar(d.get('model', ''))
            ok, out = rebuild()
            return self._text(('✓ 已清除自定义头像（退回用封面）' if n or True else '') + f'（删除 {n} 个文件）\n重建：' + ('成功' if ok else '失败'))
        if u.path == '/clearbanner':
            d = self._json_body()
            n = clear_banner(d.get('slug', ''))
            ok, out = rebuild()
            return self._text(f'✓ 已清除自定义 Banner（退回用封面）（删除 {n} 个文件）\n重建：' + ('成功' if ok else '失败'))
        if u.path == '/hidden':
            # 全局隐藏密码 / 提示语（存 .hidden.json，已 gitignore）；改完必须重建（地址随密码变）
            d = self._json_body()
            cfg = read_hidden_cfg() or {}
            cfg['password'] = str(d.get('password') or '').strip()
            if d.get('hint'):
                cfg['hint'] = str(d['hint']).strip()
            else:
                cfg.pop('hint', None)
            write_hidden_cfg(cfg)
            n = sum(1 for s in list_sets() if s['meta'].get('hidden'))
            ok, out = rebuild()
            return self._text((f'✓ 全局密码已{"设置" if cfg["password"] else "清空（隐藏功能关闭）"}'
                               + (f'，{n} 套隐藏图集的访问地址已重新生成' if n else ''))
                              + '\n重建：' + ('成功' if ok else '失败'))
        if u.path == '/sethidden':
            d = self._json_body()
            ok, m, token = set_hidden(d.get('slug', ''), bool(d.get('hidden')),
                                      d.get('password') if 'password' in d else None)
            if not ok:
                return self._text(m, 400)
            ok2, out = rebuild()
            return self._text(m + (f'\n访问地址：/h/{token}/' if token else '')
                              + '\n重建：' + ('成功' if ok2 else '失败'))
        if u.path == '/reorder':
            d = self._json_body()
            slug = d.get('slug', '')
            order = [f for f in (d.get('order') or []) if f]
            set_dir = os.path.join(SETS_DIR, slug)
            if not os.path.isdir(set_dir) or not order:
                return self._text('参数错误', 400)
            existing = set_images(set_dir)
            if sorted(existing) != sorted(order):
                return self._text('图片列表不一致，请刷新页面重试', 400)
            img_dir, thumb_dir = os.path.join(set_dir, 'images'), os.path.join(set_dir, 'thumbs')
            # 两阶段改名，避免相互覆盖
            tmpmap = []
            for i, old in enumerate(order, 1):
                ext = os.path.splitext(old)[1]
                tmp = f'__tmp{i:03d}{ext}'
                os.rename(os.path.join(img_dir, old), os.path.join(img_dir, tmp))
                base_old = os.path.splitext(old)[0]
                for suf in ('.jpg', '.lqip.jpg', '.webp'):
                    src = os.path.join(thumb_dir, base_old + suf)
                    if os.path.exists(src):
                        os.rename(src, os.path.join(thumb_dir, f'__tmp{i:03d}{suf}'))
                tmpmap.append((i, tmp, ext))
            renamed = 0
            for i, tmp, ext in tmpmap:
                new = f'{i:02d}{ext}'
                os.rename(os.path.join(img_dir, tmp), os.path.join(img_dir, new))
                for suf in ('.jpg', '.lqip.jpg', '.webp'):
                    src = os.path.join(thumb_dir, f'__tmp{i:03d}{suf}')
                    if os.path.exists(src):
                        os.rename(src, os.path.join(thumb_dir, f'{i:02d}{suf}'))
                renamed += 1
            meta = read_meta(set_dir)
            meta['imageCount'] = len(set_images(set_dir))
            save_meta(set_dir, meta)
            ok, out = rebuild()
            return self._text(f'✓ 顺序已保存：{renamed} 张重排完成\n重建：' + ('成功' if ok else '失败'))
        if u.path == '/dedupe':
            d = self._json_body()
            slug = d.get('slug', '')
            set_dir = os.path.join(SETS_DIR, slug)
            if os.path.isdir(set_dir):
                n = dedupe_set(set_dir)
                ensure_thumbs(set_dir)
                ok, out = rebuild()
                return self._text(f'已清理 {n} 张重复图片' if n else '没有发现重复图片')
            return self._text('图集不存在', 404)
        if u.path == '/healthcheck':
            return self._text(health_check())
        if u.path == '/dupcheck':
            groups = {}
            for s in list_sets():
                sig = set_signature(os.path.join(SETS_DIR, s['slug']))
                if sig:
                    groups.setdefault(sig, []).append(s['slug'])
            dups = {k: v for k, v in groups.items() if len(v) > 1}
            if not dups:
                return self._text(f'✅ 检查了 {len(groups)} 套图集，没有内容重复的')
            lines = [f'发现 {len(dups)} 组内容重复的图集（共 {sum(len(v) for v in dups.values())} 套）：', '']
            for v in dups.values():
                lines.append('  · ' + '  ==  '.join(v))
            lines.append('')
            lines.append('建议：保留信息更全的那套（标签/资料），删掉多余的（列表卡片右下角「删除」）')
            return self._text('\n'.join(lines))
        if u.path == '/rebuild':
            ok, out = rebuild()
            return self._text(out)
        if u.path == '/publish':
            started, msg = publish_start()
            return self._json({'started': started, 'msg': msg}, 200 if started else 409)
        if u.path == '/autotag-batch':
            d = self._json_body()
            started, msg = autotag_batch_start(force=bool(d.get('force')), limit=int(d.get('limit') or 0))
            return self._json({'started': started, 'msg': msg}, 200 if started else 409)
        if u.path == '/pin':
            d = self._json_body()
            ok, msg = set_pin(d.get('slug'), d.get('pinned'),
                              d.get('order'), d.get('until', None) if 'until' in d else None)
            if not ok:
                return self._text('✗ ' + msg, 400)
            okb, out = rebuild_wait()
            first = next((l for l in (out or '').splitlines() if l.strip()), '')
            msg += '\n  ' + ('✓ 站点已重建：' + first if okb else '✗ 重建失败：' + (out or '')[:160])
            if okb and TAG_AUTOPUBLISH:
                started, pmsg = publish_start()
                msg += '\n  🚀 ' + pmsg
            return self._text(msg)
        if u.path == '/model-rename':
            d = self._json_body()
            ok, msg = rename_model(d.get('from', ''), d.get('to', ''))
            if not ok:
                return self._text('✗ ' + msg, 400)
            okb, out = rebuild()
            first = next((l for l in (out or '').splitlines() if l.strip()), '')
            return self._text(msg + '\n' + ('  ✓ 站点已重建：' + first if okb else '  ✗ 站点重建失败：' + (out or '')[:160]))
        if u.path == '/models':
            d = self._json_body()
            model = (d.get('model') or '').strip()
            if not model:
                return self._text('缺少模特名', 400)
            prof = {k: str(v).strip() for k, v in (d.get('profile') or {}).items() if str(v).strip()}
            write_model_profile(model, prof)
            ok, out = rebuild()
            n = sum(1 for s in list_sets() if (s['meta'].get('model') or '').strip() == model)
            first = next((l for l in (out or '').splitlines() if l.strip()), '')
            return self._text(f'✓ 「{model}」资料已保存（{len(prof)} 个字段），影响 {n} 套图集\n'
                              f'  {"站点已重建：" + first if ok else "站点重建失败：" + (out or "")[:160]}')
        if u.path == '/backfill':
            total = 0
            for s in list_sets():
                total += ensure_thumbs(os.path.join(SETS_DIR, s['slug']))
            ok, out = rebuild()
            return self._text(f'补齐缩略图 {total} 张\n{out}')
        self._text('not found', 404)

    # ── 上传 ──
    def handle_links(self):
        """网盘链接批量导入：解析粘贴内容 → 匹配图集 → 预览或应用"""
        d = self._json_body()
        text = d.get('text', '')
        default_netdisk = (d.get('defaultNetdisk') or '').strip()
        only_empty = bool(d.get('onlyEmpty'))
        apply = bool(d.get('apply'))

        sets = list_sets()
        lines = parse_link_lines(text, default_netdisk)
        rows, applied = [], 0
        for it in lines:
            s, status = match_set(it['keyword'], sets)
            row = {'keyword': it['keyword'], 'netdisk': it['netdisk'], 'url': it['url'],
                   'code': it['code'], 'status': 'ok' if s else 'bad', 'msg': ''}
            if not s:
                row['msg'] = status
                rows.append(row)
                continue
            m = s['meta']
            row['title'] = m.get('title') or s['slug']
            if only_empty and m.get('downloadUrl'):
                row['status'] = 'skip'
                row['msg'] = '已有链接（跳过）'
                rows.append(row)
                continue
            if not it['url']:
                row['status'] = 'bad'
                row['msg'] = '没解析到链接'
                rows.append(row)
                continue
            if apply:
                set_dir = os.path.join(SETS_DIR, s['slug'])
                meta = read_meta(set_dir)
                if it['netdisk']:
                    meta['netdisk'] = it['netdisk']
                meta['downloadUrl'] = it['url']
                if it['code']:
                    meta['shareCode'] = it['code']
                save_meta(set_dir, meta)
                applied += 1
                row['msg'] = '✓ 已写入'
            else:
                row['msg'] = '可导入'
            rows.append(row)

        if apply and applied:
            ok, out = rebuild()
            tail = next((l for l in (out or '').splitlines() if l.strip()), '')
            summary = f'已应用 {applied} 套{"（站点已重建：" + tail + "）" if ok else "（站点重建失败）"}'
        else:
            good = len([r for r in rows if r['status'] == 'ok'])
            summary = f'共 {len(rows)} 行：可导入 {good} 套，未匹配 {len([r for r in rows if r["status"] == "bad"])} 行'
        return self._json({'rows': rows, 'summary': summary, 'applied': applied})

    def handle_upload(self):
        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers,
                                environ={'REQUEST_METHOD': 'POST', 'CONTENT_TYPE': self.headers.get('Content-Type', '')})
        g = lambda k, d='': self._form_get(form, k, d)
        title = g('title')
        if not title:
            return self._text('标题必填', 400)
        files = form['images'] if 'images' in form else []
        if not isinstance(files, list):
            files = [files]
        files = [f for f in files if getattr(f, 'filename', '')]
        if not files:
            return self._text('请至少上传一张图片', 400)

        d = g('date') or date.today().isoformat()
        custom_slug = (g('slug') or '').strip()
        slug = custom_slug or f'{d}-{slugify(title)}'
        # 同名同日期：自动加 -2 / -3 … 变成两套独立图集
        # （原来会直接合并进同一个目录：第二套的图片被追加到第一套里、标题被覆盖 —— 很难发现）
        renamed_from = ''
        if not custom_slug:
            uniq = unique_slug(slug, g('model'), g('series'))
            if uniq != slug:
                renamed_from, slug = slug, uniq
        set_dir = os.path.join(SETS_DIR, slug)
        img_dir, thumb_dir = os.path.join(set_dir, 'images'), os.path.join(set_dir, 'thumbs')
        os.makedirs(img_dir, exist_ok=True)
        os.makedirs(thumb_dir, exist_ok=True)

        saved, errors, dup = [], [], 0
        existing = image_hashes(set_dir)
        start = len(set_images(set_dir))
        # ① 先顺序落盘 + 内容去重（I/O 很快，且避免把几十张原图同时读进内存）
        for i, f in enumerate(files, start + 1):
            raw = f.file.read()
            ext = (os.path.splitext(f.filename)[1] or '.jpg').lower()
            if ext not in IMG_EXT:
                errors.append(f'{f.filename}: 不支持的格式'); continue
            h = hashlib.md5(raw).hexdigest()
            if h in existing:
                dup += 1; continue                       # 内容重复 → 跳过（不再重复入库）
            base = f'{start + len(saved) + 1:02d}'
            name = base + ('.jpg' if ext in ('.jpg', '.jpeg') else ext)
            try:
                open(os.path.join(img_dir, name), 'wb').write(raw)
                existing[h] = name
                saved.append(name)
            except Exception as e:  # noqa
                errors.append(f'{f.filename}: {e}')
        # ② 再并发生成缩略图（生成缩略图是主要耗时，多线程能快数倍）
        pairs = [(os.path.join(img_dir, n), os.path.join(thumb_dir, os.path.splitext(n)[0] + '.jpg'))
                 for n in saved]
        n_ok, thumb_errs = thumbs_parallel(pairs)
        errors.extend(thumb_errs)
        if n_ok < len(saved):
            saved = [n for n in saved
                     if os.path.exists(os.path.join(thumb_dir, os.path.splitext(n)[0] + '.jpg'))]
        if not saved:
            # 一张都没新增：要区分「全是重复内容（正常，等于重新导了一次）」和「真的都失败了」
            if dup and not errors:
                if g('norebuild') in ('1', 'on', 'true'):
                    return self._json({'ok': True, 'slug': slug, 'title': title, 'images': 0,
                                       'total': len(set_images(set_dir)), 'dup': dup,
                                       'errors': [], 'unchanged': True})
                ok, out = rebuild()
                return self._html(home_page(
                    f'ℹ️ {slug}：本次没有新增图片 —— {dup} 张与已有内容完全相同（已跳过）\n'
                    f'  该图集现有 {len(set_images(set_dir))} 张\n'
                    f'  编辑：http://127.0.0.1:{PORT}/edit?slug={slug}\n'
                    + '  重建：' + ('成功' if ok else '失败') + '\n' + out))
            return self._text('全部图片处理失败：' + '; '.join(errors), 400)

        cover_src = None
        if 'cover' in form and getattr(form['cover'], 'filename', ''):
            cover_src = form['cover'].file.read()
        elif start == 0:
            cover_src = open(os.path.join(img_dir, saved[0]), 'rb').read()
        cover_info = ''
        if cover_src:
            size = make_thumb(cover_src, os.path.join(set_dir, 'cover.jpg'), COVER_W, 88, box=(COVER_W, COVER_H))
            make_thumb(cover_src, os.path.join(thumb_dir, 'cover.jpg'), 640, 88, box=(640, 854))
            cover_info = f'封面 {size[0]}x{size[1]}'

        if 'pack' in form and getattr(form['pack'], 'filename', ''):
            with open(os.path.join(set_dir, 'pack.zip'), 'wb') as out:
                shutil.copyfileobj(form['pack'].file, out)

        all_imgs = set_images(set_dir)
        meta = read_meta(set_dir)
        # 记录入库时间：同一天发布的图集很多，"最新发布"要能按上传先后排（否则新传的排不到最前）
        # 统一用 UTC，和构建端的 toISOString() 一致 —— 混用本地/UTC 会让排序错乱
        meta.setdefault('addedAt', datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', ''))
        meta.update({
            'title': title, 'series': g('series'), 'date': d, 'model': g('model'),
            'tags': [t.strip() for t in re.split(r'[,，]', g('tags')) if t.strip()],
            'password': g('password'), 'netdisk': g('netdisk'), 'resolution': g('resolution'),
            'description': g('description') or meta.get('description', ''),
            'imageCount': len(all_imgs),
        })
        if g('downloadUrl'):
            meta['downloadUrl'] = g('downloadUrl')
        if g('shareCode'):
            meta['shareCode'] = g('shareCode')
        elif 'shareCode' in meta:
            del meta['shareCode']
        # 图片像素：优先自动检测（手填值仅在没有图片时保留）
        res_txt, res_info = detect_resolution(set_dir)
        if res_txt:
            meta['resolution'] = res_txt.split('（')[0]
            meta['resolutionInfo'] = res_info
        elif g('resolution'):
            meta['resolution'] = g('resolution')
        save_meta(set_dir, meta)
        tag_info = ''
        if g('autotag') in ('1', 'on', 'true'):
            # 不在请求里同步等视觉模型（限流时会挂 1 分钟以上）→ 丢进后台队列，立刻返回
            ok_q, qmsg = autotag_queue_add([slug])
            tag_info = f'  🤖 {qmsg}\n' if ok_q else f'  自动打标未排队：{qmsg}\n'

        # 与全库比对：内容与别的图集完全相同 → 提醒（常见于重复导入同一套图）
        dup_sets = find_duplicate_sets(set_dir, exclude_slug=slug)
        same_title = []
        for s in list_sets():
            if s['slug'] == slug:
                continue
            if (s['meta'].get('title') or '').strip() != title.strip():
                continue
            _tag = s['meta'].get('model') or s['meta'].get('series') or ''
            same_title.append(f'{s["slug"]}（{_tag}）' if _tag else s['slug'])
        dup_warn = ''
        if renamed_from:
            _why = '（用模特名/系列名区分）' if slug != f'{renamed_from}-2' else ''
            dup_warn += (f'ℹ️ 已有同名同日期的图集（目录 {renamed_from}）→ 这套自动存成独立目录 {slug}{_why}\n'
                         f'   两套内容是分开的，各自可单独编辑 / 隐藏 / 设密码。\n')
        if dup_sets:
            dup_warn += (f'⚠️ 这套图集的内容与已有图集完全相同：{", ".join(dup_sets)}\n'
                         f'   如果只是重复导入，可到后台删掉其中一套（列表卡片右下角「删除」）。\n')
        elif same_title:
            dup_warn += (f'ℹ️ 另有同名图集（标题相同、内容不同）：{"、".join(same_title)}\n'
                         f'   同名允许：站上会按模特/系列分别标注、各显示一张卡；批量填网盘链接时用「标题+模特」即可精确指定。\n')

        if g('norebuild') in ('1', 'on', 'true'):
            # 批量导入：不逐套重建（前端在全部完成后统一调一次 /rebuild），直接回 JSON
            return self._json({'ok': True, 'slug': slug, 'title': title,
                               'images': len(saved), 'total': len(all_imgs),
                               'dup': dup, 'errors': errors, 'cover': cover_info,
                               'dup_of': dup_sets, 'same_title': same_title, 'autotag': tag_info.strip()})
        ok, out = rebuild()
        _detail_rel = ('h/' + hidden_token(slug, meta.get('hidePassword') or hidden_pw())) if meta.get('hidden') else ('set/' + slug)
        msg = (f'✓ 上传完成：{slug}\n  本次新增 {len(saved)} 张，共 {len(all_imgs)} 张，{cover_info}\n'
               + (f'  已跳过 {dup} 张重复图片（内容相同）\n' if dup else '')
               + dup_warn
               + tag_info
               + f'  编辑：http://127.0.0.1:{PORT}/edit?slug={slug}\n  详情页：http://127.0.0.1:8090/{_detail_rel}/index.html\n'
               + (f'  警告：{"; ".join(errors)}\n' if errors else '')
               + '  重建：' + ('成功' if ok else '失败') + '\n' + out)
        self._html(home_page(msg))

    # ── 编辑保存 ──
    def handle_save(self):
        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers,
                                environ={'REQUEST_METHOD': 'POST', 'CONTENT_TYPE': self.headers.get('Content-Type', '')})
        g = lambda k, d='': self._form_get(form, k, d)
        slug = g('slug')
        set_dir = os.path.join(SETS_DIR, slug)
        if not slug or not os.path.isdir(set_dir):
            return self._text('图集不存在', 404)

        # 追加图片（自动按内容去重）
        added = dup = 0
        if 'images' in form:
            files = form['images']
            files = files if isinstance(files, list) else [files]
            files = [f for f in files if getattr(f, 'filename', '')]
            existing = image_hashes(set_dir)
            start = len(set_images(set_dir))
            for f in files:
                raw = f.file.read()
                ext = (os.path.splitext(f.filename)[1] or '.jpg').lower()
                if ext not in IMG_EXT:
                    continue
                h = hashlib.md5(raw).hexdigest()
                if h in existing:
                    dup += 1; continue
                base = f'{start + added + 1:02d}'
                name = base + ('.jpg' if ext in ('.jpg', '.jpeg') else ext)
                open(os.path.join(set_dir, 'images', name), 'wb').write(raw)
                make_thumb(raw, os.path.join(set_dir, 'thumbs', base + '.jpg'), PREVIEW_LONG)
                existing[h] = name
                added += 1

        # 替换压缩包
        if 'pack' in form and getattr(form['pack'], 'filename', ''):
            with open(os.path.join(set_dir, 'pack.zip'), 'wb') as out:
                shutil.copyfileobj(form['pack'].file, out)

        meta = read_meta(set_dir)
        meta.update({
            'title': g('title'), 'series': g('series'), 'date': g('date'), 'model': g('model'),
            'tags': [t.strip() for t in re.split(r'[,，]', g('tags')) if t.strip()],
            'password': g('password'), 'netdisk': g('netdisk'), 'resolution': g('resolution'),
            'description': g('description'),
            'profile': {k: v for k, v in {
                'birth': g('p_birth'), 'sign': g('p_sign'), 'city': g('p_city'),
                'height': g('p_height'), 'weight': g('p_weight'),
                'measure': g('p_measure'), 'shoes': g('p_shoes'), 'style': g('p_style'),
                'weibo': g('p_weibo'), 'douyin': g('p_douyin'),
                'bilibili': g('p_bilibili'), 'xhs': g('p_xhs'), 'other': g('p_other'),
            }.items() if v},
            'imageCount': len(set_images(set_dir)),
        })
        if not meta['profile']:
            meta.pop('profile', None)
        if g('downloadUrl'):
            meta['downloadUrl'] = g('downloadUrl')
        elif 'downloadUrl' in meta:
            del meta['downloadUrl']
        if g('shareCode'):
            meta['shareCode'] = g('shareCode')
        elif 'shareCode' in meta:
            del meta['shareCode']
        pc = g('previewCount')
        if pc:
            try:
                meta['previewCount'] = int(pc)
            except ValueError:
                pass
        elif 'previewCount' in meta:
            del meta['previewCount']
        # 置顶推荐：勾选状态 / 顺序 / 到期日
        if g('pinned') in ('1', 'on', 'true'):
            meta['pinned'] = True
            try:
                if g('pinOrder'):
                    meta['pinOrder'] = max(1, int(g('pinOrder')))
            except ValueError:
                pass
            if g('pinUntil'):
                meta['pinUntil'] = g('pinUntil')
            else:
                meta.pop('pinUntil', None)
        else:
            meta.pop('pinned', None)
            meta.pop('pinOrder', None)
            meta.pop('pinUntil', None)
        # 隐藏套图：勾选状态 + 单套密码（可见性由构建时算出的 h/<token>/ 路径决定）
        was_hidden = bool(meta.get('hidden'))
        now_hidden = g('hidden') in ('1', 'on', 'true')
        own_pw = g('hidePassword').strip()
        if now_hidden and not (own_pw or hidden_pw()):
            hidden_warn = '⚠️ 勾了「隐藏」但没有密码：请先在首页「🔒 隐藏套图」面板里设置全局密码，否则构建时会跳过隐藏'
            meta.pop('hidden', None)
        else:
            hidden_warn = ''
            if now_hidden:
                meta['hidden'] = True
            else:
                meta.pop('hidden', None)
        if own_pw:
            meta['hidePassword'] = own_pw
        elif not now_hidden:
            meta.pop('hidePassword', None)
        # 图片像素：自动检测为准（表单留空即自动；手填则作为兜底）
        res_txt, res_info = detect_resolution(set_dir)
        if res_txt:
            meta['resolution'] = res_txt.split('（')[0]
            meta['resolutionInfo'] = res_info
        elif g('resolution'):
            meta['resolution'] = g('resolution')
        save_meta(set_dir, meta)
        if now_hidden:
            try:
                make_blur(set_dir)
            except Exception as e:  # noqa
                log_line('error', f'生成模糊封面失败 {slug}: {e}')

        ensure_thumbs(set_dir)
        ok, out = rebuild()
        msg = (f'✓ 已保存：{meta["title"]}（{meta["imageCount"]} 张'
               + (f'，新增 {added} 张' if added else '')
               + (f'，跳过 {dup} 张重复' if dup else '')
               + (f'，已{"隐藏" if now_hidden else "取消隐藏"}' if was_hidden != now_hidden else '')
               + '）' + (f'\n{hidden_warn}' if hidden_warn else '')
               + '\n重建：' + ('成功' if ok else '失败') + '\n' + out)
        return self._html(edit_page(slug, msg))


def main():
    os.makedirs(SETS_DIR, exist_ok=True)
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'[admin] 图集管理后台已启动：http://127.0.0.1:{PORT}')
    print(f'[admin] 图集目录：{SETS_DIR}')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n[admin] 已停止')


if __name__ == '__main__':
    main()
