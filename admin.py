#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
图集上传/管理后台（本地运行，零额外依赖：Python 3.10 + Pillow）

启动：  python admin.py            → http://127.0.0.1:8091
能力：
  · 上传多张图片 → 自动生成缩略图（1080px，详情页预览）+ LQIP 模糊占位图（20px）
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
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from urllib.parse import urlparse, quote

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.abspath(__file__))
SETS_DIR = os.path.join(ROOT, 'sets')
PORT = int(os.environ.get('ADMIN_PORT', '8091'))
PREVIEW_W = 1080      # 详情页预览缩略图宽度（2 列布局 ≈560px 显示 → 1080 高清）
LQIP_W = 20           # 模糊占位图宽度
COVER_W, COVER_H = 600, 800
THUMB_Q = 84
IMG_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff'}
# 后台访问密码（留空=不校验，仅本机使用时可不设；部署到公网务必设置）
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', '')
WEBP_ENABLED = os.environ.get('WEBP_THUMBS', '1') != '0'   # 额外生成 WebP 缩略图

# ── 自动打标：OVHcloud 免费匿名视觉链（免 key，每模型 2 次/分钟，5 模型轮流） ──
VISION_BASE = os.environ.get('VISION_BASE', 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1')
VISION_MODELS = [
    'Qwen2.5-VL-72B-Instruct', 'Qwen3.5-397B-A17B', 'Qwen3.6-27B',
    'Mistral-Small-3.2-24B-Instruct-2506', 'Qwen3.5-9B',
]
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


def make_thumb(src_bytes: bytes, dst: str, width: int, quality: int = THUMB_Q, box=None):
    """等比缩放（或裁切到 box）并保存 JPEG，同时生成 LQIP 与可选 WebP 版本"""
    im = ImageOps.exif_transpose(Image.open(BytesIO(src_bytes)))
    if box:
        out = ImageOps.fit(im.convert('RGB'), box, method=Image.LANCZOS, centering=(0.5, 0.4))
    else:
        out = im.convert('RGB')
        if out.width > width:
            out = out.resize((width, round(out.height * width / out.width)), Image.LANCZOS)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    out.save(dst, 'JPEG', quality=quality, optimize=True, progressive=True)
    # LQIP：极小图，前端内联后先显示模糊版，再流式换成清晰图
    lqip = out.copy()
    lqip.thumbnail((LQIP_W, LQIP_W * 4), Image.LANCZOS)
    lqip.save(re.sub(r'\.jpg$', '.lqip.jpg', dst), 'JPEG', quality=40)
    # WebP 版本（体积通常再小 25-35%，构建时用 <picture> 优先使用）
    if WEBP_ENABLED:
        try:
            out.save(re.sub(r'\.jpg$', '.webp', dst), 'WEBP', quality=quality, method=5)
        except Exception as e:  # noqa
            print(f'[admin] WebP 生成失败（忽略）: {e}')
    return out.size


def ensure_thumbs(set_dir: str, force=False):
    """为图集补齐所有缩略图与 LQIP；返回处理数量"""
    img_dir = os.path.join(set_dir, 'images')
    thumb_dir = os.path.join(set_dir, 'thumbs')
    if not os.path.isdir(img_dir):
        return 0
    os.makedirs(thumb_dir, exist_ok=True)
    n = 0
    for f in sorted(os.listdir(img_dir)):
        if os.path.splitext(f)[1].lower() not in IMG_EXT:
            continue
        base = os.path.splitext(f)[0]
        dst = os.path.join(thumb_dir, base + '.jpg')
        need = (force or not os.path.exists(dst)
                or not os.path.exists(re.sub(r'\.jpg$', '.lqip.jpg', dst))
                or (WEBP_ENABLED and not os.path.exists(re.sub(r'\.jpg$', '.webp', dst))))
        if need:
            try:
                make_thumb(open(os.path.join(img_dir, f), 'rb').read(), dst, PREVIEW_W)
                n += 1
            except Exception as e:  # noqa
                print(f'[admin] 缩略图失败 {f}: {e}')
    # 封面缩略图
    cover = next((c for c in ('cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp') if os.path.exists(os.path.join(set_dir, c))), None)
    if cover and (force or not os.path.exists(os.path.join(thumb_dir, 'cover.jpg'))):
        make_thumb(open(os.path.join(set_dir, cover), 'rb').read(), os.path.join(thumb_dir, 'cover.jpg'), 480, 85, box=(480, 640))
    return n


def rebuild():
    try:
        r = subprocess.run(['node', 'build.mjs'], cwd=ROOT, capture_output=True, text=True, timeout=300)
        return r.returncode == 0, ((r.stdout or '') + (r.stderr or '')).strip()
    except Exception as e:  # noqa
        return False, f'重建失败：{e}'


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


def _extract_json(text):
    t = re.sub(r'^```(?:json)?|```$', '', (text or '').strip(), flags=re.M).strip()
    m = re.search(r'\{.*\}', t, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    tags = re.findall(r'[\"“]([^\"”\n]{2,8})[\"”]', t)
    return {'tags': tags[:10], 'description': t[:80]}


def vision_analyze(paths, timeout=150):
    """调用 OVH 免费匿名视觉链分析样图 → {tags, description, ...}；失败抛异常"""
    content = [{'type': 'text', 'text': VISION_PROMPT}]
    for p in paths[:3]:
        content.append({'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + _vision_payload_b64(p)}})
    last = 'unknown'
    for model in VISION_MODELS:
        for attempt in range(2):
            try:
                body = json.dumps({
                    'model': model,
                    'messages': [{'role': 'user', 'content': content}],
                    'max_tokens': 700,
                    'temperature': 0.4,
                }).encode('utf-8')
                req = urllib.request.Request(
                    VISION_BASE.rstrip('/') + '/chat/completions', data=body,
                    headers={'Content-Type': 'application/json', 'User-Agent': 'img-site-admin'})
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = json.loads(resp.read().decode('utf-8'))
                out = _extract_json(data['choices'][0]['message']['content'])
                out['_model'] = model
                return out
            except urllib.error.HTTPError as e:
                last = f'{model}: HTTP {e.code}'
                if e.code == 429:
                    time.sleep(2.5)
                    continue
            except Exception as e:  # noqa
                last = f'{model}: {e}'
            time.sleep(0.8)
    raise RuntimeError('视觉模型均不可用（' + last + '）')


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
.set .pick{position:absolute;top:8px;right:8px;width:20px;height:20px;cursor:pointer;z-index:2}
.set{position:relative}
.set.picked{outline:2px solid var(--accent)}
/* 封面裁剪器 */
.cropper{position:fixed;inset:0;z-index:200;background:rgba(8,10,14,.96);overflow:auto;padding:20px}
.crop-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:var(--fg);font-size:14px;margin-bottom:12px}
.crop-head select{padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--fg)}
.crop-stage{position:relative;display:inline-block;max-width:100%;user-select:none;touch-action:none}
.crop-stage img{max-width:min(1100px,92vw);max-height:72vh;display:block;border-radius:8px}
.crop-box{position:absolute;border:2px solid var(--accent);box-shadow:0 0 0 9999px rgba(0,0,0,.55);cursor:move;border-radius:2px}
.crop-grip{position:absolute;right:-8px;bottom:-8px;width:18px;height:18px;background:var(--accent);border-radius:4px;cursor:nwse-resize;border:2px solid #fff}
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
function toast(msg,ok){document.querySelectorAll('.toast').forEach(t=>t.remove());const d=document.createElement('div');d.className='toast '+(ok===undefined?'':(ok?'ok':'err'));d.textContent=msg;document.body.appendChild(d);if(ok!==undefined)setTimeout(()=>d.remove(),4500)}
function rebuild(){toast('正在重建…');fetch('/rebuild',{method:'POST'}).then(r=>r.text()).then(t=>{toast(t,true);setTimeout(()=>location.reload(),900)}).catch(e=>toast('失败：'+e,false))}
function post(url,body,reload){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(r=>r.text()).then(t=>{toast(t,true);if(reload!==false)setTimeout(()=>location.href=reload||location.href,700)})}
function del(slug){if(!confirm('确定删除图集 '+slug+' ？不可恢复'))return;fetch('/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug})}).then(r=>r.text()).then(t=>{toast(t,true);setTimeout(()=>location.href='/',700)})}
function setCover(slug,img){if(!confirm('把 '+img+' 设为封面？'))return;post('/setcover',{slug,img},'/edit?slug='+encodeURIComponent(slug))}
function delImage(slug,img){if(!confirm('删除图片 '+img+' ？不可恢复'))return;post('/deleteimage',{slug,img},'/edit?slug='+encodeURIComponent(slug))}
function dedupe(slug){if(!confirm('按内容清理重复图片（保留每组的第一张）？'))return;post('/dedupe',{slug},'/edit?slug='+encodeURIComponent(slug))}
function autotag(slug,force){toast('🤖 正在分析样图（约 10-30 秒）…');fetch('/autotag',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug,force:!!force,samples:3})}).then(r=>r.text()).then(t=>{toast(t,true);setTimeout(()=>location.reload(),1600)}).catch(e=>toast('失败：'+e,false))}
function autotagAll(){if(!confirm('对未打标的图集批量自动打标？（每套约 10-30 秒）'))return;toast('批量分析中，请勿关闭页面…');fetch('/autotag-all',{method:'POST'}).then(r=>r.text()).then(t=>{toast(t,true);setTimeout(()=>location.reload(),2500)}).catch(e=>toast('失败：'+e,false))}
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
"""


def page(title, body, extra_js=''):
    return f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title>
<style>{CSS}</style></head><body><div class="wrap">{body}</div>
<script>{JS}{extra_js}</script></body></html>"""


def sets_cards(sets):
    cards = []
    for s in sets:
        m = s['meta']
        img = f'<img src="{s["coverUrl"]}" alt="" loading="lazy">' if s['coverUrl'] else '<div style="aspect-ratio:3/4;background:#111"></div>'
        title = (m.get('title') or s['slug'])
        cards.append(f"""<div class="set" data-slug="{s['slug']}" data-search="{title.lower()} {s['slug'].lower()} {(m.get('model') or '').lower()} {','.join(m.get('tags', [])).lower()}"
             onclick="location.href='/edit?slug={quote(s['slug'])}'" title="点击编辑这套图集">
          <input type="checkbox" class="pick" data-slug="{s['slug']}" onclick="event.stopPropagation();togglePick(this)" title="选择用于批量操作">{img}<div class="body">
          <div class="t">{title}</div>
          <div class="m">{m.get('date','')} · {s['count']}P{' · 含压缩包' if s['hasPack'] else ''}</div>
          <div class="acts">
            <a class="mini" href="/edit?slug={quote(s['slug'])}" onclick="event.stopPropagation()">编辑</a>
            <a class="mini" href="http://127.0.0.1:8090/set/{quote(s['slug'])}/index.html" target="_blank" onclick="event.stopPropagation()">预览</a>
            <button class="mini" onclick="event.stopPropagation();del('{s['slug']}')">删除</button>
          </div></div></div>""")
    return ''.join(cards) or '<p class="sub">暂无图集，先上传一套</p>'


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
        f'<tr><td><span class="chip" style="padding:4px 10px">{t}</span></td><td>{len(sl)}</td>'
        f'<td class="dim" style="font-size:12px">{"、".join(sl[:3])}{"…" if len(sl) > 3 else ""}</td>'
        f'<td><input type="text" class="rename" data-from="{t}" placeholder="改成…" style="max-width:140px">'
        f'<button class="mini" onclick="renameTag(this)">重命名</button>'
        f'<button class="mini" onclick="delTag(\'{t}\')">全站删除</button></td></tr>'
        for t, sl in rows)
    ghtml = ''
    for g in groups:
        opts = ''.join(f'<option value="{t}">{t}（{len(tags.get(t, []))}）</option>' for t in g['tags'])
        ghtml += (f'<div class="taggroup"><div class="tg-list">'
                  + ' + '.join(f'<span class="chip">{t}</span>' for t in g['tags'])
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
  post('/tagmerge',{from:[from],to},'/tags');
}
function delTag(t){if(!confirm('从全站删除标签「'+t+'」？'))return;post('/tagmerge',{from:[t],to:''},'/tags')}
function mergeGroup(btn){
  const sel=btn.parentElement.querySelector('.mergeto');
  const to=sel.value;
  const group=[...btn.closest('.taggroup').querySelectorAll('.chip')].map(c=>c.textContent.trim());
  const from=group.filter(t=>t!==to);
  if(!from.length)return;
  if(!confirm('把 '+'、'.join(from)+' 合并进「'+to+'」？'))return;
  post('/tagmerge',{from,to},'/tags');
}
const tf=document.getElementById('tagFilter');
if(tf)tf.addEventListener('input',()=>{const q=tf.value.trim().toLowerCase();let n=0;document.querySelectorAll('#tagTable tbody tr').forEach(tr=>{const hit=!q||tr.textContent.toLowerCase().includes(q);tr.hidden=!hit;if(hit)n++})});
"""
    if msg:
        extra += f'window.addEventListener("load",()=>toast({json.dumps(msg, ensure_ascii=False)},true));'
    return page('标签管理', body, extra)


def home_page(msg=''):
    sets = list_sets()
    body = f"""
<h1>图集管理后台</h1>
<p class="sub">上传 → 自动生成缩略图(1080px)+模糊占位图 → 写入 sets/ → 重建静态站 · 端口 {PORT}</p>
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
    <div><label>下载网盘</label><input type="text" name="netdisk" placeholder="例：MediaFire"></div>
    <div><label>网盘下载外链（可选）</label><input type="text" name="downloadUrl" placeholder="https://..."></div>
    <div><label>目录名（可选）</label><input type="text" name="slug" placeholder="留空自动生成"></div>
  </div>
  <div><label style="margin-top:12px">描述（可选）</label><textarea name="description" rows="2"></textarea></div>
  <div class="drop" id="drop"><div><strong>拖拽图片到这里</strong> 或 <strong>点击选择</strong>（可多选）</div>
    <div style="font-size:12px;margin-top:6px">缩略图 {PREVIEW_W}px 自动生成 · 封面自动 600×800 裁切</div>
    <input type="file" id="imgs" name="images" accept="image/*" multiple hidden></div>
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
<div class="panel"><h2>② 已有图集（{len(sets)} 套）<span class="sub" style="font-weight:400"> · 点击卡片即可编辑</span></h2>
  <div class="row" style="margin:0 0 14px">
    <input type="text" id="setFilter" placeholder="筛选图集（标题/模特/标签/目录名）…" style="max-width:320px">
    <select id="quickJump" onchange="if(this.value)location.href='/edit?slug='+encodeURIComponent(this.value)" style="max-width:260px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--fg)">
      <option value="">快速跳转到编辑…</option>
      {''.join(f'<option value="{s["slug"]}">{s["meta"].get("title") or s["slug"]}</option>' for s in sets)}
    </select>
  </div>
  <div class="sets" id="setsGrid">{sets_cards(sets)}</div>
  <p class="sub" id="setEmpty" hidden>没有匹配的图集</p>
  <div class="bulk">
    <span class="sub" style="margin:0">已选 <b id="pickCount">0</b> 套：</span>
    <input type="text" id="bulkSeries" placeholder="批量设置系列">
    <button class="btn ghost sm" onclick="bulkSetSeries()">应用系列</button>
    <input type="text" id="bulkTags" placeholder="批量追加标签（逗号分隔）">
    <button class="btn ghost sm" onclick="bulkAddTags()">追加标签</button>
    <button class="btn ghost sm" onclick="bulkAutoTag()">🤖 批量打标</button>
    <button class="btn danger sm" onclick="bulkDelete()">删除选中</button>
    <button class="btn ghost sm" onclick="clearPick()">清空选择</button>
  </div>
  <div class="row"><button class="btn ghost" onclick="rebuild()">重新构建站点</button>
  <button class="btn ghost" onclick="backfill()">补齐所有缩略图</button>
  <button class="btn ghost" onclick="detectResAll()">📐 自动检测所有图集像素</button>
  <button class="btn ghost" onclick="autotagAll()">🤖 批量自动打标（未打标的图集）</button>
  <a class="btn ghost" href="/tags">🏷 标签管理</a>
  <a class="btn ghost" href="http://127.0.0.1:8090/" target="_blank">打开站点预览 ↗</a></div></div>"""
    extra = """
const drop=document.getElementById('drop'),imgs=document.getElementById('imgs'),files=document.getElementById('files');
const mk=document.getElementById('mkcover'),cf=document.getElementById('coverfile'),pc=document.getElementById('pickcover'),cn=document.getElementById('covername');
drop.onclick=()=>imgs.click();
drop.ondragover=e=>{e.preventDefault();drop.classList.add('on')};
drop.ondragleave=()=>drop.classList.remove('on');
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('on');imgs.files=e.dataTransfer.files;show()};
imgs.onchange=show;
function show(){files.innerHTML=[...imgs.files].map((f,i)=>'<div>'+(i+1)+'. '+f.name+' · '+(f.size/1048576).toFixed(2)+'MB</div>').join('');document.getElementById('submit').textContent=imgs.files.length?('上传 '+imgs.files.length+' 张并生成站点'):'上传并生成站点'}
mk.onchange=()=>{pc.disabled=!mk.checked;if(!mk.checked){cf.value='';cn.textContent=''}};
pc.onclick=()=>cf.click();cf.onchange=()=>{cn.textContent=cf.files[0]?cf.files[0].name:'（未选）'};
document.getElementById('f').onsubmit=()=>{if(!imgs.files.length){toast('请至少选择一张图片',false);return false}const b=document.getElementById('submit');b.disabled=true;b.textContent='上传中，请稍候…'};
// 上传进度（XHR 上报进度 + 服务端处理阶段提示）
const upForm=document.getElementById('f');
if(upForm&&window.XMLHttpRequest){
  upForm.addEventListener('submit',function(ev){
    if(!imgs.files.length)return;
    ev.preventDefault();
    const fd=new FormData(upForm),xhr=new XMLHttpRequest();
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
// ── 图片拖拽排序 ──
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
// ── 封面裁剪选择器（可视化拖拽 3:4 选区） ──
let CROP={slug:'',img:'',x:0,y:0,w:0,h:0,natW:0,natH:0,dispW:0,dispH:0};
function openCropper(slug){
  const first=document.querySelector('#thumbs .thumb');
  const img=first?first.dataset.img:'';
  if(!img){toast('该图集还没有图片',false);return}
  buildCropper(slug,img);
}
function buildCropper(slug,img){
  const old=document.getElementById('cropper');if(old)old.remove();
  const box=document.createElement('div');
  box.id='cropper';box.className='cropper';
  box.innerHTML=[
    '<div class="crop-head">✂ 裁剪封面（拖动选区移动 · 拖右下角调整大小 · 目标比例 3:4）',
    '<select id="cropImg"></select>',
    '<button class="btn sm" id="cropSave">保存封面</button>',
    '<button class="btn ghost sm" id="cropCancel">取消</button></div>',
    '<div class="crop-stage" id="cropStage"><img id="cropImgEl" alt=""><div class="crop-box" id="cropBox"></div></div>',
    '<p class="sub" id="cropInfo" style="margin:8px 0 0"></p>'
  ].join('');
  document.body.appendChild(box);
  const sel=document.getElementById('cropImg');
  [...document.querySelectorAll('#thumbs .thumb')].forEach(t=>{
    const o=document.createElement('option');o.value=t.dataset.img;o.textContent=t.dataset.img;sel.appendChild(o);
  });
  sel.value=img;
  sel.onchange=()=>buildCropper(slug,sel.value);
  document.getElementById('cropCancel').onclick=()=>box.remove();
  document.getElementById('cropSave').onclick=()=>saveCrop(slug);
  const el=document.getElementById('cropImgEl');
  el.onload=()=>initCropBox();
  el.src='/preview/'+encodeURIComponent(slug)+'/images/'+encodeURIComponent(img);
}
function initCropBox(){
  const el=document.getElementById('cropImgEl'),stage=document.getElementById('cropStage'),boxEl=document.getElementById('cropBox');
  CROP.natW=el.naturalWidth;CROP.natH=el.naturalHeight;
  CROP.dispW=el.clientWidth;CROP.dispH=el.clientHeight;
  // 默认居中、尽量大的 3:4 选区
  let h=CROP.dispH, w=h*3/4;
  if(w>CROP.dispW){w=CROP.dispW;h=w*4/3}
  CROP.x=(CROP.dispW-w)/2;CROP.y=(CROP.dispH-h)/2;CROP.w=w;CROP.h=h;
  const draw=()=>{
    boxEl.style.left=CROP.x+'px';boxEl.style.top=CROP.y+'px';
    boxEl.style.width=CROP.w+'px';boxEl.style.height=CROP.h+'px';
    const sx=CROP.natW/CROP.dispW, sy=CROP.natH/CROP.dispH;
    document.getElementById('cropInfo').textContent='选区（原图坐标）：'
      +Math.round(CROP.x*sx)+', '+Math.round(CROP.y*sy)+' · '
      +Math.round(CROP.w*sx)+'×'+Math.round(CROP.h*sy)+' px';
  };
  draw();
  let mode=null,sx0=0,sy0=0,c0=null;
  const onDown=(e,m)=>{mode=m;const p=pt(e);sx0=p.x;sy0=p.y;c0=Object.assign({},CROP);e.preventDefault();e.stopPropagation()};
  const pt=(e)=>{const r=el.getBoundingClientRect();const t=e.touches?e.touches[0]:e;return{x:t.clientX-r.left,y:t.clientY-r.top}};
  const onMove=(e)=>{
    if(!mode)return;const p=pt(e);
    const dx=p.x-sx0, dy=p.y-sy0;
    if(mode==='move'){
      CROP.x=Math.max(0,Math.min(CROP.dispW-CROP.w,c0.x+dx));
      CROP.y=Math.max(0,Math.min(CROP.dispH-CROP.h,c0.y+dy));
    }else{
      let w=Math.max(60,c0.w+dx);let h=w*4/3;
      if(c0.y+h>CROP.dispH){h=CROP.dispH-c0.y;w=h*3/4}
      CROP.w=w;CROP.h=h;
    }
    draw();e.preventDefault();
  };
  const onUp=()=>{mode=null};
  boxEl.onmousedown=e=>onDown(e,'move');
  boxEl.ontouchstart=e=>onDown(e,'move');
  const grip=document.createElement('div');grip.className='crop-grip';
  grip.onmousedown=e=>onDown(e,'size');grip.ontouchstart=e=>onDown(e,'size');
  boxEl.appendChild(grip);
  el.onmousedown=e=>{onDown(e,'move');};
  document.addEventListener('mousemove',onMove);document.addEventListener('touchmove',onMove,{passive:false});
  document.addEventListener('mouseup',onUp);document.addEventListener('touchend',onUp);
}
function saveCrop(slug){
  const sx=CROP.natW/CROP.dispW, sy=CROP.natH/CROP.dispH;
  const payload={slug,img:document.getElementById('cropImg').value,
    x:Math.round(CROP.x*sx),y:Math.round(CROP.y*sy),
    w:Math.round(CROP.w*sx),h:Math.round(CROP.h*sy)};
  toast('正在生成封面…');
  fetch('/cropcover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(r=>r.text()).then(t=>{toast(t,true);document.getElementById('cropper')?.remove();setTimeout(()=>location.reload(),1200)})
    .catch(e=>toast('失败：'+e,false));
}
// 图集筛选
const sf=document.getElementById('setFilter'),sg=document.getElementById('setsGrid'),se=document.getElementById('setEmpty');
if(sf&&sg){sf.addEventListener('input',()=>{const q=sf.value.trim().toLowerCase();let n=0;[...sg.querySelectorAll('.set')].forEach(c=>{const hit=!q||(c.dataset.search||'').includes(q);c.hidden=!hit;if(hit)n++});if(se)se.hidden=n!==0})}
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
      <div><label>展示的预览图数量</label><input type="text" name="previewCount" value="{m.get('previewCount','')}" placeholder="留空=默认 8 或全部"></div>
      <div><label>日期</label><input type="date" name="date" value="{m.get('date','')}"></div>
    </div>
    <div><label style="margin-top:12px">模特资料（选填 · 填了才在详情页展示 · AI 不会自动生成这些）</label></div>
    <div class="grid2">
      <div><label>年龄</label><input type="text" name="p_age" value="{pf.get('age','')}" placeholder="如 22 或 22岁"></div>
      <div><label>身高</label><input type="text" name="p_height" value="{pf.get('height','')}" placeholder="如 165cm"></div>
      <div><label>体重</label><input type="text" name="p_weight" value="{pf.get('weight','')}" placeholder="如 45kg"></div>
      <div><label>三围</label><input type="text" name="p_measure" value="{pf.get('measure','')}" placeholder="如 86-60-88"></div>
      <div><label>鞋码</label><input type="text" name="p_shoes" value="{pf.get('shoes','')}" placeholder="如 37"></div>
      <div><label>其他（籍贯/星座/特长等）</label><input type="text" name="p_other" value="{pf.get('other','')}" placeholder="选填"></div>
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
    <a class="btn ghost" href="http://127.0.0.1:8090/set/{quote(slug)}/index.html" target="_blank">打开详情页 ↗</a></div>
</form>

<div class="panel"><h2>② 图片管理（{len(imgs)} 张）</h2>
  <p class="sub">蓝框 = 当前封面 · 点「设为封面」重设封面 · <b>拖动卡片可调整顺序</b>（改完点「保存顺序」）· 删除会同时移除缩略图
    {f'· ⚠️ 检测到 {dupes} 张重复图片，建议清理' if dupes else ''}</p>
  <div class="row" style="margin:0 0 12px">
    <button class="btn sm" onclick="saveOrder('{slug}')">💾 保存顺序</button>
    <button class="btn ghost sm" onclick="resetOrder()">↺ 还原</button>
    <button class="btn ghost sm" onclick="dedupe('{slug}')">清理重复图片</button>
    <button class="btn ghost sm" onclick="openCropper('{slug}')">✂ 裁剪封面</button>
    <span class="sub" style="margin:0">按文件内容比对，保留每组的第一张（新上传已自动去重）</span>
  </div>
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
        self.end_headers()
        self.wfile.write(body)

    def _text(self, s, code=200):
        self._send(code, s.encode('utf-8'), 'text/plain; charset=utf-8')

    def _html(self, s, code=200):
        self._send(code, s.encode('utf-8'))

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
        ext = os.path.splitext(p)[1].lower()
        ctype = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif'}.get(ext, 'application/octet-stream')
        with open(p, 'rb') as f:
            self._send(200, f.read(), ctype)

    def do_GET(self):
        if not self._authed():
            return self._deny()
        u = urlparse(self.path)
        if u.path in ('/', '/index.html'):
            return self._html(home_page())
        if u.path == '/edit':
            qs = dict(p.split('=', 1) for p in u.query.split('&') if '=' in p)
            from urllib.parse import unquote
            return self._html(edit_page(unquote(qs.get('slug', ''))))
        if u.path == '/tags':
            return self._html(tags_page())
        if u.path.startswith('/preview/'):
            from urllib.parse import unquote
            return self._serve_file(unquote(u.path[len('/preview/'):]))
        self._text('not found', 404)

    def do_POST(self):
        if not self._authed():
            return self._deny()
        u = urlparse(self.path)
        if u.path == '/upload':
            return self.handle_upload()
        if u.path == '/save':
            return self.handle_save()
        if u.path == '/delete':
            d = self._json_body()
            slug = d.get('slug', '')
            p = os.path.join(SETS_DIR, slug)
            if slug and os.path.isdir(p) and os.path.normpath(p).startswith(SETS_DIR):
                shutil.rmtree(p)
                ok, out = rebuild()
                return self._text(f'已删除 {slug}\n{out}')
            return self._text('未找到该图集', 404)
        if u.path == '/setcover':
            d = self._json_body()
            slug, img = d.get('slug', ''), d.get('img', '')
            src = os.path.join(SETS_DIR, slug, 'images', img)
            if os.path.isfile(src):
                set_dir = os.path.join(SETS_DIR, slug)
                make_thumb(open(src, 'rb').read(), os.path.join(set_dir, 'cover.jpg'), COVER_W, 88, box=(COVER_W, COVER_H))
                make_thumb(open(src, 'rb').read(), os.path.join(set_dir, 'thumbs', 'cover.jpg'), 480, 85, box=(480, 640))
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
                ok, out = rebuild()
                return self._text(f'🤖 自动打标完成：{n} 个标签\n{info}\n（可在编辑页手动调整）' if n else f'跳过：{info}')
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
            ok, out = rebuild()
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
            thumb = crop.copy(); thumb.thumbnail((480, 640), Image.LANCZOS)
            thumb.save(os.path.join(set_dir, 'thumbs', 'cover.jpg'), 'JPEG', quality=85)
            if WEBP_ENABLED:
                try:
                    thumb.save(os.path.join(set_dir, 'thumbs', 'cover.webp'), 'WEBP', quality=85, method=5)
                except Exception:
                    pass
            ok, out = rebuild()
            return self._text(f'✓ 封面已按自定义区域裁剪（{x2 - x1}×{y2 - y1} → {COVER_W}×{COVER_H}）\n重建：' + ('成功' if ok else '失败'))
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
        if u.path == '/rebuild':
            ok, out = rebuild()
            return self._text(out)
        if u.path == '/backfill':
            total = 0
            for s in list_sets():
                total += ensure_thumbs(os.path.join(SETS_DIR, s['slug']))
            ok, out = rebuild()
            return self._text(f'补齐缩略图 {total} 张\n{out}')
        self._text('not found', 404)

    # ── 上传 ──
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
        slug = g('slug') or f'{d}-{slugify(title)}'
        set_dir = os.path.join(SETS_DIR, slug)
        img_dir, thumb_dir = os.path.join(set_dir, 'images'), os.path.join(set_dir, 'thumbs')
        os.makedirs(img_dir, exist_ok=True)
        os.makedirs(thumb_dir, exist_ok=True)

        saved, errors, dup = [], [], 0
        existing = image_hashes(set_dir)
        start = len(set_images(set_dir))
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
                make_thumb(raw, os.path.join(thumb_dir, base + '.jpg'), PREVIEW_W)
                existing[h] = name
                saved.append(name)
            except Exception as e:  # noqa
                errors.append(f'{f.filename}: {e}')
        if not saved:
            return self._text('全部图片处理失败：' + '; '.join(errors), 400)

        cover_src = None
        if 'cover' in form and getattr(form['cover'], 'filename', ''):
            cover_src = form['cover'].file.read()
        elif start == 0:
            cover_src = open(os.path.join(img_dir, saved[0]), 'rb').read()
        cover_info = ''
        if cover_src:
            size = make_thumb(cover_src, os.path.join(set_dir, 'cover.jpg'), COVER_W, 88, box=(COVER_W, COVER_H))
            make_thumb(cover_src, os.path.join(thumb_dir, 'cover.jpg'), 480, 85, box=(480, 640))
            cover_info = f'封面 {size[0]}x{size[1]}'

        if 'pack' in form and getattr(form['pack'], 'filename', ''):
            with open(os.path.join(set_dir, 'pack.zip'), 'wb') as out:
                shutil.copyfileobj(form['pack'].file, out)

        all_imgs = set_images(set_dir)
        meta = read_meta(set_dir)
        meta.update({
            'title': title, 'series': g('series'), 'date': d, 'model': g('model'),
            'tags': [t.strip() for t in re.split(r'[,，]', g('tags')) if t.strip()],
            'password': g('password'), 'netdisk': g('netdisk'), 'resolution': g('resolution'),
            'description': g('description') or meta.get('description', ''),
            'imageCount': len(all_imgs),
        })
        if g('downloadUrl'):
            meta['downloadUrl'] = g('downloadUrl')
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
            try:
                n, info, _ = autotag_set(set_dir, samples=3)
                tag_info = f'  🤖 自动打标：{info}\n' if n else f'  自动打标跳过：{info}\n'
            except Exception as e:  # noqa
                tag_info = f'  ⚠️ 自动打标失败（可稍后在编辑页重试）：{e}\n'

        ok, out = rebuild()
        msg = (f'✓ 上传完成：{slug}\n  本次新增 {len(saved)} 张，共 {len(all_imgs)} 张，{cover_info}\n'
               + (f'  已跳过 {dup} 张重复图片（内容相同）\n' if dup else '')
               + tag_info
               + f'  编辑：http://127.0.0.1:{PORT}/edit?slug={slug}\n  详情页：http://127.0.0.1:8090/set/{slug}/index.html\n'
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
                make_thumb(raw, os.path.join(set_dir, 'thumbs', base + '.jpg'), PREVIEW_W)
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
                'age': g('p_age'), 'height': g('p_height'), 'weight': g('p_weight'),
                'measure': g('p_measure'), 'shoes': g('p_shoes'), 'other': g('p_other'),
            }.items() if v},
            'imageCount': len(set_images(set_dir)),
        })
        if not meta['profile']:
            meta.pop('profile', None)
        if g('downloadUrl'):
            meta['downloadUrl'] = g('downloadUrl')
        elif 'downloadUrl' in meta:
            del meta['downloadUrl']
        pc = g('previewCount')
        if pc:
            try:
                meta['previewCount'] = int(pc)
            except ValueError:
                pass
        elif 'previewCount' in meta:
            del meta['previewCount']
        # 图片像素：自动检测为准（表单留空即自动；手填则作为兜底）
        res_txt, res_info = detect_resolution(set_dir)
        if res_txt:
            meta['resolution'] = res_txt.split('（')[0]
            meta['resolutionInfo'] = res_info
        elif g('resolution'):
            meta['resolution'] = g('resolution')
        save_meta(set_dir, meta)

        ensure_thumbs(set_dir)
        ok, out = rebuild()
        msg = (f'✓ 已保存：{meta["title"]}（{meta["imageCount"]} 张'
               + (f'，新增 {added} 张' if added else '')
               + (f'，跳过 {dup} 张重复' if dup else '')
               + '）\n重建：' + ('成功' if ok else '失败') + '\n' + out)
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
