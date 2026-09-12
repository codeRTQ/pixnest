"""生成 3 套演示图集：封面 + 预览图 + 压缩包（用于验证站点生成器）"""
import json, os, zipfile
from PIL import Image, ImageDraw, ImageFont

BASE = r'D:\dsh-demo\img-site\sets'

SETS = [
    {
        'slug': '2022-04-27-youcaihua-yiyi',
        'title': '油菜花 一一', 'series': 'YITUYU艺图语', 'date': '2022-04-27',
        'model': '一一', 'tags': ['油菜花', '清新', '户外'],
        'password': 'vx666878787', 'netdisk': 'MediaFire',
        'resolution': '4000x6000', 'count': 6,
        'c1': (247, 214, 120), 'c2': (150, 200, 110),
    },
    {
        'slug': '2023-06-12-xiaguang-zhizhiqi',
        'title': '剪一片云绿 芝芝琪', 'series': 'YITUYU艺图语', 'date': '2023-06-12',
        'model': '芝芝琪', 'tags': ['绿意', '写真'],
        'password': 'vx666878787', 'netdisk': 'MediaFire',
        'resolution': '4000x6000', 'count': 5,
        'c1': (120, 190, 200), 'c2': (60, 120, 170),
    },
    {
        'slug': '2024-03-08-yueguang-linhuayu',
        'title': '断相思 令花羽', 'series': 'YALAYI雅拉伊', 'date': '2024-03-08',
        'model': '令花羽', 'tags': ['夜景', '古典'],
        'password': 'vx666878787', 'netdisk': 'MediaFire',
        'resolution': '4480x6720', 'count': 7,
        'c1': (150, 110, 200), 'c2': (60, 60, 120),
    },
]

def font(size):
    for p in [r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\simhei.ttf', r'C:\Windows\Fonts\arial.ttf']:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, size)
            except Exception: pass
    return ImageFont.load_default()

def gradient(w, h, c1, c2):
    img = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)))
    return img

def make_image(path, w, h, c1, c2, label, sub=''):
    img = gradient(w, h, c1, c2)
    d = ImageDraw.Draw(img)
    # 装饰几何
    d.ellipse([w*0.55, h*0.1, w*1.25, h*0.8], outline=(255,255,255,60), width=3)
    d.rectangle([w*0.06, h*0.72, w*0.5, h*0.735], fill=(255, 255, 255))
    d.text((w*0.06, h*0.76), label, font=font(int(h*0.055)), fill=(255,255,255))
    if sub:
        d.text((w*0.06, h*0.855), sub, font=font(int(h*0.032)), fill=(255,255,255))
    d.text((w*0.06, h*0.05), 'DEMO', font=font(int(h*0.028)), fill=(255,255,255))
    img.save(path, quality=88)

for s in SETS:
    d = os.path.join(BASE, s['slug'])
    os.makedirs(os.path.join(d, 'images'), exist_ok=True)
    # 封面 3:4
    make_image(os.path.join(d, 'cover.jpg'), 600, 800, s['c1'], s['c2'], s['title'], s['model'])
    # 预览图
    names = []
    for i in range(1, s['count'] + 1):
        n = f'{i:02d}.jpg'
        make_image(os.path.join(d, 'images', n), 800, 1200, s['c1'], s['c2'], s['title'], f'{s["model"]} · {i:02d}')
        names.append(n)
    # meta.json
    meta = {
        'title': s['title'], 'series': s['series'], 'date': s['date'], 'model': s['model'],
        'tags': s['tags'], 'password': s['password'], 'netdisk': s['netdisk'],
        'resolution': s['resolution'], 'imageCount': s['count'],
        'description': f'{s["series"]} {s["date"]} {s["title"]} {s["model"]}，共 {s["count"]} 张预览（演示数据）。',
    }
    with open(os.path.join(d, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    # 压缩包
    with zipfile.ZipFile(os.path.join(d, 'pack.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        for n in names:
            z.write(os.path.join(d, 'images', n), n)
    print('generated', s['slug'], s['count'], 'images + cover + pack.zip')
print('done')
