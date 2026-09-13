# PixNest · 图巢

一个**纯静态**的写真图集站：零依赖 Node 生成器 + 本地 Python 后台。

公网只部署静态文件（HTML/CSS/JS/缩略图），没有数据库、没有后端服务、没有运行环境依赖；
内容管理与上传全部在**本机**完成，构建成静态产物后整体上传即可。

线上示例：<https://pixnest.dpdns.org/>

---

## 特性

**站点**
- 瀑布流（Masonry）列表：按构建时已知的宽高比**一次性定版**，布局与图片加载顺序无关，
  每次刷新完全一致，不会出现空洞 / 错行 / 高度跳变；图片就位后仅做模糊淡入
- LQIP 模糊占位（内联超小图，首屏不闪白）+ 懒加载 + WebP（自动回退 JPEG）
- 全站搜索/筛选/排序（读 `search-index.json`，跨分页生效）、随机跳转、深浅主题（记忆偏好）
- 详情页流式预览 + **PhotoSwipe v5** 画廊（缩放/滑动/键盘/手势，已本地化，无 CDN 依赖）
- 系列页 / 标签页**静态化**（SEO 友好）、相关推荐、系列与标签索引页
- SEO 全家桶：`sitemap.xml`、`robots.txt`、`feed.xml`(RSS)、canonical、OG 卡片、JSON-LD
- 自定义 404 页；访问统计可插拔（umami / 百度 / Google / 自定义脚本）
- 合规件：**18+ 内容闸门**（localStorage 记忆一年）、免责声明与 DMCA 页、隐私政策页

**后台（仅本机运行）**
- 多图上传（拖拽、XHR 进度、MD5 去重）、发布后随时编辑
- 自动生成缩略图（**1920px** + LQIP + WebP，清晰度优先）、封面（800×1067）
- 缩略图 URL 自动带版本戳（`?v=体积-时间`）→ 换图或重新生成后立刻生效，不会被浏览器/CDN 旧缓存挡住
- `rethumb.py`：改了缩略图规格后一条命令重生成全部图集（`python rethumb.py`）
- **拖拽排序**、**封面裁剪选择器**、自动识别原图分辨率
- AI 自动打标签（OpenAI 兼容接口）+ 人工增删调整 + **标签同义词去重合并**
- 批量操作：改系列、统一加标签、批量自动打标签、批量删除、批量探测分辨率
- 模特资料、网盘外链、解压密码等字段（留空则不显示）

**部署**
- `deploy.py` 一条命令：构建 → 部署前体检 → 打包 → 上传
- 支持 Cloudflare Pages / 阿里云 OSS / 任意 VPS(nginx) / Docker / SFTP
- 双构建模式：`精简模式`（只放缩略图，体积降 ~99%）与 `完整模式`（含原图与压缩包）
- 公网模式会**自动剥离本地后台入口**（`?admin=1`、`127.0.0.1:8091`）

---

## 目录结构

```
.
├── build.mjs            # 静态生成器（零依赖 Node，核心）
├── admin.py             # 本地管理后台（Python 标准库 + Pillow）
├── deploy.py            # 构建 / 体检 / 打包 / 上传
├── make_demo_sets.py    # 生成演示图集（占位图，用于快速跑通）
├── preview.ps1          # 本地一键：完整构建 + 起预览站(8090) + 起后台(8091)
├── site.json            # 站点配置（站名/副标题/域名/闸门/免责声明…）
├── vendor/photoswipe/   # PhotoSwipe v5（本地化，含 LICENSE）
├── sets/                # 图集素材（不入库，见下）
└── dist/                # 构建产物（不入库）
```

### 图集素材结构

```
sets/<slug>/
├── meta.json     # 元数据（标题/系列/日期/模特/标签/网盘…）
├── cover.jpg     # 封面（后台自动生成 600×800）
├── images/       # 原图
├── thumbs/       # 缩略图 1920px(.webp 主 + .jpg 回退) + .lqip.jpg（后台自动生成）
└── pack.zip      # 可选：压缩包（完整模式才会进 dist）
```

`meta.json` 主要字段：`title` `displayTitle` `series` `date` `model` `tags[]`
`password`(解压密码) `netdisk`(网盘名) `downloadUrl`(网盘外链) `resolution`
`imageCount` `modelInfo`，以及自动生成的 `autoTags[]` `resolutionInfo`。

> 仓库**不包含任何图集内容**（`sets/` 已在 `.gitignore` 中）。想快速跑通可先执行
> `python make_demo_sets.py` 生成几套占位演示数据。

---

## 快速开始

**依赖**：Node 18+；Python 3.9+（后台需 `pip install pillow`）。生成器本身**零 npm 依赖**。

```powershell
# 1) 生成演示数据（或把自己的图集放进 sets/<slug>/）
python make_demo_sets.py

# 2) 本地预览（完整模式构建 + 预览站 8090 + 后台 8091）
.\preview.ps1
#    预览： http://127.0.0.1:8090
#    后台： http://127.0.0.1:8091

# 3) 只构建
node build.mjs                    # 完整模式（含原图/压缩包，本地用）
$env:SITE_LITE='1'; node build.mjs  # 精简模式（部署用，只放缩略图）
```

详情页带 `?admin=1` 会显示「编辑这套图集」入口（公网构建会自动剥离）。

## 部署

```powershell
python deploy.py --check                                  # 只体检，不上传
python deploy.py                                          # 构建（精简+公网模式）+ 打包到 deploy/
python deploy.py --cloudflare --project my-site --base-url https://img.example.com
python deploy.py --oss                                    # 阿里云 OSS（需 OSS_AK/OSS_SK/OSS_BUCKET/OSS_ENDPOINT）
python deploy.py --sftp user@host=/var/www/site            # scp 上传
python deploy.py --full                                   # 完整模式：原图与压缩包也进站点
python deploy.py --with-admin                             # 仅本机：保留后台入口
```

> **务必设置 `baseUrl`**（`site.json` 或部署时 `--base-url`），否则 canonical/sitemap/RSS/OG
> 会是相对路径，分享卡片与 SEO 都不完整。

公网产物还会自动生成：
- `_headers` —— Cloudflare Pages 缓存/安全响应头
- `404.html` —— 错误页
- `about.html` / `privacy.html` —— 免责声明(DMCA) 与隐私政策

**安全红线**：`admin.py` 与素材 `sets/` **永远不要**上传到公网。需要远程管理请用
SSH 隧道 / Cloudflare Tunnel / Tailscale，不要开放公网端口。

---

## 踩坑记录（改代码前请先看）

1. **`build.mjs` 里的 `APP` 是模板字符串**：其中的 `\/`、`\s`、`\n` 等转义会被**吃掉**，
   曾导致生成出的 `app.js` 语法错误、整站 JS 静默失效。写法要求：
   - 不要在 `APP` 里写带转义的正则（用 `includes()` 等字符串方法，或写成 `\\s`）
   - 不要用反引号与 `${}` 拼接（会被外层模板吞掉），用字符串相加
   - 构建时已加 `new Function(APP)` 语法守卫，出错会直接中断构建
2. **Cloudflare `_headers` 的 `*` 只能出现一次**，且需独占路径段；
   `/set/*/thumbs/*` 这类双 splat 会整条失效，路径中段要用 `:slug` 占位符。
   `/*.html` 也不生效 —— Pages 对 HTML 的默认 `max-age=0, must-revalidate` 已是最优。
3. **缓存策略**：`assets/*` 带 `?v=` 内容指纹 → 长缓存 immutable；
   缩略图 URL 带 `?v=` 版本戳，改图后自动更新；`_headers` 对缩略图给 1 天 +
   `stale-while-revalidate`（版本戳保证更新即时可见，缓存又不会被浪费）。
4. **Windows 控制台是 GBK**：Python 脚本已 `sys.stdout.reconfigure(encoding='utf-8')`，
   子进程调用也显式传 `encoding='utf-8'`，否则中文报 `UnicodeEncodeError`。
5. **`preview.ps1` 必须存为 UTF-8 with BOM**，否则 Windows PowerShell 5.1 会因中文注释解析失败。
6. **瀑布流不要按"图片加载完成顺序"落位**。曾同时存在两套布局算法（骨架屏按 DOM 顺序
   预测、图片按加载顺序落位），两者互相冲突 → 中间大片空洞、列错行，且加载顺序每次
   刷新都不同、布局随之抖动。正确做法：宽高比在构建时写进 `data-ratio`，
   **一次性把全部格子排完**，图片只负责淡入。修完实测：1/2/3 列下均 0 重叠、
   列内空隙恒为 16px、容器高度与实际底部像素级一致。
7. `_headers` 等平台配置文件对其它平台无副作用；换托管平台时按各自格式调整。

---

## 合规与免责

本站是**内容索引/展示**性质的静态站，请自行确保你发布的内容合法合规：

- 所有图片版权归原作者，**禁止商用**；请在页脚/免责页配置你的版权声明与投诉联系方式
  （`site.json` 的 `disclaimer` / `dmca`）
- 如内容涉及成人向素材，建议开启 `adultGate`（18+ 确认闸门）并遵守托管平台的内容政策
- 压缩包建议**走网盘外链**（`downloadUrl`），不要把原图与压缩包直接放公网：
  既省流量与成本，也降低版权投诉与盗刷风险
- 面向中国大陆用户时注意 ICP 备案要求；境外托管平台（如 Cloudflare）则免备案

## 许可

本项目代码可自由使用与修改。`vendor/photoswipe/` 为第三方组件，遵循其自身 LICENSE（MIT）。
