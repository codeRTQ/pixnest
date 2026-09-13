#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重新生成缩略图（改了 admin.py 的 PREVIEW_W / 质量参数后跑一次）

用法：
    python rethumb.py                  # 对所有图集强制重生成缩略图 + LQIP + WebP
    python rethumb.py --set <目录名片段>  # 只处理匹配的图集
    python rethumb.py --cover          # 同时按新规格重做封面（会覆盖现有 cover.jpg）

说明：原图从 sets/<slug>/images/ 读取，只重写 thumbs/ 与（可选）cover.jpg，不动原图。
"""
import os
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

import admin  # noqa: E402  复用 make_thumb / ensure_thumbs / 参数常量


def main():
    args = sys.argv[1:]
    only = None
    if '--set' in args:
        i = args.index('--set')
        only = args[i + 1] if i + 1 < len(args) else None
    do_cover = '--cover' in args

    print(f'缩略图规格：宽 {admin.PREVIEW_W}px · JPEG q{admin.THUMB_Q} · WebP q{admin.WEBP_Q}'
          f' · 封面 {admin.COVER_W}×{admin.COVER_H}')
    if only:
        print(f'只处理匹配「{only}」的图集')

    sets = sorted(d for d in os.listdir(admin.SETS_DIR)
                  if os.path.isdir(os.path.join(admin.SETS_DIR, d)))
    if only:
        sets = [d for d in sets if only in d]
    if not sets:
        sys.exit('× 没有匹配的图集')

    t0 = time.time()
    total_imgs = 0
    for name in sets:
        d = os.path.join(admin.SETS_DIR, name)
        imgs = [f for f in os.listdir(os.path.join(d, 'images'))
                if os.path.splitext(f)[1].lower() in admin.IMG_EXT] \
            if os.path.isdir(os.path.join(d, 'images')) else []
        if not imgs:
            print(f'  - {name}：无原图，跳过')
            continue
        t1 = time.time()
        n = admin.ensure_thumbs(d, force=True)
        total_imgs += n
        # 封面：按新规格重做（可选，默认保留后台手工裁剪的结果）
        if do_cover:
            cover = next((c for c in ('cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp')
                          if os.path.exists(os.path.join(d, c))), None)
            if cover:
                admin.make_thumb(open(os.path.join(d, cover), 'rb').read(),
                                 os.path.join(d, 'cover.jpg'),
                                 admin.COVER_W, 88, box=(admin.COVER_W, admin.COVER_H))
        print(f'  ✓ {name}：{n} 张 · {time.time() - t1:.1f}s')

    print(f'\n完成：{len(sets)} 套 / {total_imgs} 张缩略图 · 共 {time.time() - t0:.1f}s')
    print('接下来：.\\publish.ps1 重新发布')


if __name__ == '__main__':
    main()
