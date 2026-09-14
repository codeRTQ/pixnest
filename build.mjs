#!/usr/bin/env node
/**
 * 隐藏套图：全局密码存在项目根的 .hidden.json（已 gitignore，不进仓库也不随站点发布）。
 * 勾了「隐藏」的套图不会写在公开的 set/<slug>/ 下，而是写到 h/<token>/ 下，
 *   token = sha256(密码 + '|' + slug) 前 16 位
 * 不知道密码就算不出这个地址；生成的 HTML 里只出现模糊小图，不出现 token，
 * 所以爬虫/路人都拿不到隐藏套图的页面与图片（这是纯静态托管能做到的最强隐藏）。
 */
/**
 * 图集静态站点生成器（零依赖，纯 Node）
 *
 * 目录约定：
 *   sets/<slug>/meta.json    图集信息（可选字段见下方 normalizeMeta）
 *   sets/<slug>/cover.jpg    封面（缺省用 images/ 第一张）
 *   sets/<slug>/images/*     预览图（按文件名排序）
 *   sets/<slug>/pack.zip     压缩包（可选，自动计算大小；也可在 meta 里给外链）
 *
 * 输出：
 *   dist/index.html, dist/page/N.html          列表页（分页）
 *   dist/set/<slug>/index.html                 详情页
 *   dist/set/<slug>/images/*                   预览图（复制）
 *   dist/search-index.json                     前端搜索/筛选用
 *   dist/assets/style.css, dist/assets/app.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, renameSync, openSync, readSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SETS_DIR = join(ROOT, 'sets')
const DIST_REAL = join(ROOT, 'dist')          // 对外目录：预览服务器与 deploy.py 都读它
const DIST_STAGE = join(ROOT, 'dist.new')     // 构建真正写入的暂存目录
const DIST_OLD = join(ROOT, 'dist.old')       // 切换时旧产物临时挪到这里
let DIST = DIST_STAGE                          // 构建期间所有 join(DIST, ...) 都落在暂存目录
let SITE_BITS = ''                             // 列表页体量文案（首页算好后给页脚用）

/**
 * 隐藏套图：全局密码存在项目根的 .hidden.json（已 gitignore，不进仓库也不随站点发布）。
 * 勾了「隐藏」的套图不写到公开的 set/<slug>/ 下，而是写到 h/<token>/ 下，
 *   token = sha256(密码 + '|' + slug) 前 16 位
 * 不知道密码就算不出这个地址；生成的 HTML 里只出现模糊小图，不出现 token，
 * 所以爬虫/路人都拿不到隐藏套图的页面与图片（纯静态托管能做到的最强隐藏方式）。
 */
const HIDDEN_CFG = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, '.hidden.json'), 'utf8')) } catch { return {} }
})()
const HIDDEN_PW = String(HIDDEN_CFG.password || '')
const HIDDEN_HINT = String(HIDDEN_CFG.hint || '这套图已隐藏，输入密码后查看')
/** 隐藏套图地址的 token（必须与 admin.py 的 hidden_token() 完全一致） */
const hiddenToken = (s) => createHash('sha256')
  .update(String(s.hidePassword || HIDDEN_PW) + '|' + s.slug).digest('hex').slice(0, 16)
/** 隐藏套图的相对地址（如 h/ab12cd34ef567890/），非隐藏返回空串 */
const hiddenPath = (s) => (s.hiddenOk ? `h/${s.token}/` : '')

// ─────────────────────────── 配置 ───────────────────────────
const defaultConfig = {
  siteName: '图集站',
  siteSubtitle: '高质量写真图集 · 定期更新',
  baseUrl: '',
  setsPerPage: 12,
  previewCount: 8,
  relatedCount: 4,           // 详情页「相关推荐」条数（4 条正好一行）
  modelSideCount: 5,         // 详情页侧栏「模特的其他作品」条数
  previewRowTarget: 460,     // 预览区行式布局的目标行高（px）：每行 2~3 张，横向铺满整行
  previewRowMax: 3,          // 预览区每行最多几张（2 或 3）
  assetSalt: '2',            // CSS/JS 版本盐：assets 是 immutable 长缓存，改了样式若边缘缓存不刷新，把它 +1 即可强制换 URL
  icp: '',
  // 合规相关（部署前请按当地法律与平台要求配置）
  adultGate: false,          // true = 访问前显示“18+ 内容确认”闸门
  disclaimer: '本站内容均为网络收集整理，仅供个人学习与欣赏，请勿用于商业用途。如内容侵犯您的权益，请联系管理员删除。',
  dmca: '',                  // 版权投诉联系方式（邮箱/表单链接），留空则用默认文案
  privacy: '',               // 隐私政策正文（留空则不生成隐私页）
  // 原图托管（OpenList / AList 网盘）：配好后每套图自动生成「打开原图目录」与每张图的「原图」链接
  //   base         OpenList 访问地址（局域网地址公网访客打不开，需配合 Cloudflare Tunnel 等对外暴露）
  //   dirTemplate  图集目录模板，可用 {model} {title} {slug} {date} {series}
  //   fileTemplate 原图文件名模板，{n} 为序号（{n5} = 补零到 5 位，如 00001.jpg）
  //   rawPrefix   单张原图的接口前缀（默认 /p；/d 通常要求登录会返回 403）
  //   单套图可用 meta.json 的 openlistDir 覆盖目录
  openlist: null,
}
const config = existsSync(join(ROOT, 'site.json'))
  ? { ...defaultConfig, ...JSON.parse(readFileSync(join(ROOT, 'site.json'), 'utf8')) }
  : defaultConfig
// 精简模式（部署用）：不复制原图与压缩包进 dist，只放缩略图 → 站点体积降 10-20 倍
// 本地预览用完整模式：SITE_LITE=0 node build.mjs
const LITE = process.env.SITE_LITE === '1'
// 公网发布模式（SITE_PUBLIC=1）：去掉一切本地管理入口（?admin=1 编辑栏、后台链接）
const PUBLIC = process.env.SITE_PUBLIC === '1'
// 构建时可用 SITE_BASE_URL 覆盖 site.json 的 baseUrl（如 https://xxx.pages.dev）
if (process.env.SITE_BASE_URL) config.baseUrl = process.env.SITE_BASE_URL

// ── 访问统计（在 site.json 配 analytics 即自动注入所有页面）──
// umami:    {"analytics":{"provider":"umami","scriptUrl":"https://umami.example.com/script.js","siteId":"xxx"}}
// baidu:    {"analytics":{"provider":"baidu","siteId":"12345678"}}
// google:   {"analytics":{"provider":"google","siteId":"G-XXXXXXX"}}
// custom:   {"analytics":{"provider":"custom","scriptUrl":"https://.../a.js","inline":"..."}}
function analyticsSnippet() {
  const a = config.analytics
  if (!a || !a.provider) return ''
  if (a.provider === 'umami') return `<script defer src="${esc(a.scriptUrl || '')}" data-website-id="${esc(a.siteId || '')}"></script>`
  if (a.provider === 'baidu') return `<script>var _hmt=_hmt||[];(function(){var hm=document.createElement("script");hm.src="https://hm.baidu.com/hm.js?${esc(a.siteId || '')}";var s=document.getElementsByTagName("script")[0];s.parentNode.insertBefore(hm,s)})();</script>`
  if (a.provider === 'google') return `<script async src="https://www.googletagmanager.com/gtag/js?id=${esc(a.siteId || '')}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${esc(a.siteId || '')}');</script>`
  if (a.provider === 'custom') return (a.scriptUrl ? `<script defer src="${esc(a.scriptUrl)}"></script>` : '') + (a.inline ? `<script>${a.inline}</script>` : '')
  return ''
}
const ANALYTICS_RAW = analyticsSnippet   // 延迟到 build() 里调用（esc 需先初始化）
let ANALYTICS = ''

/** 18+ 内容确认闸门（配置 adultGate: true 时注入） */
function adultGateSnippet() {
  if (!config.adultGate) return ''
  return `<div id="adultGate" class="adult-gate" hidden>
  <div class="ag-card">
    <h2>内容提示 / Content Notice</h2>
    <p>本站可能包含面向成年人的写真与人物摄影内容。请确认您已年满 18 周岁，并自愿继续访问。</p>
    <p class="dim">This site may contain adult-oriented photographic content. You must be 18 or older to continue.</p>
    <div class="ag-actions">
      <button class="btn btn-primary" id="agEnter">我已满 18 岁，进入</button>
      <a class="btn ghost" href="https://www.baidu.com">我未满 18 岁，离开</a>
    </div>
  </div>
</div>`
}
const ADULT_GATE = adultGateSnippet()

let ASSET_V = '1'

// ─────────────────────────── 工具 ───────────────────────────
const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtSize = (bytes) => {
  if (!bytes) return ''
  const mb = bytes / 1048576
  return mb >= 1024 ? (mb / 1024).toFixed(2) + 'GB' : mb.toFixed(1) + 'MB'
}
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'])

/** 文件版本戳（体积 + 修改时间）→ 拼进图片 URL，换了图立刻生效，不会被浏览器/CDN 旧缓存挡住 */
function fileVer(p) {
  try {
    const st = statSync(p)
    return st.size.toString(36) + '-' + Math.floor(st.mtimeMs / 1000).toString(36)
  } catch { return '' }
}
const verQ = (v) => (v ? '?v=' + v : '')

/** 「最新发布」的排序比较：日期 → 入库时间 → 目录名（都倒序）。
 *  只比日期是不够的：同一天导入的一批图集，刚上传的会排不到最前面。 */
const cmpDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''))
  || String(b.addedAt || '').localeCompare(String(a.addedAt || ''))
  || String(b.slug || '').localeCompare(String(a.slug || ''))

/** 读取图片文件头取宽高（零依赖，只读前 64KB） */
function imageSize(path) {
  try {
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(65536)
    const n = readSync(fd, buf, 0, 65536, 0)
    closeSync(fd)
    const b = buf.subarray(0, n)
    // JPEG
    if (b[0] === 0xff && b[1] === 0xd8) {
      let o = 2
      while (o + 9 < b.length) {
        if (b[o] !== 0xff) { o++; continue }
        const m = b[o + 1]
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { w: b.readUInt16BE(o + 7), h: b.readUInt16BE(o + 5) }
        }
        o += 2 + b.readUInt16BE(o + 2)
      }
    }
    // PNG
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
    }
    // WebP
    if (b.length > 30 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') {
      const t = b.subarray(12, 16).toString()
      if (t === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }
      if (t === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }
      if (t === 'VP8L') {
        const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24]
        return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) }
      }
    }
    // GIF
    if (b.length > 9 && b.subarray(0, 3).toString() === 'GIF') {
      return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) }
    }
  } catch { /* ignore */ }
  return null
}

function listImages(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => IMG_EXT.has(extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
}

/** 读取单个图集目录 → 归一化对象 */
// ─────────────────── 原图托管（OpenList / AList）链接生成 ───────────────────
// 站点只放缩略图，原图仍留在自己的网盘里；这里按模板拼出「整套目录」与「单张原图」的地址。
const OL = (config.openlist && config.openlist.base) ? config.openlist : null
/** 逐段 URL 编码（保留 / 分隔；空格、( )、[] 等交给 encodeURIComponent） */
const encPath = (p) => String(p).replace(/^\/+|\/+$/g, '').split('/').map(encodeURIComponent).join('/')
/** 从本地文件名里取出序号：01.jpg → 1；无法解析返回 null */
function fileIndex(name) {
  const m = String(name).match(/^0*(\d+)/)
  return m ? Number(m[1]) : null
}
/** 第 idx 张原图在网盘里的文件名（默认补零到 5 位：00001.jpg） */
function olFileName(idx) {
  const tpl = (OL && OL.fileTemplate) || '{n5}.jpg'
  return tpl.replace(/\{n(\d)?\}/g, (m, w) => String(idx).padStart(w ? Number(w) : 1, '0'))
}
/** 图集在网盘里的目录：优先 meta.json 的 openlistDir，否则按 dirTemplate 拼 */
function olDirOf(s) {
  if (!OL) return ''
  if (s.openlistDir) return s.openlistDir
  const tpl = OL.dirTemplate || ''
  if (!tpl) return ''
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (s[k] != null && s[k] !== '' ? String(s[k]) : m))
}
/** 图集目录的完整 URL（已编码）——用于「打开原图目录」，进的是 OpenList 前端界面 */
function olDirUrl(s) {
  const d = olDirOf(s)
  return d ? String(OL.base).replace(/\/+$/, '') + '/' + encPath(d) : ''
}
/** 单张原图的直链——走 OpenList 的原始文件接口（默认 /p，/d 通常需要登录会 403） */
function olFileUrl(s, fileName) {
  const d = olDirOf(s)
  if (!d) return ''
  const pre = String(OL.rawPrefix == null ? '/p' : OL.rawPrefix).replace(/\/+$/, '')
  return String(OL.base).replace(/\/+$/, '') + pre + '/' + encPath(d + '/' + fileName)
}

/** 模特资料：按模特统一维护（models/<模特>.json），单套图集可在 meta.profile 里覆盖个别字段
 *  好处：改一次该模特名下所有图集都生效，不用一套套改 */
function modelProfile(model) {
  if (!model) return {}
  const safe = String(model).replace(/[\\/:*?"<>|]/g, '_').trim()
  if (!safe) return {}
  try { return JSON.parse(readFileSync(join(ROOT, 'models', safe + '.json'), 'utf8')) } catch { return {} }
}

/** 模特头像（后台从该模特任意一套图里裁剪生成）：没有就返回空串，页面自动退回封面 */
function avatarUrl(model, rel = '') {
  if (!model) return ''
  const safe = String(model).replace(/[\\/:*?"<>|]/g, '_').trim()
  if (!safe) return ''
  const dir = join(ROOT, 'models', 'avatar')
  const f = ['webp', 'jpg', 'jpeg', 'png'].map(ext => safe + '.' + ext).find(x => existsSync(join(dir, x)))
  if (!f) return ''
  return `${rel}assets/avatar/${encodeURIComponent(f)}${verQ(fileVer(join(dir, f)))}`
}

/**
 * 卡片角标上用的模特头像（站根相对路径，不带 rel）：优先后台裁的自定义头像，
 * 没有就用该模特最新一套**公开**图集的封面当头像。由主流程在渲染前填好。
 */
const MODEL_FACE = {}

/** 一套图的封面地址（隐藏套图→用公开的模糊小图，公开目录里没有它的路径） */
function setCoverUrl(s, rel = '') {
  if (!s) return ''
  if (s.hidden) return s.blurThumb ? `${rel}blur/${encodeURIComponent(s.slug)}.webp` : ''
  if (!s.coverFile) return ''
  return `${rel}set/${s.slug}/${s.coverThumb ? 'thumbs/' + s.coverThumb + verQ(s.thumbVer[s.coverThumb]) : s.coverFile}`
}

/** 模特圆形头像（后台从该模特任意一套图里裁剪生成）：没有就返回空串，页面自动退回封面 */
function avatarHtml(model, rel = '', size = 'sm', cls = '') {
  const u = avatarUrl(model, rel)
  if (!u) return ''
  return `<span class="mavatar mavatar-${size}${cls ? ' ' + cls : ''}"><img src="${u}" alt="${esc(model)}" loading="lazy"></span>`
}

function readSet(slug) {
  const dir = join(SETS_DIR, slug)
  const metaPath = join(dir, 'meta.json')
  if (!existsSync(metaPath)) return null
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))

  const images = listImages(join(dir, 'images'))
  const coverFile = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp'].find(f => existsSync(join(dir, f)))
  const packPath = join(dir, 'pack.zip')
  const hasPack = existsSync(packPath)
  // 缩略图（上传后台生成）：thumbs/<同名>.jpg；LQIP 占位图：thumbs/<同名>.lqip.jpg（极小，内联为模糊占位）
  const thumbAll = listImages(join(dir, 'thumbs')).filter(f => !f.endsWith('.lqip.jpg'))
  const thumbSet = new Set(thumbAll)
  const hasThumbs = thumbAll.length > 0
  // 每张原图用哪个缩略图文件：优先 .webp（体积约为 jpg 的一半），jpg 作为老浏览器回退
  const thumbFor = {}, thumbAlt = {}
  for (const f of images) {
    const webp = f.replace(/\.[^.]+$/, '.webp')
    if (thumbSet.has(webp)) {
      thumbFor[f] = webp
      if (thumbSet.has(f)) thumbAlt[f] = f
    } else if (thumbSet.has(f)) thumbFor[f] = f
  }
  const thumbs = Object.values(thumbFor)
  const coverThumb = ['cover.webp', 'cover.jpg', 'cover.jpeg', 'cover.png'].find(f => existsSync(join(dir, 'thumbs', f)))
  // 封面模糊占位图（内联到卡片背景）：图片还没加载完时也不会是一片空白
  const coverLqipPath = join(dir, 'thumbs', 'cover.lqip.jpg')
  const coverLqip = existsSync(coverLqipPath)
    ? 'data:image/jpeg;base64,' + readFileSync(coverLqipPath).toString('base64')
    : ''
  // 隐藏套图：公共的模糊小图（后台生成），以及密码算出来的私有地址 token
  const blurThumb = ['blur.webp', 'blur.jpg'].find(f => existsSync(join(dir, 'thumbs', f)))
  const blurFile = ['blur.jpg', 'blur.webp', 'blur.png'].find(f => existsSync(join(dir, f)))
  const hidden = !!meta.hidden
  const hidePassword = String(meta.hidePassword || '')
  const hiddenOk = hidden && !!(hidePassword || HIDDEN_PW)
  // 自定义 Banner（后台裁剪生成，置顶轮播用；没设置就退回封面）
  const bannerFile = ['banner.jpg', 'banner.jpeg', 'banner.png', 'banner.webp'].find(f => existsSync(join(dir, f)))
  const bannerThumb = ['banner.webp', 'banner.jpg', 'banner.jpeg', 'banner.png'].find(f => existsSync(join(dir, 'thumbs', f)))
  // 缩略图版本戳：文件变了 URL 就变，避免读到旧缓存
  const thumbVer = {}
  for (const f of [...thumbs, coverThumb, bannerThumb].filter(Boolean)) thumbVer[f] = fileVer(join(dir, 'thumbs', f))
  // 模糊占位图（LQIP）：只内联前 N 张（默认 12）——整套图都展示时，几百张的 base64 会把 HTML 撑到几百 KB，
  // 而布局高度是构建时按 data-ratio 算好的，后面的图没有占位也不会跳动。
  const lqip = {}
  const lqipMax = Number(config.lqipCount ?? 12)
  for (const f of (lqipMax > 0 ? images.slice(0, lqipMax) : images)) {
    const p = join(dir, 'thumbs', f.replace(/\.[^.]+$/, '.lqip.jpg'))
    if (existsSync(p)) lqip[f] = 'data:image/jpeg;base64,' + readFileSync(p).toString('base64')
  }

  const date = meta.date || new Date(statSync(metaPath).mtime).toISOString().slice(0, 10)
  // 入库时间：同一天发布的图集很多，"最新发布"需要次级排序才能把刚上传的排到最前
  const addedAt = meta.addedAt || new Date(statSync(metaPath).mtime).toISOString().slice(0, 19)
  const series = meta.series || ''
  const model = meta.model || ''
  const rawTitle = meta.title || slug
  // 每套原图总大小：按 images/ 里真实文件字节数累加（标题里的 [41P-426MB] 也是这个口径）
  let bytes = 0
  for (const f of images) { try { bytes += statSync(join(dir, 'images', f)).size } catch {} }
  const sizeText = fmtSize(bytes)
  // 列表页显示标题：[系列]日期 主题 模特[图片数P／大小]
  const displayTitle = meta.displayTitle || [
    series ? `[${series}]` : '',
    date ? `${date} ` : '',
    rawTitle,
    model ? ` ${model}` : '',
    `[${meta.imageCount || images.length}P${hasPack || meta.packSize ? `／${meta.packSize || fmtSize(statSync(packPath).size)}` : ''}]`,
  ].join('')

  const out = {
    slug,
    dir,
    title: rawTitle,
    displayTitle,
    series,
    model,
    date,
    addedAt,
    // 置顶推荐：pinned + 可选 pinOrder（多套先后）/ pinUntil（到期自动失效）
    pinned: (() => {
      if (!meta.pinned) return false
      const until = String(meta.pinUntil || '').trim()
      if (until && /^\d{4}-\d{2}-\d{2}$/.test(until) && until < new Date().toISOString().slice(0, 10)) return false
      return true
    })(),
    pinOrder: Number(meta.pinOrder) || 0,
    pinUntil: meta.pinUntil || '',
    tags: meta.tags || [],
    description: meta.description || '',
    password: meta.password || '',
    shareCode: meta.shareCode || '',
    netdisk: meta.netdisk || '',
    downloadUrl: meta.downloadUrl || (hasPack ? `pack.zip` : ''),
    resolution: meta.resolution || '',
    imageCount: meta.imageCount || images.length,
    packSize: meta.packSize || (hasPack ? fmtSize(statSync(packPath).size) : ''),
    bytes,
    sizeText,
    hasPack,
    packPath: hasPack ? packPath : null,
    coverFile,
    coverThumb,
    coverLqip,
    bannerFile,
    bannerThumb,
    blurThumb,
    blurFile,
    hidden,
    hiddenOk,
    hidePassword,
    token: hiddenOk ? hiddenToken({ slug, hidePassword }) : '',
    images,
    thumbs,
    thumbFor,
    thumbAlt,
    thumbVer,
    hasThumbs,
    lqip,
    modelInfo: meta.modelInfo || '',
    profile: { ...modelProfile(model), ...(meta.profile || {}) },
    openlistDir: meta.openlistDir || '',
    sizes: Object.fromEntries(images.map(f => [f, imageSize(join(dir, 'images', f))])),
    // 预览图：默认展示整套（缩略图已全部生成，页面上按需懒加载）；某套想限制数量就在它的 meta.json 里写 previewCount
    previews: (() => {
      const want = meta.previewCount !== undefined ? Number(meta.previewCount) : Number(config.previewCount)
      return (!want || want <= 0) ? images : images.slice(0, want)
    })(),
  }
  // 没有本地压缩包、也没手填外链时，用 OpenList 目录兜底当下载入口
  out.olDir = olDirUrl(out)
  if (out.olDir) {
    if (!out.netdisk) out.netdisk = (OL.label || 'OpenList')
    if (!out.downloadUrl) out.downloadUrl = out.olDir
  }
  return out
}

// ─────────────────────────── 相关推荐 / 分类页 ───────────────────────────

/** 计算某套图集的相关推荐（同系列 > 同模特 > 共享标签多者优先）
 *  条数由 site.json 的 relatedCount 控制，默认 4（正好一行）*/
function relatedSets(set, all, limit = config.relatedCount || 4) {
  return all
    .filter(s => s.slug !== set.slug)
    .map(s => {
      let score = 0
      if (set.series && s.series === set.series) score += 5
      if (set.model && s.model === set.model) score += 4
      const shared = (s.tags || []).filter(t => (set.tags || []).includes(t)).length
      score += shared * 2
      return { s, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || (b.s.date || '').localeCompare(a.s.date || ''))
    .slice(0, limit)
    .map(x => x.s)
}

/** 系列页 / 标签页（静态化，利于搜索引擎收录） */
function collectionPage(kind, name, sets, all, rel = '../', cloud = []) {
  const label = kind === 'series' ? '系列' : '标签'
  // 该分类的合计体量：套数 + 张数 + 总大小（按每套真实字节累加）
  const catBytes = sets.reduce((n, s) => n + (s.bytes || 0), 0)
  const catCount = sets.reduce((n, s) => n + (s.imageCount || 0), 0)
  const catSize = catBytes ? fmtSize(catBytes) : ''
  const cloudHtml = cloud.length
    ? `<section class="cloud-sec">
    <h2 class="sec-title">全部${label}（${cloud.length}）<span class="dim" style="font-size:13px;font-weight:400"> · 点任意一个直接切换</span></h2>
    <div class="chips-cloud">${cloud.map(([n, list]) =>
      `<a class="cloud-chip${n === name ? ' on' : ''}" href="${rel}${kind}/${encodeURIComponent(n)}.html">${kind === 'tag' ? '#' : ''}${esc(n)}<span>${Array.isArray(list) ? list.length : list}</span></a>`).join('')}</div>
  </section>`
    : ''
  const body = `
  <nav class="breadcrumb"><a href="${rel}index.html">首页</a><span>/</span><a href="${rel}collections.html#${kind}">${label}</a><span>/</span><span class="cur">${esc(name)}</span></nav>
  <div class="page-head">
    <h1>${esc(name)}</h1>
    <p class="sub">${label}「${esc(name)}」共 ${sets.length} 套图集${catSize ? ` · ${catCount} 张 · 合计 <b class="size-strong">${esc(catSize)}</b>` : ''}</p>
  </div>
  <div class="grid">${sets.map((s, i) => card(s, rel, { eager: i < 8 })).join('')}</div>
  <p class="more-hint"><a href="${rel}index.html" class="dim">← 返回全部图集</a></p>
  ${cloudHtml}`
  const url = pageUrl(`${kind === 'series' ? 'series' : 'tag'}/${encodeURIComponent(name)}.html`)
  return layout({
    title: `${name} · ${label} - ${config.siteName}`,
    desc: `${label}「${name}」下的全部图集，共 ${sets.length} 套${catSize ? `、${catCount} 张、合计 ${catSize}` : ''}。${config.siteSubtitle}`,
    body, rel,
    canonical: url,
    og: { type: 'website', url },
  })
}

// ─────────────────────────── 模板 ───────────────────────────
/** 全站是否真的有隐藏套图（决定要不要在头部显示 🔒 入口）；由主流程赋值 */
let hiddenCountGlobal = 0

const layout = ({ title, desc, body, rel = '', nav = '', pswp = false, og = null, canonical = '', jsonld = '', noindex = false }) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
${og ? `<meta property="og:type" content="${esc(og.type || 'website')}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
${og.image ? `<meta property="og:image" content="${esc(og.image)}">` : ''}
<meta property="og:site_name" content="${esc(config.siteName)}">
${og.url ? `<meta property="og:url" content="${esc(og.url)}">` : ''}
<meta name="twitter:card" content="summary_large_image">` : ''}
<link rel="alternate" type="application/rss+xml" href="${rel}feed.xml" title="${esc(config.siteName)}">
<link rel="stylesheet" href="${rel}assets/style.css?v=${ASSET_V}">
${pswp ? `<link rel="stylesheet" href="${rel}assets/photoswipe/photoswipe.css?v=5.4.4">
<link rel="stylesheet" href="${rel}assets/photoswipe-extra.css?v=${ASSET_V}">` : ''}
${jsonld ? `<script type="application/ld+json">${jsonld}</script>` : ''}
${ANALYTICS}
</head>
<body>
${ADULT_GATE}
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="${rel}index.html">
      <span class="brand-mark">◈</span>
      <span class="brand-text"><strong>${esc(config.siteName)}</strong><small>${esc(config.siteSubtitle)}</small></span>
    </a>
    <div class="header-search">
      <input id="q" type="search" placeholder="搜索标题 / 模特 / 标签…" autocomplete="off">
    </div>
    <button class="icon-btn" id="randomBtn" title="随便看看">🎲</button>
    <button class="icon-btn" id="themeBtn" title="切换深浅色">🌗</button>
    ${hiddenCountGlobal ? `<button class="icon-btn" id="lockBtn" title="输入密码查看隐藏图集">🔒</button>` : ''}
    <a class="icon-btn" href="${rel}models.html" title="模特列表">👤</a>
    <a class="icon-btn" href="${rel}collections.html" title="系列与标签">☰</a>
  </div>
  ${nav}
</header>
<main class="wrap">${body}</main>
<footer class="site-footer">
  <div class="wrap">
    <p>${esc(config.siteName)} · 静态生成 · <span id="set-total">${SITE_BITS || ''}</span></p>
    <p class="foot-links">
      <a href="${rel}models.html">模特</a>
      <a href="${rel}collections.html">系列与标签</a>
      <a href="${rel}about.html">免责声明</a>
      ${config.privacy ? `<a href="${rel}privacy.html">隐私政策</a>` : ''}
      <a href="${rel}feed.xml">RSS</a>
    </p>
    ${config.disclaimer ? `<p class="foot-note">${esc(config.disclaimer)}</p>` : ''}
    ${config.icp ? `<p class="icp">${esc(config.icp)}</p>` : ''}
  </div>
</footer>
<script src="${rel}assets/app.js?v=${ASSET_V}" defer></script>
<script>window.PN_REL=${JSON.stringify(rel)};window.PN_HIDDEN_HINT=${JSON.stringify(HIDDEN_HINT)};</script>
</body>
</html>`

/** 卡片上的「模特行」：头像 + 名字 · 日期（名字与日期都是浅灰、挨在一起用圆点分隔） */
function cardModelRow(s, rel = '', opts = {}) {
  const face = !opts.noModel && s.model ? MODEL_FACE[s.model] : ''
  const avatar = face
    ? `<a class="card-avatar" href="${rel}model/${encodeURIComponent(s.model)}.html" aria-label="${esc(s.model)} 的全部作品"><img loading="lazy" src="${rel}${face}" alt="${esc(s.model)}"></a>`
    : ''
  const name = (!opts.noModel && s.model)
    ? `<a class="card-model-name" href="${rel}model/${encodeURIComponent(s.model)}.html">${esc(s.model)}</a><span class="sep">·</span>`
    : ''
  return `${avatar}${name}<time datetime="${esc(s.date)}">${esc(slashDate(s.date))}</time>`
}

/** 日期显示成 2026/09/13 这种斜杠格式（datetime 属性仍用标准 ISO 写法） */
const slashDate = (d) => String(d || '').replace(/-/g, '/')

const card = (s, rel = '', opts = {}) => (s.hidden && !s.hiddenOk)
  // 隐藏但没配密码（构建时算不出私有地址）→ 只给一张糊图，没有任何入口
  ? `<article class="card card-locked" data-hid="${esc(s.slug)}">
  <div class="card-cover locked"${s.coverLqip ? ` style="background-image:url(${s.coverLqip})"` : ''}>
    ${s.blurThumb ? `<img class="blurred" src="${rel}blur/${esc(s.slug)}.webp" alt="">` : '<div class="no-cover">🔒</div>'}
    <span class="badge badge-lock">🔒 隐藏</span>
  </div>
  <h2 class="card-title">${esc(s.title)}</h2>
  <div class="card-model">${cardModelRow(s, rel, opts)}</div>
  <div class="card-meta"><span class="lock-hint">还没设置隐藏密码</span></div>
</article>`
  : s.hiddenOk
  ? `<article class="card card-locked" data-hid="${esc(s.slug)}"${s.blurThumb ? ` data-cover="${esc(s.coverThumb || '')}"` : ''}>
  <div class="card-cover locked"${s.coverLqip ? ` style="background-image:url(${s.coverLqip})"` : ''}>
    ${s.blurThumb ? `<img class="blurred"${opts.eager ? '' : ' loading="lazy"'} src="${rel}blur/${esc(s.slug)}.webp" alt="${esc(s.title)}">` : '<div class="no-cover">🔒</div>'}
    <span class="badge badge-lock">🔒 隐藏</span>
  </div>
  <h2 class="card-title">${esc(s.title)}</h2>
  <div class="card-model">${cardModelRow(s, rel, opts)}</div>
  <div class="card-meta">
    <button class="unlock-btn" data-hid="${esc(s.slug)}" title="${esc(HIDDEN_HINT)}">🔓 输入密码查看</button>
    ${s.dupTag && s.dupTag !== s.model ? `<span class="tag tag-model" title="同名作品，用它区分">${esc(s.dupTag)}</span>` : ''}
  </div>
</article>`
  : `
<article class="card" data-title="${esc((s.displayTitle + ' ' + s.model + ' ' + s.tags.join(' ')).toLowerCase())}">
  <a class="card-link cover-link" href="${rel}set/${s.slug}/index.html" aria-label="${esc(s.title)}">
    <div class="card-cover"${s.coverLqip ? ` style="background-image:url(${s.coverLqip})"` : ''}>
      ${s.coverFile
        ? `<img${opts.eager ? ' fetchpriority="high"' : ' loading="lazy"'} src="${rel}set/${s.slug}/${s.coverThumb ? 'thumbs/' + s.coverThumb + verQ(s.thumbVer[s.coverThumb]) : s.coverFile}" alt="${esc(s.title)}">`
        : `<div class="no-cover">无封面</div>`}
      <span class="badge">${s.imageCount}P</span>
      ${s.sizeText ? `<span class="badge badge-size" title="原图总大小 ${esc(s.sizeText)}">${esc(s.sizeText)}</span>` : (s.packSize ? `<span class="badge badge-size">${esc(s.packSize)}</span>` : '')}
      ${s.pinned ? '<span class="badge badge-pin" title="置顶推荐">📌 置顶</span>' : ''}
    </div>
  </a>
  <a class="card-link title-link" href="${rel}set/${s.slug}/index.html"><h2 class="card-title">${esc(s.title)}</h2></a>
  <div class="card-model">${cardModelRow(s, rel, opts)}</div>
  <div class="card-meta">
    ${s.dupTag && s.dupTag !== s.model ? `<span class="tag tag-model" title="同名作品，用它区分">${esc(s.dupTag)}</span>` : ''}
    ${s.series ? `<a class="tag tag-series" href="${rel}series/${encodeURIComponent(s.series)}.html" title="查看该系列全部图集">${esc(s.series)}</a>` : ''}
    ${s.tags.slice(0, 2).map(t => `<a class="tag tag-link" href="${rel}tag/${encodeURIComponent(t)}.html" title="查看同标签图集">${esc(t)}</a>`).join('')}
  </div>
</article>`

/**
 * 分页组件：沿用 Bootstrap 5 分页的规范（.pagination / .page-item / .page-link / .active / .disabled）
 * —— 成熟的交互规范：首页/上一页 + 页码窗口 + 省略号 + 下一页/末页，当前页高亮。
 * 静态站里这些是真实 <a> 链接（可被爬虫跟、可新窗口打开），不需要任何 JS 运行时。
 */
function pagerHtml(page, totalPages, hrefOf) {
  if (totalPages <= 1) return ''
  const WINDOW = 2                     // 当前页左右各显示 2 页
  const nums = new Set([1, totalPages])
  for (let p = page - WINDOW; p <= page + WINDOW; p++) if (p >= 1 && p <= totalPages) nums.add(p)
  const list = [...nums].sort((a, b) => a - b)
  const item = (inner, extra = '') => `<li class="page-item${extra ? ' ' + extra : ''}">${inner}</li>`
  const link = (p, label, aria = '') => item(`<a class="page-link" href="${hrefOf(p)}"${aria}>${label}</a>`)
  const dead = (label) => item(`<span class="page-link">${label}</span>`, 'disabled')
  const out = []
  out.push(page > 1 ? link(1, '« <span class="pg-word">首页</span>') : dead('« <span class="pg-word">首页</span>'))
  out.push(page > 1 ? link(page - 1, '‹ <span class="pg-word">上一页</span>') : dead('‹ <span class="pg-word">上一页</span>'))
  let prev = 0
  for (const p of list) {
    if (prev && p - prev > 1) out.push(item('<span class="page-link">…</span>', 'disabled'))
    out.push(p === page
      ? item(`<span class="page-link" aria-current="page">${p}</span>`, 'active')
      : link(p, String(p)))
    prev = p
  }
  out.push(page < totalPages ? link(page + 1, '<span class="pg-word">下一页</span> ›') : dead('<span class="pg-word">下一页</span> ›'))
  out.push(page < totalPages ? link(totalPages, '<span class="pg-word">末页</span> »') : dead('<span class="pg-word">末页</span> »'))
  return `<nav class="pagination-wrap static-pager" aria-label="分页导航">
    <ul class="pagination">${out.join('')}</ul>
    <p class="pagination-info">第 ${page} / ${totalPages} 页</p>
  </nav>`
}

/** 置顶推荐轮播（列表页顶部；没有置顶图集时返回空串，页面自动退回标题样式）
 *  布局：左边 16:9 轮播舞台 + 右边置顶清单（点清单可切换，不用等自动播放）
 *  隐藏图集也能置顶：轮播里只显示模糊封面 + 🔒，点击要输密码（解锁后自动换成真实封面） */
function heroHtml(pinned, rel = '') {
  if (!pinned.length) return ''
  // 轮播大图：后台裁过 Banner 就用 Banner（默认仍用封面）；隐藏图集用公开的模糊小图
  const pic = (s) => s.hidden
    ? (s.blurThumb ? { f: `../blur/${encodeURIComponent(s.slug)}.webp`, v: '', banner: false, locked: true } : null)
    : (s.bannerThumb ? { f: 'thumbs/' + s.bannerThumb, v: s.thumbVer[s.bannerThumb], banner: true }
      : (s.coverThumb ? { f: 'thumbs/' + s.coverThumb, v: s.thumbVer[s.coverThumb], banner: false }
        : (s.coverFile ? { f: s.coverFile, v: '', banner: false } : null)))
  // 解锁后要换成哪张图（隐藏图集用它的 Banner/封面）
  const unlockCover = (s) => s.bannerThumb || s.coverThumb || ''
  const slides = pinned.map((s, i) => {
    const p = pic(s)
    const img = p ? `<img class="${p.locked ? 'blurred' : p.banner ? 'is-banner' : ''}" src="${s.hidden ? `${rel}blur/${encodeURIComponent(s.slug)}.webp` : `${rel}set/${s.slug}/${p.f}${verQ(p.v)}`}" alt="${esc(s.title)}"${i ? ' loading="lazy"' : ''}>` : ''
    const info = `
      <span class="hero-info">
        <span class="hero-badge">${s.hidden ? '🔒 置顶 · 隐藏' : '📌 置顶推荐'}</span>
        <h2>${esc(s.title)}</h2>
        <span class="hero-meta">${s.hidden
          ? `${[s.model].filter(Boolean).map(esc).join(' · ')}${s.model ? ' · ' : ''}隐藏图集，输入密码后查看`
          : [s.model, `${s.imageCount} 张`, s.sizeText].filter(Boolean).map(esc).join(' · ')}</span>
        ${s.hidden ? `<button class="unlock-btn hero-unlock" data-hid="${esc(s.slug)}">🔓 输入密码查看</button>` : ''}
      </span>`
    return s.hidden
      ? `
    <div class="hero-slide locked${i ? '' : ' on'}" data-hid="${esc(s.slug)}"${unlockCover(s) ? ` data-cover="${esc(unlockCover(s))}"` : ''} aria-label="${esc(s.title)}（隐藏）">
      ${img}${info}
    </div>`
      : `
    <a class="hero-slide${i ? '' : ' on'}" href="${rel}set/${s.slug}/index.html" aria-label="${esc(s.title)}">
      ${img}${info}
    </a>`
  }).join('')
  const multi = pinned.length > 1
  const dots = multi
    ? `<div class="hero-dots">${pinned.map((_, i) => `<button class="hero-dot${i ? '' : ' on'}" aria-label="第 ${i + 1} 张"></button>`).join('')}</div>`
    : ''
  const nav = multi
    ? `<button class="hero-nav hero-prev" aria-label="上一张">‹</button><button class="hero-nav hero-next" aria-label="下一张">›</button>`
    : ''
  const list = multi ? `<aside class="hero-list">
      <div class="hero-list-inner">
        <h3>📌 置顶推荐（${pinned.length}）</h3>
        ${pinned.map((s, i) => `<a class="hero-item${i ? '' : ' on'}${s.hidden ? ' is-hidden' : ''}"${s.hidden
          ? ` data-hid="${esc(s.slug)}"${unlockCover(s) ? ` data-cover="${esc(unlockCover(s))}"` : ''}`
          : ` href="${rel}set/${s.slug}/index.html"`} data-i="${i}">
          ${s.hidden
            ? (s.blurThumb ? `<img class="blurred" src="${rel}blur/${encodeURIComponent(s.slug)}.webp" alt="" loading="lazy">` : '')
            : (s.coverFile ? `<img src="${rel}set/${s.slug}/${s.coverThumb ? 'thumbs/' + s.coverThumb + verQ(s.thumbVer[s.coverThumb]) : s.coverFile}" alt="" loading="lazy">` : '')}
          <span class="hero-item-text"><b>${s.hidden ? '🔒 ' : ''}${esc(s.title)}</b><span>${s.hidden
            ? '隐藏图集 · 输入密码查看'
            : [s.model, `${s.imageCount} 张`, s.sizeText].filter(Boolean).map(esc).join(' · ')}</span></span>
        </a>`).join('')}
      </div>
    </aside>` : ''
  return `<section class="hero${multi ? '' : ' single'}" id="hero" aria-label="置顶推荐">
    <div class="hero-stage">
      <div class="hero-track">${slides}</div>${nav}${dots}
    </div>
    ${list}
  </section>`
}

function listPage(sets, page, totalPages, rel = '', total = sets.length, allSets = null, pinned = []) {
  const hasHero = page === 1 && pinned.length > 0
  const body = `
  ${hasHero ? heroHtml(pinned, rel) : ''}
  <div class="page-head"${hasHero ? ' hidden' : ''}>${hasHero ? '' : '<h1>全部图集</h1>'}</div>
  <div class="filters" id="filters">
    <span class="filter-label">排序</span>
    <span class="sort-chips" id="sortChips" role="group" aria-label="排序方式">
      <button type="button" class="on" data-sort="date-desc">最新发布</button>
      <button type="button" data-sort="date-asc">最早发布</button>
      <button type="button" data-sort="count-desc">图片最多</button>
      <button type="button" data-sort="size-desc">体积最大</button>
      <button type="button" data-sort="title-asc">标题排序</button>
    </span>
    <span class="filter-chips" id="filterChips"></span>
  </div>
  <div class="grid" id="grid">${sets.map((s, i) => card(s, rel, { eager: i < 8 })).join('')}</div>
  <p class="empty" id="empty" hidden>没有匹配的图集</p>
  <div id="clientPager"></div>
  ${pagerHtml(page, totalPages, p => rel + (p === 1 ? 'index.html' : `page/${p}.html`))}
  <button class="to-top" id="toTop" hidden title="回到顶部">↑</button>`
  return layout({
    title: page === 1 ? `${config.siteName} · ${config.siteSubtitle}` : `${config.siteName} · 第 ${page} 页`,
    desc: config.siteSubtitle,
    body,
    rel,
    og: { type: 'website', url: pageUrl(page === 1 ? 'index.html' : `page/${page}.html`) },
    canonical: pageUrl(page === 1 ? 'index.html' : `page/${page}.html`),
  })
}

// ── 模特资料渲染（详情页侧栏与模特页共用）──
// 顺序：出生 → 星座 → 常驻 → 身高/体重/三围/鞋码 → 风格 → 其他；label 为空的字段本身已说明含义
const PF_ORDER = [
  ['birth', '出生'], ['sign', ''], ['city', ''],
  ['height', '身高'], ['weight', '体重'], ['measure', '三围'], ['shoes', '鞋码'],
  ['style', ''], ['other', ''],
]
const PF_SOCIAL = { weibo: '微博', douyin: '抖音', x: 'X', ins: 'Instagram', bilibili: 'B站', xhs: '小红书' }
// 社交账号按关键词搜索，避免写错主页地址
const socialUrl = (k, v) => {
  const clean = String(v).replace(/^@/, '')
  return {
    weibo: 'https://s.weibo.com/weibo?q=' + encodeURIComponent(clean),
    douyin: 'https://www.douyin.com/search/' + encodeURIComponent(clean),
    bilibili: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(clean),
    xhs: 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(clean),
    x: 'https://x.com/search?q=' + encodeURIComponent(clean),
    ins: 'https://www.instagram.com/' + encodeURIComponent(clean),
  }[k] || ''
}
/** 模特资料字段 → { parts: 文字片段, socials: 社交片段 }（供引文版和侧栏卡片版共用） */
function profileBits(pf = {}) {
  const parts = []
  PF_ORDER.forEach(([k, label]) => {
    if (!pf[k]) return
    const v = String(pf[k]).trim()
    if (!label) { parts.push(esc(v)); return }
    // 「1998 年」→「1998 年出生」读起来更顺
    parts.push(k === 'birth' && /^\d{4}\s*年?$/.test(v) ? esc(v.replace(/\s*年?$/, ' 年出生')) : esc(`${label} ${v}`))
  })
  const socials = Object.keys(PF_SOCIAL).filter(k => pf[k]).map(k => {
    const v = String(pf[k])
    const u = socialUrl(k, v)
    return `${PF_SOCIAL[k]} ${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v)}`
  })
  return { parts, socials }
}
/** 模特资料 → 一段引文式 HTML（没填任何字段就返回空串） */
function profileQuoteHtml(pf = {}, extraClass = '') {
  const { parts, socials } = profileBits(pf)
  if (!parts.length && !socials.length) return ''
  return `<blockquote class="pf-quote${extraClass ? ' ' + extraClass : ''}">`
    + (parts.length ? `<p>${parts.join(' · ')}</p>` : '')
    + (socials.length ? `<p class="pf-social">${socials.join(' · ')}</p>` : '')
    + '</blockquote>'
}
/** 单个模特的页面：资料引文 + 该模特的全部图集（按系列分组时给出系列芯片）*/
function modelPage(name, list, rel = '../') {
  const pf = modelProfile(name)
  const bytes = list.reduce((n, s) => n + (s.bytes || 0), 0)
  const imgs = list.reduce((n, s) => n + (s.imageCount || 0), 0)
  const latest = list.map(s => s.date || '').sort().pop() || ''
  const seriesList = [...new Set(list.map(s => s.series).filter(Boolean))]
  const body = `
  <nav class="breadcrumb"><a href="${rel}index.html">首页</a><span>/</span><a href="${rel}models.html">模特</a><span>/</span><span class="cur">${esc(name)}</span></nav>
  <div class="page-head model-head">
    <h1>${avatarHtml(name, rel, 'md') || '👤 '}${esc(name)}</h1>
    <p class="sub">共 ${list.length} 套图集 · ${imgs} 张${bytes ? ` · 合计 <b class="size-strong">${esc(fmtSize(bytes))}</b>` : ''}${latest ? ` · 最新 ${esc(latest)}` : ''}</p>
  </div>
  ${profileQuoteHtml(pf)}
  ${seriesList.length ? `<div class="chips-cloud" style="margin:0 0 18px">${seriesList.map(n =>
    `<a class="cloud-chip" href="${rel}series/${encodeURIComponent(n)}.html">${esc(n)}<span>${list.filter(s => s.series === n).length}</span></a>`).join('')}</div>` : ''}
  <div class="grid">${list.map((s, i) => card(s, rel, { noModel: true, eager: i < 8 })).join('')}</div>
  <p class="more-hint"><a href="${rel}models.html" class="dim">← 全部模特</a></p>`
  const url = pageUrl(`model/${encodeURIComponent(name)}.html`)
  return layout({
    title: `${name} 的全部作品（${list.length} 套） - ${config.siteName}`,
    desc: `${name} 的图集合集，共 ${list.length} 套${imgs ? `、${imgs} 张` : ''}${bytes ? `、合计 ${fmtSize(bytes)}` : ''}。`,
    body, rel, canonical: url,
    og: { type: 'profile', url },
    jsonld: `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'CollectionPage', name: `${name} 的全部作品`,
      url, numberOfItems: list.length, about: { '@type': 'Person', name },
    })}</script>`,
  })
}

/** 模特列表页（类似同类站的 /cosers）：每位模特一张卡，点进去是该模特的独立页 */
function modelsIndexPage(byModel, allSets) {
  const entries = Object.entries(byModel).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh-CN'))
  const bytes = allSets.reduce((n, s) => n + (s.bytes || 0), 0)
  const cards = entries.map(([name, list]) => {
    const pf = modelProfile(name)
    // 封面：优先该模特最新一套**公开**图集；全是隐藏套图时用公开的模糊小图（否则会 404）
    const latest = list.slice().sort((a, b) => cmpDateDesc(a, b))[0]
    const face = list.filter(s => !s.hidden && s.coverFile).sort((a, b) => cmpDateDesc(a, b))[0] || latest
    const b = list.reduce((n, s) => n + (s.bytes || 0), 0)
    const chips = [pf.birth, pf.height, pf.style, pf.city].filter(Boolean).slice(0, 3)
      .map(v => `<span class="tag">${esc(v)}</span>`).join('')
    return `<article class="card">
    <a class="card-link cover-link" href="model/${encodeURIComponent(name)}.html" aria-label="${esc(name)}">
      <div class="card-cover"${face.coverLqip ? ` style="background-image:url(${face.coverLqip})"` : ''}>
        ${setCoverUrl(face)
          ? `<img loading="lazy"${face.hidden ? ' class="blurred"' : ''} src="${setCoverUrl(face)}" alt="${esc(name)}">`
          : '<div class="no-cover">无封面</div>'}
        <span class="badge">${list.length} 套</span>
        ${b ? `<span class="badge badge-size">${esc(fmtSize(b))}</span>` : ''}
      </div>
    </a>
    <a class="card-link title-link" href="model/${encodeURIComponent(name)}.html"><h2 class="card-title">${esc(name)}</h2></a>
    <div class="card-model">
      ${MODEL_FACE[name] ? `<a class="card-avatar" href="model/${encodeURIComponent(name)}.html" aria-label="${esc(name)}"><img loading="lazy" src="${MODEL_FACE[name]}" alt="${esc(name)}"></a>` : ''}
      <time datetime="${esc(latest ? latest.date : '')}">最新 ${esc(slashDate(latest ? latest.date : ''))}</time>
    </div>
    <div class="card-meta">
      <span class="card-chips">${chips}</span>
    </div>
  </article>`
  }).join('')
  const body = `
  <div class="page-head">
    <h1>模特</h1>
    <p class="sub">共 ${entries.length} 位模特 · ${allSets.length} 套图集 · ${allSets.reduce((n, s) => n + (s.imageCount || 0), 0)} 张${bytes ? ` · 合计 <b class="size-strong">${esc(fmtSize(bytes))}</b>` : ''}</p>
  </div>
  <div class="grid">${cards}</div>
  <p class="more-hint"><a href="collections.html" class="dim">按系列与标签浏览 →</a></p>`
  return layout({
    title: `模特列表 - ${config.siteName}`,
    desc: `${config.siteName} 收录的全部模特，共 ${entries.length} 位、${allSets.length} 套图集。`,
    body, rel: '', canonical: pageUrl('models.html'),
    og: { type: 'website', url: pageUrl('models.html') },
  })
}

/** 系列列表页（有系列时才生成）：每个系列一张卡 */
function seriesIndexPage(bySeries, allSets) {
  const entries = Object.entries(bySeries).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh-CN'))
  const cards = entries.map(([name, list]) => {
    const latest = list.slice().sort((a, b) => cmpDateDesc(a, b))[0]
    const face = list.filter(s => !s.hidden && s.coverFile).sort((a, b) => cmpDateDesc(a, b))[0] || latest
    const b = list.reduce((n, s) => n + (s.bytes || 0), 0)
    const models = [...new Set(list.map(s => s.model).filter(Boolean))]
    return `<article class="card">
    <a class="card-link" href="series/${encodeURIComponent(name)}.html">
      <div class="card-cover"${face.coverLqip ? ` style="background-image:url(${face.coverLqip})"` : ''}>
        ${setCoverUrl(face)
          ? `<img loading="lazy"${face.hidden ? ' class="blurred"' : ''} src="${setCoverUrl(face)}" alt="${esc(name)}">`
          : '<div class="no-cover">无封面</div>'}
        <span class="badge">${list.length} 套</span>
        ${b ? `<span class="badge badge-size">${esc(fmtSize(b))}</span>` : ''}
      </div>
      <h2 class="card-title">${esc(name)}</h2>
    </a>
    <div class="card-meta">
      ${models.slice(0, 2).map(m => `<span class="tag tag-model">${esc(m)}</span>`).join('')}
      <time datetime="${esc(latest ? latest.date : '')}">最新 ${esc(latest ? latest.date : '')}</time>
    </div>
  </article>`
  }).join('')
  const body = `
  <div class="page-head">
    <h1>系列</h1>
    <p class="sub">共 ${entries.length} 个系列 · ${entries.reduce((n, [, l]) => n + l.length, 0)} 套图集</p>
  </div>
  <div class="grid">${cards}</div>
  <p class="more-hint"><a href="models.html" class="dim">按模特浏览 →</a> · <a href="collections.html" class="dim">全部标签 →</a></p>`
  return layout({
    title: `系列列表 - ${config.siteName}`,
    desc: `${config.siteName} 的全部系列，共 ${entries.length} 个。`,
    body, rel: '', canonical: pageUrl('series.html'),
    og: { type: 'website', url: pageUrl('series.html') },
  })
}

function detailPage(s, prev, next, canonical = '', related = [], tagCounts = {}, moreSets = [], modelTotal = 0) {
  const rel = '../../'
  // 本页自己的资源目录：隐藏套图在 h/<token>/ 下，公开套图在 set/<slug>/ 下
  const self = s.hiddenOk ? `h/${s.token}` : `set/${s.slug}`
  // 指向另一套图的链接/封面：隐藏的套图不能直接给路径（算不出来），交给页面上的解锁脚本处理
  const setHref = (x) => (x.hidden ? '' : `${rel}set/${x.slug}/index.html`)
  const setCoverSrc = (x) => x.hidden
    ? (x.blurThumb ? `${rel}blur/${encodeURIComponent(x.slug)}.webp` : '')
    : (x.coverFile ? `${rel}set/${x.slug}/${x.coverThumb ? 'thumbs/' + x.coverThumb + verQ(x.thumbVer[x.coverThumb]) : x.coverFile}` : '')
  // 模特行：头像（后台设了就用圆形头像，否则用该模特另一套的封面）+ 名字 + 套数 → 点进模特页
  // 详情页不再放模特资料（出生/身高/风格…），资料统一只在模特页展示
  const face = moreSets[0] || s
  const modelAvatar = avatarUrl(s.model, rel)
  const modelRow = s.model ? `<a class="side-row" href="${rel}model/${encodeURIComponent(s.model)}.html" aria-label="${esc(s.model)} 的全部作品">
        ${modelAvatar
          ? `<span class="sr-art sr-round"><img loading="lazy" src="${modelAvatar}" alt="${esc(s.model)}"></span>`
          : `<span class="sr-art">${setCoverSrc(face)
            ? `<img loading="lazy" class="${face.hidden ? 'blurred' : ''}" src="${setCoverSrc(face)}" alt="${esc(s.model)}">`
            : '👤'}</span>`}
        <span class="sr-body"><b>${esc(s.model)}</b><span class="sr-meta">${modelTotal > 1 ? `${modelTotal} 套图集` : '全部作品'}</span></span>
        <span class="sr-go">›</span>
      </a>` : ''
  const seriesRow = s.series ? `<a class="side-row" href="${rel}series/${encodeURIComponent(s.series)}.html" title="查看「${esc(s.series)}」系列">
        <span class="sr-art sr-ico">📚</span>
        <span class="sr-body"><b>${esc(s.series)}</b><span class="sr-meta">系列全部</span></span>
        <span class="sr-go">›</span>
      </a>` : ''

  const previews = s.previews.length
    ? `<div class="previews" id="gallery">      ${s.previews.map((f, i) => {
        // 缩略图文件：优先 webp（体积约为 jpg 一半），jpg 作为老浏览器回退
        const tf = s.thumbFor[f] || f
        const alt = (s.thumbAlt && s.thumbAlt[f]) || ''
        const thumb = s.hasThumbs ? `thumbs/${tf}` : `images/${f}`
        const ph = s.lqip[f] ? `src="${s.lqip[f]}"` : ''
        const size = s.sizes[f] || { w: 1200, h: 1600 }
        // 精简模式：原图未随站点部署，画廊大图用缩略图 → 取缩略图真实像素（改 PREVIEW_W 后自动跟随）
        const tsz = s.hasThumbs ? imageSize(join(s.dir, 'thumbs', tf)) : null
        const bigW = LITE ? (tsz ? tsz.w : Math.min(size.w, 1920)) : size.w
        const bigH = LITE ? (tsz ? tsz.h : Math.round(bigW / (size.w / size.h))) : size.h
        // 原图直链：本地 01.jpg ↔ 网盘 00001.jpg（按序号映射）
        const fi = fileIndex(f)
        const olUrl = (s.olDir && fi) ? olFileUrl(s, olFileName(fi)) : ''
        const bigSrc = LITE ? `${rel}${self}/${thumb}${verQ(s.thumbVer[tf])}` : `${rel}${self}/images/${f}`
        return `<figure class="preview" data-ratio="${(size.w / size.h).toFixed(4)}">
        <a class="preview-link" href="${bigSrc}"
           data-pswp-width="${bigW}" data-pswp-height="${bigH}"
           data-pswp-srcset="${rel}${self}/${thumb}${verQ(s.thumbVer[tf])} ${bigW}w"
           data-orig-w="${size.w}" data-orig-h="${size.h}"
           target="_blank" rel="noopener">
          <img class="ph" ${ph} data-src="${rel}${self}/${thumb}${verQ(s.thumbVer[tf])}"
               ${alt ? `data-fallback="${rel}${self}/thumbs/${alt}${verQ(s.thumbVer[alt])}"` : ''}
               alt="${esc(s.title)} 预览图 ${i + 1}" decoding="async">
        </a>
        ${olUrl ? `<a class="orig-link" href="${esc(olUrl)}" target="_blank" rel="noopener" title="在${esc(s.netdisk || 'OpenList')}打开原图（${size.w}×${size.h}）">原图 ↗</a>` : ''}
        <figcaption>${i + 1} / ${s.imageCount}</figcaption>
      </figure>`
      }).join('')}
    </div>
    ${s.imageCount > s.previews.length ? `<p class="more-hint">本套共 ${s.imageCount} 张${s.sizeText ? ` · 总大小 ${esc(s.sizeText)}` : ''}，以上为部分预览 · ${s.olDir ? `完整原图请到 <a href="${esc(s.olDir)}" target="_blank" rel="noopener">${esc(s.netdisk || 'OpenList')}</a> 查看` : (s.downloadUrl ? `完整图集请点上方下载按钮${s.netdisk ? `（${esc(s.netdisk)}）` : ''}` : '完整图集请下载压缩包')}</p>` : ''}`
    : '<p class="empty">暂无预览图</p>'
  // 这行是"本页预览图的加载进度"（本页只放 N 张预览，不是整套的张数），
  // 所以分「加载中 / 已加载完」两种文案，避免 8/8 被误读成图集张数
  const streamHint = s.previews.length
    ? `<p class="stream-hint top" id="streamHint" data-total="${s.previews.length}">`
      + `<span id="hintLoading">正在加载本页预览 <span id="loadedCount">0</span> / ${s.previews.length} 张（向下滚动自动加载）</span>`
      + `<span id="hintDone" hidden>✓ 本页 ${s.previews.length} 张预览已加载完${s.imageCount > s.previews.length ? `（本套共 ${s.imageCount} 张）` : ''}</span>`
      + ` · <b>点击图片打开画廊</b>${s.olDir ? ' · 右上角「原图 ↗」直达原图' : ''}</p>`
    : ''

  // ── 右侧栏（参考同类站：下载 / 模特与系列 / 本套信息 / 热门标签）──
  const dlBtn = s.olDir
    ? `<a class="btn btn-primary side-dl" href="${esc(s.olDir)}" target="_blank" rel="noopener">⬇ 打开原图目录</a>`
    : (s.downloadUrl && !s.hasPack
      ? `<a class="btn btn-primary side-dl" href="${esc(s.downloadUrl)}" target="_blank" rel="noopener">⬇ 下载图集</a>`
      : (s.hasPack && !LITE
        ? `<a class="btn btn-primary side-dl" href="${rel}${self}/pack.zip" download>⬇ 下载压缩包</a>`
        : (s.hasPack && LITE
          ? `<span class="btn btn-disabled side-dl">压缩包未随站点部署</span>`
          : `<span class="btn btn-disabled side-dl">⬇ 下载链接待补充</span>`)))
  const hasDlTarget = !!(s.olDir || s.downloadUrl || s.hasPack)
  // 只显示"提取码 / 解压密码"这类真正需要的信息；网盘名字（如「夸克网盘」）不再展示
  const dlCodes = [
    hasDlTarget && s.shareCode ? `提取码 <code>${esc(s.shareCode)}</code>` : '',
    hasDlTarget && s.password ? `解压密码 <code>${esc(s.password)}</code>` : '',
  ].filter(Boolean)
  // 侧栏只放最热的 10 个标签（列表页/合集页有完整标签云）
  const hotTags = Object.entries(tagCounts || {}).sort((a, b) => b[1].length - a[1].length).slice(0, 10)
  const sideBlock = `
  <aside class="detail-side">
    <section class="side-box side-dl-box">
      <h3 class="side-title">⬇ 下载这套图</h3>
      <div class="side-dl-top">
        <div class="side-dl-wrap">${dlBtn}</div>
        ${dlCodes.length ? `<p class="side-note">${dlCodes.join(' · ')}</p>` : ''}
        ${s.imageCount > s.previews.length ? `<p class="side-note dim">本页展示前 ${s.previews.length} 张预览${hasDlTarget ? `，完整 ${s.imageCount} 张请点上方按钮` : `（共 ${s.imageCount} 张）`}</p>` : ''}
      </div>
      <dl class="side-info">
        <dt>图片数量</dt><dd>${s.imageCount} 张</dd>
        ${s.resolution ? `<dt>图片像素</dt><dd>${esc(s.resolution)}</dd>` : ''}
        ${s.sizeText ? `<dt>总大小</dt><dd>${esc(s.sizeText)}<span class="dim"> · 单张约 ${esc(fmtSize(Math.round(s.bytes / Math.max(1, s.imageCount))))}</span></dd>` : ''}
        ${s.packSize ? `<dt>压缩包</dt><dd>${esc(s.packSize)}</dd>` : ''}
        ${s.olDir ? `<dt>原图存放</dt><dd>${esc(s.netdisk || 'OpenList')}</dd>` : ''}
        <dt>发布时间</dt><dd>${esc(s.date)}</dd>
        ${s.password ? `<dt>解压密码</dt><dd><code>${esc(s.password)}</code></dd>` : ''}
      </dl>
    </section>
    ${(s.model || s.series) ? `<section class="side-box">
      <h3 class="side-title">👤 模特与系列</h3>
      <div class="side-rows">
        ${modelRow}
        ${seriesRow}
      </div>
      ${moreSets.length ? `<div class="side-sets">
        <p class="side-sub">${esc(s.model || s.series)} 的其他作品</p>
        ${moreSets.map(x => `<a class="side-set${x.hidden ? ' is-hidden' : ''}"${x.hidden ? ` data-hid="${esc(x.slug)}"${x.coverThumb ? ` data-cover="${esc(x.coverThumb)}"` : ''}` : ` href="${setHref(x)}"`} title="${esc(x.hidden ? '隐藏图集：' + x.title : x.title)}">
          <span class="ss-cover">${setCoverSrc(x)
            ? `<img loading="lazy" class="${x.hidden ? 'blurred' : ''}" src="${setCoverSrc(x)}" alt="${esc(x.title)}">`
            : ''}</span>
          <span class="ss-body">
            <b>${x.hidden ? '🔒 ' : ''}${esc(x.title)}</b>
            <span class="ss-meta">${x.hidden ? '隐藏图集 · 输入密码查看' : `${esc(x.date)} · ${x.imageCount}P${x.sizeText ? ' · ' + esc(x.sizeText) : (x.packSize ? ' · ' + esc(x.packSize) : '')}`}</span>
          </span>
        </a>`).join('')}
      </div>` : ''}
    </section>` : ''}
    ${hotTags.length ? `<section class="side-box">
      <h3 class="side-title">🏷 热门标签</h3>
      <div class="side-tags">${hotTags.map(([t, l]) =>
        `<a class="side-tag" href="${rel}tag/${encodeURIComponent(t)}.html">${esc(t)}<span>${l.length}</span></a>`).join('')}</div>
      <p class="side-note"><a href="${rel}collections.html#tags">查看全部标签 →</a></p>
    </section>` : ''}
  </aside>`

  const body = `
  ${PUBLIC ? '' : `<div class="admin-bar" id="adminBar" hidden>
    <a class="btn btn-primary sm" href="http://127.0.0.1:8091/edit?slug=${encodeURIComponent(s.slug)}">✎ 编辑这套图集</a>
    <a class="btn ghost sm" href="http://127.0.0.1:8091/">管理后台</a>
    <span class="dim">（仅带 ?admin=1 时显示 · 访客看不到）</span>
  </div>`}
  <nav class="breadcrumb"><a href="${rel}index.html">首页</a>${s.series ? `<span>/</span><a href="${rel}series/${encodeURIComponent(s.series)}.html">${esc(s.series)}</a>` : ''}<span>/</span><span class="cur">${esc(s.title)}</span></nav>
  <div class="detail-layout">
  <article class="detail">
    <h1 class="detail-title">${esc(s.title)}</h1>
    <div class="detail-meta">
      ${s.sizeText ? `<span class="tag tag-size" title="这套图原图总大小（${s.imageCount} 张）">📦 ${esc(s.sizeText)}</span>` : ''}
      ${s.series ? `<a class="tag tag-series" href="${rel}series/${encodeURIComponent(s.series)}.html" title="查看该系列全部图集">${esc(s.series)}</a>` : ''}
      ${s.model ? `<a class="tag tag-model" href="${rel}model/${encodeURIComponent(s.model)}.html" title="查看该模特的独立页面">模特：${esc(s.model)}</a>` : ''}
      ${s.tags.map(t => `<a class="tag tag-link" href="${rel}tag/${encodeURIComponent(t)}.html" title="查看同标签图集">#${esc(t)}</a>`).join('')}
    </div>
    ${s.description ? `<p class="detail-desc">${esc(s.description)}</p>` : ''}
    ${streamHint}
    ${previews}
    <nav class="prevnext">
      ${prev ? (prev.hidden
        ? `<span class="pn locked"${prev.hiddenOk ? ` data-hid="${esc(prev.slug)}"` : ''}><small>上一套（隐藏）</small><span>🔒 ${esc(prev.title)}</span></span>`
        : `<a class="pn" href="${setHref(prev)}"><small>上一套</small><span>${esc(prev.title)}</span></a>`) : '<span class="pn dim">已是第一套</span>'}
      ${next ? (next.hidden
        ? `<span class="pn locked"${next.hiddenOk ? ` data-hid="${esc(next.slug)}"` : ''}><small>下一套（隐藏）</small><span>🔒 ${esc(next.title)}</span></span>`
        : `<a class="pn" href="${setHref(next)}"><small>下一套</small><span>${esc(next.title)}</span></a>`) : '<span class="pn dim">已是最后一套</span>'}
    </nav>
    ${related && related.length ? `<h2 class="sec-title">相关推荐</h2>
    <div class="grid related">${related.map(x => card(x, rel, { eager: true })).join('')}</div>` : ''}
  </article>
  ${sideBlock}
  </div>
  <div class="mobile-dl-bar"${hasDlTarget ? '' : ' hidden'}>${dlBtn}</div>`
  return layout({
    title: `${s.title} - ${config.siteName}`,
    desc: s.description || s.modelInfo || `${s.displayTitle}${s.tags.length ? ' · ' + s.tags.join('、') : ''}`,
    body, rel, pswp: true,
    canonical: s.hiddenOk ? '' : canonical,   // 隐藏页不加 canonical / og:url（别把私有地址写进搜索引擎）
    noindex: s.hiddenOk,
    og: {
      type: 'article',
      url: s.hiddenOk ? '' : canonical,
      image: s.coverFile ? pageUrl(`${s.hiddenOk ? `h/${s.token}` : `set/${encodeURIComponent(s.slug)}`}/${s.coverThumb ? 'thumbs/' + s.coverThumb + verQ(s.thumbVer[s.coverThumb]) : s.coverFile}`) : '',
    },
    jsonld: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'ImageGallery',
      name: s.title,
      description: s.description || undefined,
      datePublished: s.date,
      image: s.coverFile ? pageUrl(`set/${encodeURIComponent(s.slug)}/${s.coverThumb ? 'thumbs/' + s.coverThumb + verQ(s.thumbVer[s.coverThumb]) : s.coverFile}`) : undefined,
      numberOfItems: s.imageCount,
      keywords: s.tags.join(','),
      author: s.model ? { '@type': 'Person', name: s.model } : undefined,
    }),
  })
}

/** 站点绝对地址（site.json 的 baseUrl 为空时用相对路径） */
function pageUrl(path) {
  const base = (config.baseUrl || '').replace(/\/+$/, '')
  return base ? `${base}/${path}` : path
}

// ─────────────────────────── 资源 ───────────────────────────
const STYLE = `:root{--bg:#0f1115;--panel:#171a21;--panel2:#1e222b;--line:#2a2f3a;--fg:#e8ebf0;--dim:#98a1b3;--accent:#5b8cff;--accent2:#ffb454;--radius:12px;--header-bg:rgba(15,17,21,.9)}
html[data-theme="light"]{--bg:#f6f7f9;--panel:#fff;--panel2:#eef1f5;--line:#dde2ea;--fg:#1b1f27;--dim:#5d6879;--accent:#2f6bff;--accent2:#b3651a;--header-bg:rgba(246,247,249,.92)}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
.site-header{position:sticky;top:0;z-index:20;background:var(--header-bg);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.header-inner{display:flex;align-items:center;gap:20px;height:64px}
.brand{display:flex;align-items:center;gap:10px;font-size:16px;white-space:nowrap}
.brand-mark{color:var(--accent);font-size:20px}
.brand-text{display:flex;flex-direction:column;line-height:1.25}
.brand-text small{color:var(--dim);font-size:12px;font-weight:400}
.header-search{flex:1;max-width:420px;margin-left:auto}
.header-search input{width:100%;height:38px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--fg);outline:none}
.header-search input:focus{border-color:var(--accent)}
.icon-btn{width:38px;height:38px;flex:0 0 auto;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--fg);font-size:16px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
.icon-btn:hover{border-color:var(--accent)}
/* 系列标签云 */
.chips-cloud{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 22px}
.cloud-chip{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--fg);text-decoration:none;font-size:13px}
.cloud-chip span{background:var(--panel2);border-radius:999px;padding:1px 8px;color:var(--dim);font-size:12px}
.cloud-chip:hover{border-color:var(--accent)}
.cloud-chip.on{border-color:var(--accent);background:rgba(91,140,255,.14);color:var(--fg)}
.cloud-sec{margin:34px 0 10px;padding-top:22px;border-top:1px solid var(--line)}
.grid.related{grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.grid.related .card-title{font-size:13px}
/* 窄屏：相关推荐排 2 列，避免卡片过窄 */
@media (max-width:760px){.grid.related{grid-template-columns:repeat(2,minmax(0,1fr))}}
.cats{display:flex;gap:8px;overflow-x:auto;padding:10px 20px;max-width:1180px;margin:0 auto}
.cats a{white-space:nowrap;padding:5px 12px;border:1px solid var(--line);border-radius:999px;color:var(--dim);font-size:13px}
.cats a:hover,.cats a.on{color:var(--fg);border-color:var(--accent);background:rgba(91,140,255,.12)}
.page-head{margin:28px 0 18px}
.page-head h1{margin:0;font-size:22px}
.page-head .sub{color:var(--dim);margin:4px 0 0;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}   /* 桌面一行 5 张 */
/* 卡片：选中/悬停不出现彩色描边，改成"图片轻微放大 + 轻微抬起投影" */
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;
  transition:transform .2s ease,box-shadow .2s ease}
.card:hover{transform:translateY(-3px);box-shadow:0 10px 28px rgba(0,0,0,.13)}
.card-cover{position:relative;aspect-ratio:3/4;background:var(--panel2) center/cover no-repeat;overflow:hidden}
.card-cover img{width:100%;height:100%;object-fit:cover;transition:transform .35s ease}
.card:hover .card-cover img{transform:scale(1.06)}
.card:hover .card-cover img.blurred{transform:scale(1.22)}   /* 隐藏卡的糊图：放大但保持模糊 */
.no-cover{display:flex;align-items:center;justify-content:center;height:100%;color:var(--dim)}
.badge{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.65);color:#fff;font-size:11px;padding:1px 7px;border-radius:999px}
.badge-size{left:auto;right:6px;background:rgba(91,140,255,.85)}
.card-title{margin:0;padding:11px 11px 6px;font-size:13.5px;line-height:1.45;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card-title .mavatar{margin-right:5px;margin-top:-3px}
.card-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center;padding:0 11px 11px;font-size:11.5px;color:var(--dim)}
.card-meta .tag{font-size:11px;padding:1px 7px}
/* 日期固定单独占一行右对齐：标签多少不一，若跟着标签排会出现"有的同行、有的换行" */
.card-meta time{flex:1 0 100%;margin:0;text-align:right}
/* 模特卡：资料标签区固定成"一行标签"的高度（24.4px = 12px 标签 + 内边距 + 边框），
   这样有资料和没资料的两张卡，日期行也会落在同一条基线上 */
.card-chips{display:flex;flex-wrap:wrap;gap:6px;min-height:24.4px;flex:1 0 100%;align-items:center;overflow:hidden}
.tag{padding:1px 8px;border-radius:999px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);font-size:12px;text-decoration:none;display:inline-block;transition:.15s}
.tag-series{color:var(--accent);border-color:rgba(91,140,255,.4)}
/* 详情页标题旁的体量标签（原图总大小）＋分类页「合计」强调 */
.tag-size{color:#4ec99a;border-color:rgba(78,201,154,.42);background:rgba(78,201,154,.10);cursor:default}
.size-strong{color:var(--fg);font-weight:600}
/* ── 隐藏套图：只给一张糊图，点不进去；输密码后才变成正常卡片 ── */
.card-locked{cursor:default}
.card-locked .card-cover{background:#0d1017}
.card-locked .card-cover .blurred,.blurred{filter:blur(14px) saturate(.75) brightness(.85);transform:scale(1.15)}
.card-locked .card-title{color:var(--dim)}
.card-locked .card-meta{justify-content:space-between}
.badge-lock{background:rgba(0,0,0,.66);color:#ffd9a0;border:1px solid rgba(255,180,84,.45)}
.lock-hint{font-size:12px;color:var(--dim)}
.unlock-btn{font:inherit;font-size:12px;padding:4px 12px;border-radius:999px;cursor:pointer;
  border:1px solid rgba(255,180,84,.5);background:rgba(255,180,84,.12);color:var(--accent2);transition:.15s}
.unlock-btn:hover{background:rgba(255,180,84,.22)}
.card-locked.unlocked{cursor:pointer}
.card-locked.unlocked .card-cover .blurred{filter:none;transform:none}
.card-locked.unlocked .card-title{color:var(--fg)}
.card-locked.unlocked .unlock-btn{border-color:var(--accent);background:rgba(91,140,255,.14);color:var(--accent)}
.side-set.is-hidden{cursor:default;opacity:.75}
/* 解锁后：任何位置的隐藏条目都恢复清晰、可点 */
[data-hid].unlocked img.blurred{filter:none;transform:none}
.side-set.is-hidden.unlocked{opacity:1;cursor:pointer}
.pn.locked{opacity:.75}
.pn.locked span{color:var(--dim)}
.pn.locked.unlocked{cursor:pointer;opacity:1}
/* 轻提示（隐藏套图解锁用） */
.pn-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:900;
  background:rgba(18,22,30,.97);color:#fff;border:1px solid var(--line);padding:10px 16px;border-radius:10px;
  font-size:13px;line-height:1.6;max-width:80vw;box-shadow:0 10px 34px rgba(0,0,0,.5)}
.pn-toast.err{border-color:rgba(255,96,96,.6)}
/* 模特头像（后台裁剪生成，圆形）：xs 列表卡片 / sm 侧栏 / md 模特页标题 */
.mavatar{display:inline-flex;flex:0 0 auto;border-radius:50%;overflow:hidden;background:var(--panel2);
  border:1px solid var(--line);vertical-align:middle;transition:transform .2s ease}
.mavatar img{width:100%;height:100%;object-fit:cover;display:block}
.mavatar-xs{width:24px;height:24px}
.mavatar-sm{width:38px;height:38px}
.mavatar-md{width:64px;height:64px;border-width:2px}
.page-head.model-head h1{display:flex;align-items:center;gap:12px}
.card-meta a.tag:hover,.detail-meta a.tag:hover{color:var(--accent);border-color:var(--accent);background:rgba(91,140,255,.12)}
.pager{display:flex;align-items:center;justify-content:center;gap:18px;margin:34px 0}
/* 筛选栏 */
.filters{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 16px}
.filters select{padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--fg);font:inherit;cursor:pointer}
/* 排序标签：与"快捷筛选"同一行的 chip 组，中间用竖线隔开 */
.sort-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.sort-chips button{font:inherit;font-size:12px;padding:5px 12px;border-radius:999px;border:1px solid var(--line);
  background:var(--panel);color:var(--dim);cursor:pointer;transition:.15s}
.sort-chips button:hover{color:var(--fg);border-color:var(--accent)}
.sort-chips button.on{background:rgba(91,140,255,.18);border-color:var(--accent);color:var(--fg);font-weight:600}
.sort-chips + .filter-chips:not(:empty){padding-left:12px;border-left:1px solid var(--line)}
.filter-chips{display:flex;gap:6px;flex-wrap:wrap}
.filter-chips button{font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--dim);cursor:pointer}
.filter-chips button:hover{color:var(--fg);border-color:var(--accent)}
.filter-chips button.on{background:rgba(91,140,255,.18);border-color:var(--accent);color:var(--fg)}
/* 回到顶部 */
.to-top{position:fixed;right:22px;bottom:26px;width:44px;height:44px;border-radius:50%;border:1px solid var(--line);
  background:var(--panel);color:var(--fg);font-size:18px;cursor:pointer;z-index:30;box-shadow:0 8px 24px rgba(0,0,0,.4)}
.to-top:hover{border-color:var(--accent)}
/* 置顶推荐轮播（列表页顶部）：左轮播舞台 + 右置顶清单 */
.hero{display:grid;grid-template-columns:minmax(0,1fr) 284px;gap:14px;margin:18px 0 16px;align-items:stretch}
.hero.single{grid-template-columns:1fr}
.hero-stage{position:relative;border-radius:14px;overflow:hidden;background:var(--panel);border:1px solid var(--line)}
.hero-track{position:relative;aspect-ratio:${config.heroRatio || '21/9'};max-height:${config.heroMaxHeight || 380}px;min-height:150px}
.hero-slide{position:absolute;inset:0;display:block;opacity:0;transition:opacity .55s ease;text-decoration:none;color:#fff;pointer-events:none}
.hero-slide.on{opacity:1;pointer-events:auto}
/* 隐藏图集置顶：轮播里只给模糊封面 + 🔒，点按钮输密码 */
.hero-slide.locked{cursor:default}
.hero-slide.locked .hero-info{gap:10px}
.hero-unlock{align-self:flex-start;font:inherit;font-size:13px;padding:7px 16px;border-radius:999px;cursor:pointer;
  border:1px solid rgba(255,180,84,.55);background:rgba(255,180,84,.92);color:#1a1206;font-weight:600}
.hero-unlock:hover{filter:brightness(1.08)}
.hero-item.is-hidden{cursor:default}
.hero-item.is-hidden img{filter:blur(6px) saturate(.8)}
.hero-item.is-hidden.unlocked{cursor:pointer}
.hero-item.is-hidden.unlocked img{filter:none}
.hero-slide img{width:100%;height:100%;object-fit:cover;object-position:center 22%;display:block}
.hero-slide img.is-banner{object-position:center center}   /* 自己裁的 Banner 用居中，别再偏向面部 */
/* 图片上的压暗渐变：只压下半部分（标题在底部），上半部分留给画面 ——
   自己裁的 Banner 才不会被大片黑色吞掉 */
.hero-slide::after{content:'';position:absolute;inset:0;
  background:linear-gradient(180deg,rgba(0,0,0,0) 0%,rgba(0,0,0,0) 46%,rgba(0,0,0,.24) 66%,rgba(0,0,0,.62) 86%,rgba(0,0,0,.82) 100%)}
.hero-slide:hover img{filter:brightness(1.06)}
/* 文字块：宽松排版（去掉 CTA 后只留 角标 / 标题 / 信息 三行） */
.hero-info{position:absolute;left:22px;right:22px;bottom:20px;z-index:2;display:flex;flex-direction:column;gap:9px;align-items:flex-start}
.hero-badge{align-self:flex-start;background:rgba(255,180,84,.92);color:#1a1206;font-size:12px;font-weight:600;
  padding:3px 11px;border-radius:999px;letter-spacing:.02em}
.hero-info h2{margin:0;font-size:19px;line-height:1.45;letter-spacing:.01em;text-shadow:0 2px 12px rgba(0,0,0,.55)}
.hero-meta{color:rgba(255,255,255,.88);font-size:12.5px;line-height:1.6;letter-spacing:.02em;text-shadow:0 1px 8px rgba(0,0,0,.5)}
.hero-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:3;width:32px;height:32px;border-radius:50%;
  border:1px solid rgba(255,255,255,.35);background:rgba(0,0,0,.45);color:#fff;font-size:17px;line-height:1;cursor:pointer;backdrop-filter:blur(4px)}
.hero-nav:hover{background:rgba(0,0,0,.7)}
.hero-prev{left:10px}.hero-next{right:10px}
.hero-dots{position:absolute;right:18px;bottom:14px;z-index:3;display:flex;gap:6px}
.hero-dot{width:8px;height:8px;padding:0;border:0;border-radius:50%;background:rgba(255,255,255,.45);cursor:pointer}
.hero-dot.on{background:#fff;width:20px;border-radius:999px}
/* 右侧置顶清单：高度锁定与轮播齐平、置顶再多也只在内部滚动，不会把版面撑长
   滚动条隐藏（用滚轮/悬停切换），选中项始终居中 */
.hero-list{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;min-height:0;align-self:stretch}
.hero-list-inner{position:absolute;inset:12px;overflow-y:auto;overscroll-behavior:contain;scroll-behavior:smooth;
  display:flex;flex-direction:column;gap:4px;padding-right:2px;
  scrollbar-width:none;-ms-overflow-style:none}
.hero-list-inner::-webkit-scrollbar{width:0;height:0;display:none}
.hero-list h3{margin:0 0 8px;font-size:13px;color:var(--accent2);font-weight:600;position:sticky;top:0;
  background:var(--panel);padding-bottom:6px;z-index:2}
.hero-item{display:flex;gap:10px;align-items:center;padding:6px;border-radius:9px;text-decoration:none;color:inherit;transition:background .15s}
.hero-item:hover{background:var(--panel2)}
.hero-item.on{background:var(--panel2)}   /* 选中不描蓝边，靠缩略图放大区分 */
.hero-item img{width:44px;height:59px;flex:0 0 44px;border-radius:6px;object-fit:cover;background:var(--panel2);
  transition:transform .3s ease}
.hero-item:hover img,.hero-item.on img{transform:scale(1.08)}
.hero-item-text{min-width:0;display:flex;flex-direction:column;gap:3px}
.hero-item-text b{font-size:13px;font-weight:600;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hero-item-text span{font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (max-width:860px){
  .hero{grid-template-columns:1fr}
  .hero-list{display:none}
  .hero-track{aspect-ratio:4/3}
  .hero-info{left:14px;right:14px;bottom:14px}
  .hero-info h2{font-size:17px}
  .hero-prev,.hero-next{display:none}
  .hero-dots{left:14px;bottom:14px}
}
.badge-pin{left:8px;top:auto;bottom:8px;background:rgba(255,180,84,.92);color:#1a1206;font-weight:600}
/* 模特行：头像 + 名字 · 日期（名字和日期同一种浅灰，挨在一起用圆点分隔；不弹提示、不描蓝框） */
.card-model{display:flex;align-items:center;gap:6px;padding:0 11px 8px;font-size:11.5px;color:var(--dim);
  white-space:nowrap;overflow:hidden}
.card-avatar{flex:0 0 24px;width:24px;height:24px;border-radius:50%;overflow:hidden;display:block;
  background:var(--panel2);border:0;box-shadow:0 0 0 1px rgba(255,255,255,.10);transition:transform .2s ease}
html[data-theme="light"] .card-avatar{box-shadow:0 0 0 1px rgba(0,0,0,.07)}
.card-avatar img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .2s ease}
.card-avatar:hover{transform:scale(1.12)}   /* 只放大，不变色 */
.card-model-name{color:var(--dim);font-weight:500;text-decoration:none;overflow:hidden;text-overflow:ellipsis;max-width:48%;
  transition:color .18s ease}
.card-model time{margin:0;transition:color .18s ease}
.card-model:hover .card-model-name,.card-model:hover time{color:var(--fg)}   /* 悬停/选中：文字变亮 */
/* 鼠标点过的链接不要再出现浏览器默认的蓝色聚焦框（键盘 Tab 仍保留可见焦点） */
a:focus,button:focus{outline:none}
a:focus-visible,button:focus-visible{outline:2px solid var(--line);outline-offset:2px}
.cover-link{display:block;width:100%;height:auto;position:relative}
.title-link{text-decoration:none;color:inherit;display:block;min-width:0}
.pagination-wrap{display:flex;flex-direction:column;align-items:center;gap:10px;margin:30px 0 10px}
.pagination-wrap[hidden]{display:none}   /* CSS 的 display 会盖掉 hidden 属性，必须显式声明 */
.pagination{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0;padding:0;justify-content:center}
.pagination .page-link{display:block;min-width:38px;text-align:center;padding:7px 11px;border:1px solid var(--line);
  border-radius:8px;background:var(--panel);color:var(--fg);text-decoration:none;font-size:13px;line-height:1.25;transition:.15s}
.pagination .page-item:not(.disabled):not(.active) .page-link:hover{border-color:var(--accent);color:var(--accent)}
.pagination .page-item.active .page-link{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;cursor:default}
.pagination .page-item.disabled .page-link{opacity:.45;cursor:not-allowed}
.pagination-info{color:var(--dim);font-size:12.5px;margin:0}
@media (max-width:560px){
  .pagination{gap:4px}
  .pagination .page-link{min-width:32px;padding:6px 8px;font-size:12.5px}
  .pagination .page-link .pg-word{display:none}   /* 窄屏只留箭头与页码 */
}
.dim{color:var(--dim)}
.empty{text-align:center;color:var(--dim);padding:40px 0}
/* 搜索无结果的空状态：图标 + 说明 + 清除搜索/模特入口 + 热门标签 */
.empty-box{display:flex;flex-direction:column;align-items:center;gap:10px;padding:34px 18px 38px;margin:6px 0 10px;
  background:var(--panel);border:1px dashed var(--line);border-radius:14px;text-align:center}
.empty-box[hidden]{display:none}
.empty-icon{font-size:38px;line-height:1;opacity:.85}
.empty-title{margin:0;color:var(--fg);font-size:16px;font-weight:600}
.empty-hint{margin:0;color:var(--dim);font-size:13px}
.empty-actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin:6px 0 2px}
.empty-sub{margin:12px 0 0;color:var(--dim);font-size:12.5px}
.empty-box .chips-cloud{justify-content:center;margin-top:2px}
.empty-box .cloud-chip{cursor:pointer;font-family:inherit}
#empty{background:none;border:0;padding:0}
.breadcrumb{display:flex;gap:8px;color:var(--dim);font-size:13px;margin:22px 0 14px;flex-wrap:wrap}
.admin-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:rgba(91,140,255,.08);border:1px solid rgba(91,140,255,.35);border-radius:10px;padding:10px 14px;margin:18px 0 0}
.admin-bar[hidden]{display:none}
.btn.sm{padding:7px 14px;font-size:13px}
.breadcrumb .cur{color:var(--fg)}
.detail-title{font-size:22px;margin:0 0 10px;line-height:1.5}
.detail-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:var(--dim);font-size:13px;margin-bottom:14px}
.detail-desc{color:var(--dim)}
.download{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px;margin:18px 0 26px}
.dl-main{margin-bottom:14px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:11px 22px;border-radius:8px;font-weight:600;border:1px solid transparent}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{filter:brightness(1.1)}
.btn-disabled{background:var(--panel2);color:var(--dim);border-color:var(--line)}
.dl-info{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin:0}
.dl-info div{background:var(--panel2);border-radius:8px;padding:10px 12px}
.dl-info dt{color:var(--dim);font-size:12px}
.dl-info dd{margin:2px 0 0;font-weight:600}
.dl-info code{background:rgba(255,180,84,.15);color:var(--accent2);padding:1px 6px;border-radius:4px}
.sec-title{font-size:17px;margin:26px 0 14px}
.previews{position:relative;width:100%;min-height:120px;transition:height .35s ease}
.preview{position:absolute;top:0;left:0;margin:0;overflow:hidden;border-radius:var(--radius);background:var(--panel);
  opacity:0;pointer-events:none;
  transition:transform .45s cubic-bezier(.22,.61,.36,1),opacity .45s ease,width .3s ease,height .3s ease;will-change:transform,width,height}
.preview.placed{opacity:1;pointer-events:auto}
/* 首次排版禁用过渡：否则瓦片是从 (0,0) 动画移到目标位置的，懒加载观察器会在动画起点
   读到"所有瓦片都在顶部"，于是把整套缩略图一次性下载。之后（窗口缩放等）恢复动画。 */
.previews.no-anim .preview{transition:none}
/* 图片加载失败占位 */
.preview.failed{background:var(--panel2)}
.preview.failed::before{content:'⚠ 图片加载失败';position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:13px}
.preview img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in;transition:filter .45s ease,opacity .3s}
.preview img:not(.loaded){filter:blur(14px)}
.preview figcaption{position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.6);color:#fff;font-size:12px;padding:2px 8px;border-radius:999px;pointer-events:none}
.preview-link{display:block;width:100%;height:100%;position:relative}
.preview-link::after{content:'点击看原图';position:absolute;left:8px;bottom:8px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;padding:2px 8px;border-radius:999px;opacity:0;transition:opacity .2s}
.preview:hover .preview-link::after{opacity:1}
/* 原图直链（OpenList）：右上角小胶囊 */
.orig-link{position:absolute;top:8px;right:8px;z-index:2;background:rgba(0,0,0,.62);color:#fff;font-size:12px;line-height:1;padding:6px 10px;border-radius:999px;text-decoration:none;opacity:.9;transition:opacity .2s,background .2s;backdrop-filter:blur(4px)}
.orig-link:hover{opacity:1;background:var(--accent);color:#fff}
.dl-hint{color:var(--dim);font-size:13px}
.dl-hint code{background:var(--panel2);padding:2px 6px;border-radius:6px}
.stream-hint{color:var(--dim);text-align:center;font-size:13px;margin:14px 0}
/* 预览区上方那行（原来在下面，且顶掉了「预览图（8 / 32）」标题） */
.stream-hint.top{text-align:left;margin:0 0 12px;padding-left:11px;border-left:3px solid var(--accent);line-height:1.7}
.stream-hint.top b{color:var(--fg);font-weight:600}
.tag-link{text-decoration:none;transition:.15s}
.tag-link:hover{color:var(--accent);border-color:var(--accent);background:rgba(91,140,255,.12)}
/* 首页/列表页卡片标签：系列与标签都可点，跳到对应的系列页/标签页 */
.card-meta .tag{cursor:pointer}
.tag-model{color:var(--accent2);border-color:rgba(255,180,84,.4)}
.model-info{display:flex;gap:10px;align-items:flex-start;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent2);border-radius:10px;padding:12px 14px;margin:0 0 18px;font-size:13.5px;line-height:1.7}
.mi-label{flex:0 0 auto;color:var(--accent2);font-weight:600}
/* ── 详情页两栏布局：左预览图 + 右信息侧栏（参考同类站）── */
.detail-layout{display:flex;gap:26px;align-items:flex-start}
.detail-layout > .detail{flex:1;min-width:0}
/* 侧栏：内容能一屏放下就完整显示（不出滚动条）；放不下才收口成"栏内滚动"，
   滚动条本身也隐藏（滚轮照常滚），保证任何时候都看不到滚动条。 */
.detail-side{flex:0 0 316px;width:316px;position:sticky;top:80px}
.detail-side.side-tall{max-height:calc(100vh - 96px);overflow-y:auto;
  scrollbar-width:none;-ms-overflow-style:none}
.detail-side.side-tall::-webkit-scrollbar{width:0;height:0;display:none}
.side-box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 15px;margin-bottom:12px}
.side-title{margin:0 0 11px;padding-bottom:8px;font-size:14px;font-weight:600;color:var(--accent2);
  border-bottom:1px solid var(--line)}   /* 标题下一道细线 → 三块模块的分区更清楚 */
/* 下载 + 本套信息合并成一块：栏内滚动时它吸在顶部，下载按钮始终看得见 */
.side-dl-box{position:sticky;top:0;z-index:2}
.side-dl-wrap{margin:0 0 6px}
.side-dl-box .side-dl{padding:7px 14px;font-size:13.5px}   /* 侧栏里的下载按钮紧凑一点 */
/* 侧栏：模特的其他作品（缩略图 + 标题 + 日期/张数） */
.side-sub{margin:9px 0 6px;font-size:12px;color:var(--dim);border-top:1px solid var(--line);padding-top:8px}
/* 模特行 / 系列行：同一种排版（封面 + 名字 + 说明 + ›），点进模特页/系列页。
   详情页只留"去哪个模特、哪个系列"，模特资料本身只在模特页展示。 */
.side-rows{display:flex;flex-direction:column;gap:6px}
.side-row{display:flex;align-items:center;gap:9px;padding:5px 9px 5px 5px;border:1px solid var(--line);
  border-radius:10px;background:var(--panel2);color:var(--fg);text-decoration:none;transition:.15s}
.side-row:hover{background:var(--panel)}   /* 悬停只换底色 + 头像放大，不描蓝边 */
.side-row:hover .sr-go{color:var(--accent)}
.sr-art{flex:0 0 38px;width:38px;height:50px;border-radius:7px;overflow:hidden;background:var(--panel);
  display:flex;align-items:center;justify-content:center;font-size:18px;line-height:1}
.sr-art img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .28s ease}
.side-row:hover .sr-art img{transform:scale(1.09)}
.sr-art.sr-round{width:38px;height:38px;border-radius:50%}   /* 有自定义头像时用圆形 */
.sr-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}
.sr-body b{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sr-meta{font-size:11.5px;color:var(--dim)}
.sr-go{flex:0 0 auto;color:var(--dim);font-size:17px;line-height:1;transition:color .15s}
.side-sets{display:flex;flex-direction:column;gap:3px}
.side-set{display:flex;gap:8px;align-items:center;padding:4px 5px;border-radius:9px;text-decoration:none;color:inherit;transition:background .15s}
.side-set:hover{background:var(--panel2)}
.ss-cover{flex:0 0 38px;width:38px;height:50px;border-radius:7px;overflow:hidden;background:var(--panel2)}
.ss-cover img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .28s ease}
.side-set:hover .ss-cover img,.side-set:hover .sr-art img{transform:scale(1.09)}
.ss-body{min-width:0;display:flex;flex-direction:column;gap:2px}
.ss-body b{font-size:12.5px;line-height:1.4;font-weight:600;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ss-meta{font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.side-box .btn{width:100%;justify-content:center;display:flex}
.side-note{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--dim)}
.side-note code{background:var(--panel2);padding:1px 6px;border-radius:5px;color:var(--fg)}
.side-info{margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12.5px}
.side-info dt{color:var(--dim);white-space:nowrap}
.side-info dd{margin:0;word-break:break-word}
.side-info code{background:var(--panel2);padding:1px 6px;border-radius:5px}
/* 标签：pill 造型 + 计数徽标 */
.side-tags{display:flex;flex-wrap:wrap;gap:5px}
.side-tag{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;background:var(--panel2);
  border:1px solid var(--line);color:var(--dim);font-size:12px;text-decoration:none;transition:.15s}
.side-tag span{font-size:11px;opacity:.7}
.side-tag:hover{color:var(--accent);border-color:var(--accent)}
/* 视口不够高时自动收紧侧栏（只压间距/字号，不改结构），
   目标：整栏一屏放得下 → 不出现滚动条。1000px 以上才用宽松版。 */
@media (min-width:1001px) and (max-height:909px){
  .side-box{padding:10px 12px;margin-bottom:9px}
  .side-title{margin-bottom:9px;padding-bottom:6px;font-size:13.5px}
  .side-dl-box .side-dl{padding:5px 12px;font-size:13px}
  .side-note{font-size:11.5px;line-height:1.5}
  .side-sub{margin:6px 0 4px;padding-top:5px}
  .side-rows{gap:5px}
  .side-row{padding:4px 8px 4px 4px}
  .sr-art{flex-basis:34px;width:34px;height:44px;font-size:16px}
  .sr-art.sr-round{flex-basis:34px;width:34px;height:34px}
  .mavatar-sm{width:34px;height:34px}
  .ss-cover{flex-basis:34px;width:34px;height:44px}
  .side-set{padding:2px 4px}
  .side-sets{gap:2px}
  .ss-body b{font-size:12px}
  .side-info{gap:3px 10px;font-size:11.8px}
  .side-tag{padding:1px 8px;font-size:11.5px}
  .side-tags + .side-note{display:none}      /* 标签框里的"查看全部标签"让位给一屏显示 */
}
/* 更矮的窗口：再砍掉"其他作品"的第 2 条和多余标签 */
@media (min-width:1001px) and (max-height:758px){
  .side-set:nth-of-type(n+2){display:none}   /* 同栏 a 元素里的第 2 条起：只留 1 条作品 */
  .side-tag:nth-child(n+5){display:none}
  .side-tags + .side-note{display:none}      /* 标签框里的"查看全部标签"也让位 */
  .side-info{gap:3px 10px}
}
/* 窄屏：单栏 + 底部固定下载条（参考同类站的做法） */
.mobile-dl-bar{display:none}
.mobile-dl-bar[hidden]{display:none}
@media (max-width:1000px){
  .detail-layout{flex-direction:column;gap:18px}
  .detail-side{position:static;width:100%;flex:none;max-height:none;overflow:visible}
  .detail-side.side-tall{position:static;top:auto;max-height:none;overflow:visible}  /* 手机端侧栏在正文下方，不做吸附 */
  .side-dl-box{position:static}                      /* 手机端不做二次吸顶 */
  /* 下载已在底部固定条里，这里只把按钮/提示收起来；下面那串本套信息要留着 */
  body:has(.mobile-dl-bar:not([hidden])) .side-dl-top{display:none}
  body:has(.mobile-dl-bar:not([hidden])){padding-bottom:76px}
  .mobile-dl-bar:not([hidden]){display:flex;position:fixed;left:0;right:0;bottom:0;z-index:40;
    padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px));gap:10px;align-items:center;justify-content:center;
    background:color-mix(in srgb, var(--bg) 92%, transparent);backdrop-filter:blur(10px);border-top:1px solid var(--line)}
  .mobile-dl-bar .btn{width:100%;max-width:420px;justify-content:center;display:flex}
}
.pf-quote{margin:0 0 20px;padding:10px 0 10px 16px;border-left:3px solid var(--accent);
  background:linear-gradient(90deg,rgba(91,140,255,.07),transparent 60%);
  border-radius:0 8px 8px 0;color:var(--dim);font-size:14px;line-height:1.95;letter-spacing:.01em}
.pf-quote p{margin:0}
.pf-quote p + p{margin-top:6px}
.pf-social{font-size:13px;opacity:.92}
.pf-quote a{color:var(--accent);text-decoration:none;border-bottom:1px dashed rgba(91,140,255,.45)}
.pf-quote a:hover{color:var(--accent2);border-bottom-color:var(--accent2)}
html[data-theme="light"] .pf-quote{background:linear-gradient(90deg,rgba(47,107,255,.08),transparent 60%)}
.more-hint{color:var(--dim);text-align:center;font-size:13px;margin:16px 0}
.prevnext{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:32px 0}
.pn{display:flex;flex-direction:column;gap:4px;padding:14px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.pn small{color:var(--dim)}
.pn span{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pn:hover{border-color:var(--accent)}
.site-footer{border-top:1px solid var(--line);margin-top:44px;padding:22px 0;color:var(--dim);font-size:13px;text-align:center}
.site-footer p{margin:4px 0}
.foot-links{display:flex;gap:14px;justify-content:center;flex-wrap:wrap}
.foot-links a{color:var(--dim)}
.foot-links a:hover{color:var(--accent)}
.foot-note{max-width:760px;margin:10px auto 0;font-size:12px;line-height:1.7;opacity:.85}
/* 18+ 闸门 */
.adult-gate{position:fixed;inset:0;z-index:500;background:rgba(6,8,12,.97);display:flex;align-items:center;justify-content:center;padding:24px}
.adult-gate[hidden]{display:none}
.ag-card{max-width:560px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px}
.ag-card h2{margin:0 0 12px;font-size:18px}
.ag-card p{margin:8px 0;font-size:14px;line-height:1.8}
.ag-actions{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap}
/* 合规页正文 */
.legal{max-width:820px;line-height:1.95;font-size:15px}
.legal h2{font-size:16px;margin:26px 0 8px}
.legal p{margin:8px 0;color:var(--text)}
.legal strong{color:var(--accent)}
.notfound-actions{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0 40px}
/* 手机端头部：品牌 + 图标一行，搜索框独占第二行（原来挤在一行会把页面撑出横向滚动条） */
@media (max-width:700px){
  .header-inner{flex-wrap:wrap;height:auto;gap:8px;padding:10px 0}
  .brand{flex:0 0 auto}
  .brand-text small{display:none}          /* 副标题太占位，手机上省略 */
  .header-search{order:10;flex:1 0 100%;max-width:none;margin-left:0}
  .header-search input{width:100%;height:40px}
  .icon-btn{width:36px;height:36px;font-size:15px}
  .site-header{position:sticky}
}
@media(max-width:640px){.grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}.prevnext{grid-template-columns:1fr}.detail-title{font-size:18px}}`

const PSWP_EXTRA = `/* PhotoSwipe 主题微调（暗色站风格） */
.pswp{--pswp-bg:rgba(8,10,14,.97)}
.pswp-caption{position:absolute;top:0;left:0;right:0;padding:14px 60px;color:#e8ebf0;font-size:13px;background:linear-gradient(rgba(0,0,0,.55),transparent);pointer-events:none;z-index:10}
.pswp__button--zoom,.pswp__button--close,.pswp__button--arrow--prev,.pswp__button--arrow--next{opacity:.85}
.pswp__button--close:hover,.pswp__button--zoom:hover{opacity:1}
.pswp__counter{font-size:13px}
`

// 本地管理入口片段（SITE_PUBLIC=1 时整体剥离 —— 公网产物里不留任何后台痕迹）
const ADMIN_JS = PUBLIC ? '' : `  // ── 本地管理开关：详情页带 ?admin=1 时显示「编辑这套图集」──
  if (/[?&]admin=1/.test(location.search)) {
    const bar = document.getElementById('adminBar');
    if (bar) bar.hidden = false;
  }
`

const APP = `// 前端交互：列表页搜索 + 详情页流式加载/PhotoSwipe 画廊（静态站，无后端）
(function () {
  // ── 18+ 内容确认闸门（最先执行，避免后续脚本异常导致闸门失效）──
  // 仅当页面注入了 #adultGate（site.json 的 adultGate: true）时生效；同意后记入 localStorage，一年内不再询问
  var gate = document.getElementById('adultGate');
  if (gate) {
    var GKEY = 'ag-consent-v1', consented = false;
    try {
      var rawAg = localStorage.getItem(GKEY);
      if (rawAg && Date.now() - Number(rawAg) < 31536000000) consented = true;
    } catch (e) { consented = false; }
    if (!consented) {
      gate.hidden = false;
      document.documentElement.style.overflow = 'hidden';
      var agEnter = document.getElementById('agEnter');
      if (agEnter) agEnter.addEventListener('click', function () {
        try { localStorage.setItem(GKEY, String(Date.now())); } catch (e) {}
        gate.hidden = true;
        document.documentElement.style.overflow = '';
      });
    }
  }

  // ── 主题切换（默认跟随系统，可手动覆盖并记忆）──
  const root = document.documentElement;
  const saved = localStorage.getItem('dsh-theme');
  const setTheme = (t) => { root.setAttribute('data-theme', t); localStorage.setItem('dsh-theme', t); };
  if (saved === 'light' || saved === 'dark') setTheme(saved);
  else root.setAttribute('data-theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const themeBtn = document.getElementById('themeBtn');
  if (themeBtn) themeBtn.addEventListener('click', () => setTheme(root.getAttribute('data-theme') === 'light' ? 'dark' : 'light'));

  // ── 隐藏套图解锁 ──
  // 地址 = h/<sha256(密码 + '|' + slug) 前 16 位>/，所以浏览器这边也要能算同一个哈希；
  // 站点 HTML 里不出现这个地址，输对密码前谁也拿不到隐藏套图的页面与原图。
  var toast = function (msg, ok) {
    var d = document.createElement('div');
    d.className = 'pn-toast' + (ok === false ? ' err' : '');
    d.textContent = String(msg).slice(0, 200);
    document.body.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.remove(); }, 2800);
  };
  var HN = {
    key: 'pn-hidden-pw',
    rel: (typeof window.PN_REL === 'string' ? window.PN_REL : ''),
    hint: window.PN_HIDDEN_HINT || '这套图已隐藏，输入密码后查看',
    pw: function () { try { return localStorage.getItem(HN.key) || ''; } catch (e) { return ''; } },
    save: function (p) { try { localStorage.setItem(HN.key, p); } catch (e) {} },
    forget: function () { try { localStorage.removeItem(HN.key); } catch (e) {} },
  };
  var hexBuf = function (buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  };
  var sha16 = function (str) {
    if (!(window.crypto && crypto.subtle)) return Promise.reject(new Error('no-subtle'));
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
      .then(function (buf) { return hexBuf(buf).slice(0, 16); });
  };
  var urlFor = function (slug, pw) {
    return sha16(pw + '|' + slug).then(function (tok) { return HN.rel + 'h/' + tok + '/'; });
  };
  // HEAD 探一下地址在不在：在＝密码对（地址由密码算出，猜不出别的可能）
  var probe = function (url) {
    return fetch(url, { method: 'HEAD' }).then(function (r) { return r.ok; }).catch(function () { return false; });
  };
  var unlockCards = function () {
    var pw = HN.pw(); if (!pw) return;
    var nodes = [].slice.call(document.querySelectorAll('[data-hid]'));
    if (!nodes.length) return;
    nodes.slice(0, 24).forEach(function (el) {
      var slug = el.getAttribute('data-hid'); if (!slug) return;
      urlFor(slug, pw).then(function (url) {
        return probe(url).then(function (ok) {
          if (!ok) { HN.forget(); return; }        // 密码改过了 → 清掉本地记忆，回到锁定状态
          el.classList.add('unlocked');
          el.setAttribute('data-url', url);
          var img = el.querySelector('img.blurred');
          var cov = el.getAttribute('data-cover');
          if (img && cov && url) img.src = url + 'thumbs/' + cov;
          var btn = el.querySelector('.unlock-btn');
          if (btn) btn.textContent = '🔓 查看这套图';
          var a = el.querySelector('a.card-link');
          if (!a && el.tagName === 'A' && !el.getAttribute('href')) el.setAttribute('href', url);
          if (!a && el.tagName === 'A' && el.classList.contains('hero-item')) el.setAttribute('href', url);
          if (el.classList.contains('hero-slide')) { var hb = el.querySelector('.hero-badge'); if (hb) hb.textContent = '📌 置顶推荐'; }
        });
      });
    });
  };
  var goHidden = function (slug, pw) {
    return urlFor(slug, pw).then(function (url) {
      return probe(url).then(function (ok) {
        if (!ok) return false;
        HN.save(pw);
        location.href = url;
        return true;
      });
    });
  };
  var askHidden = function (slug) {
    var pw = window.prompt(HN.hint);
    if (!pw) return;
    toast('正在校验密码…');
    goHidden(slug, pw).then(function (ok) {
      if (ok) return;
      var again = window.confirm('密码不对，重新输入？');
      if (again) askHidden(slug);
      else toast('已取消', false);
    }).catch(function () { toast('当前浏览器不支持（需要 HTTPS）', false); });
  };
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.unlock-btn');
    if (btn) {
      e.preventDefault(); e.stopPropagation();
      var el = btn.closest('[data-hid]');
      var url = el && el.getAttribute('data-url');
      if (url) { location.href = url; return; }     // 已经解锁过：直接进
      askHidden(btn.getAttribute('data-hid') || (el && el.getAttribute('data-hid')));
      return;
    }
    var card = e.target.closest('[data-hid].unlocked');
    if (card && !e.target.closest('a[href]')) {
      var u = card.getAttribute('data-url');
      if (u) location.href = u;
    }
  });
  var lockBtn = document.getElementById('lockBtn');
  if (lockBtn) lockBtn.addEventListener('click', function () {
    var pw = window.prompt(HN.hint, HN.pw() ? '' : '');
    if (!pw) return;
    // 用页面上任意一个隐藏套图来验证密码；没有锁定卡片时（比如详情页）就直接记住
    var any = document.querySelector('[data-hid]');
    if (!any) { HN.save(pw); toast('密码已记住，回到列表即可打开隐藏图集', true); return; }
    goHidden(any.getAttribute('data-hid'), pw).then(function (ok) { if (!ok) toast('密码不对', false); });
  });
  unlockCards();

  // ── 随便看看：从索引随机跳一套 ──
  const randBtn = document.getElementById('randomBtn');
  if (randBtn) {
    const base = (location.pathname.includes('/set/') || location.pathname.includes('/series/') || location.pathname.includes('/tag/') || location.pathname.includes('/page/')) ? '../../' : '';
    randBtn.addEventListener('click', () => {
      fetch(base + 'search-index.json').then(r => r.json()).then(d => {
        // 隐藏套图不参与"随便看看"（除非已经解锁）
        const pool = d.sets.filter(s => !s.locked || document.querySelector('.card-locked.unlocked[data-hid="' + s.slug + '"]'));
        const s = pool[Math.floor(Math.random() * pool.length)];
        if (s) location.href = base + 'set/' + encodeURIComponent(s.slug) + '/index.html';
      }).catch(() => {});
    });
  }

  ${ADMIN_JS}
  // ── 列表页：全站搜索/筛选（读 search-index.json，跨分页生效）──
  const grid = document.getElementById('grid');
  const input = document.getElementById('q');
  const empty = document.getElementById('empty');
  if (grid) {
    const base = location.pathname.includes('/page/') ? '../../' : '';
    let INDEX = null;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // 模特行：头像 + 模特名 + 日期（与静态卡片保持一致）
    // 注意：头像地址由构建时写进 search-index.json 的 face 字段 —— 浏览器里没有 MODEL_FACE 这个变量，
    // 这里直接引用它会 ReferenceError，整个客户端渲染（搜索、排序）都会挂掉
    const cardModelRowJS = (s, base) => {
      const face = s.face || '';
      const href = s.model ? base + 'model/' + encodeURIComponent(s.model) + '.html' : '';
      return (face ? '<a class="card-avatar" href="' + href + '"><img loading="lazy" src="' + base + face + '" alt="' + esc(s.model) + '"></a>' : '')
        + (s.model ? '<a class="card-model-name" href="' + href + '">' + esc(s.model) + '</a><span class="sep">·</span>' : '')
        + '<time>' + esc(String(s.date || '').replace(/-/g, '/')) + '</time>';
    };
    const cardHtml = (s) => s.locked ? [
      '<article class="card card-locked" data-hid="' + esc(s.slug) + '" data-cover="cover.webp">',
      '<div class="card-cover locked">',
      (s.cover ? '<img class="blurred" loading="lazy" src="' + base + s.cover + '" alt="' + esc(s.title) + '">' : '<div class="no-cover">🔒</div>'),
      '<span class="badge badge-lock">🔒 隐藏</span>',
      '</div>',
      '<h2 class="card-title">' + esc(s.title) + '</h2>',
      '<div class="card-model">',
      cardModelRowJS(s, base),
      '</div>',
      '<div class="card-meta">',
      (s.dupTag && s.dupTag !== s.model ? '<span class="tag tag-model">' + esc(s.dupTag) + '</span>' : ''),
      '<button class="unlock-btn" data-hid="' + esc(s.slug) + '">🔓 输入密码查看</button>',
      '</div></article>',
    ].join('') : [
      '<article class="card">',
      '<a class="card-link cover-link" href="' + base + 'set/' + encodeURIComponent(s.slug) + '/index.html" aria-label="' + esc(s.title) + '">',
      '<div class="card-cover">',
      (s.cover ? '<img loading="lazy" src="' + base + s.cover + '" alt="' + esc(s.title) + '">' : '<div class="no-cover">无封面</div>'),
      '<span class="badge">' + s.imageCount + 'P</span>',
      (s.size || s.packSize ? '<span class="badge badge-size">' + esc(s.size || s.packSize) + '</span>' : ''),
      (s.pinned ? '<span class="badge badge-pin" title="置顶推荐">📌 置顶</span>' : ''),
      '</div>',
      '</a>',
      '<a class="card-link title-link" href="' + base + 'set/' + encodeURIComponent(s.slug) + '/index.html"><h2 class="card-title">' + esc(s.title) + '</h2></a>',
      '<div class="card-model">',
      cardModelRowJS(s, base),
      '</div>',
      '<div class="card-meta">',
      (s.dupTag && s.dupTag !== s.model ? '<span class="tag tag-model">' + esc(s.dupTag) + '</span>' : ''),
      (s.series ? '<a class="tag tag-series" href="' + base + 'series/' + encodeURIComponent(s.series) + '.html">' + esc(s.series) + '</a>' : ''),
      (s.tags || []).slice(0, 2).map(t => '<a class="tag tag-link" href="' + base + 'tag/' + encodeURIComponent(t) + '.html">' + esc(t) + '</a>').join(''),
      '</div></article>',
    ].join('');
    const hits = (s, q) => {
      if (!q) return true;
      const hay = [s.title, s.series, s.model, (s.tags || []).join(' '), s.date].join(' ').toLowerCase();
      return q.split(/\\s+/).filter(Boolean).every(part => hay.includes(part));
    };
    // 客户端分页所需的状态与渲染器（必须与 renderList 同作用域，否则 renderList 里引用不到）
    const clientPager = document.getElementById('clientPager');
    let curPage = 1;
    const clientPagerHtml = (pages) => {
      const w = 2, nums = new Set([1, pages]);
      for (let p = curPage - w; p <= curPage + w; p++) if (p >= 1 && p <= pages) nums.add(p);
      const arr = [...nums].sort((a, b) => a - b);
      const it = (inner, cls) => '<li class="page-item' + (cls ? ' ' + cls : '') + '">' + inner + '</li>';
      const lk = (p, label) => it('<a class="page-link" href="#" data-p="' + p + '">' + label + '</a>');
      const dead = (label) => it('<span class="page-link">' + label + '</span>', 'disabled');
      let html = curPage > 1 ? lk(1, '« <span class="pg-word">首页</span>') : dead('« <span class="pg-word">首页</span>');
      html += curPage > 1 ? lk(curPage - 1, '‹ <span class="pg-word">上一页</span>') : dead('‹ <span class="pg-word">上一页</span>');
      let prev = 0;
      for (const p of arr) {
        if (prev && p - prev > 1) html += it('<span class="page-link">…</span>', 'disabled');
        html += p === curPage ? it('<span class="page-link" aria-current="page">' + p + '</span>', 'active') : lk(p, String(p));
        prev = p;
      }
      html += curPage < pages ? lk(curPage + 1, '<span class="pg-word">下一页</span> ›') : dead('<span class="pg-word">下一页</span> ›');
      html += curPage < pages ? lk(pages, '<span class="pg-word">末页</span> »') : dead('<span class="pg-word">末页</span> »');
      return '<nav class="pagination-wrap" aria-label="分页导航"><ul class="pagination">' + html
        + '</ul><p class="pagination-info">第 ' + curPage + ' / ' + pages + ' 页</p></nav>';
    };
    fetch(base + 'search-index.json').then(r => r.ok ? r.json() : null).then(d => {
      if (!d) return;
      INDEX = d;
      // 页脚的体量文案是构建时写好的（共 N 套 · N 张 · 合计 X），这里不要覆盖它
      // 带 ?q= 进来时：先把词填进搜索框，真正的渲染放到函数都定义好之后再做
      // （原来这里直接调 renderList，而它定义在下面 —— TDZ 报错会让整段 JS 挂掉，
      //   搜索框/排序/筛选芯片/回到顶部全部失效，且被末尾的 .catch 静默吞掉）
      const params = new URLSearchParams(location.search);
      const q0 = (params.get('q') || '').trim();
      if (q0 && input) input.value = q0;
      if (input) {
        let t = null;
        input.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(() => {
            const q = input.value.trim().toLowerCase();
            curPage = 1;
            renderList(q);
            const url = q ? (base + 'index.html?q=' + encodeURIComponent(input.value.trim())) : (base + 'index.html');
            history.replaceState(null, '', url);
          }, 180);
        });
      }
      // 排序 + 快捷筛选（系列/模特）+ 回到顶部
      const sortChips = document.getElementById('sortChips');
      const SORT_LABEL = { 'date-desc': '最新发布', 'date-asc': '最早发布', 'count-desc': '图片最多', 'size-desc': '体积最大', 'title-asc': '标题排序' };
      let SORT = 'date-desc';
      const chips = document.getElementById('filterChips');
      const applySort = (list) => {
        const v = SORT;
        const arr = list.slice();
        if (v === 'date-desc') arr.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))
          || String(b.addedAt || '').localeCompare(String(a.addedAt || ''))
          || String(b.slug || '').localeCompare(String(a.slug || '')));
        else if (v === 'date-asc') arr.sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))
          || String(a.addedAt || '').localeCompare(String(b.addedAt || ''))
          || String(a.slug || '').localeCompare(String(b.slug || '')));
        else if (v === 'count-desc') arr.sort((a, b) => (b.imageCount || 0) - (a.imageCount || 0));
        else if (v === 'size-desc') arr.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
        else if (v === 'title-asc') arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'));
        return arr;
      };
      // 搜不到结果时的引导：清除搜索 + 模特入口 + 热门标签（原来只有一行裸文字）
      const emptyHtml = (q) => {
        const tagCount = {}, modelCount = {};
        INDEX.sets.forEach(s => {
          (s.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; });
          if (s.model) modelCount[s.model] = (modelCount[s.model] || 0) + 1;
        });
        const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 12);
        const topModels = Object.entries(modelCount).sort((a, b) => b[1] - a[1]).slice(0, 3);
        return '<div class="empty-box">'
          + '<div class="empty-icon">🔍</div>'
          + '<p class="empty-title">没有找到与「' + esc(q) + '」匹配的图集</p>'
          + '<p class="empty-hint">换个关键词试试，或者从下面这些入口继续逛：</p>'
          + '<div class="empty-actions">'
          + '<button class="btn btn-primary sm" id="emptyClear">清除搜索，看全部 ' + INDEX.count + ' 套</button>'
          + topModels.map(([m, n]) => '<a class="btn ghost sm" href="' + base + 'model/' + encodeURIComponent(m) + '.html">👤 ' + esc(m) + '（' + n + ' 套）</a>').join('')
          + '<a class="btn ghost sm" href="' + base + 'collections.html">🏷 全部标签与系列</a>'
          + '</div>'
          + '<p class="empty-sub">热门标签（点一下直接搜）</p>'
          + '<div class="chips-cloud" id="emptyTags">'
          + topTags.map(([t, n]) => '<button class="cloud-chip" data-tag="' + esc(t) + '">#' + esc(t) + '<span>' + n + '</span></button>').join('')
          + '</div></div>';
      };
      const renderList = (q) => {
        const all = applySort(INDEX.sets.filter(s => hits(s, q)));
        // 客户端分页：沿用同一套 Bootstrap 分页类名，搜索结果多时不再一屏铺完
        const PER = 30;   // 与 setsPerPage 一致：30 能被 5（桌面）/3（平板）/2（手机）整除，每页都是整行
        const pages = Math.max(1, Math.ceil(all.length / PER));
        if (curPage > pages) curPage = 1;
        const list = all.slice((curPage - 1) * PER, curPage * PER);
        grid.innerHTML = list.map(cardHtml).join('');
        const head = document.querySelector('.page-head');
        const hero = document.getElementById('hero');
        if (hero) hero.hidden = !!q;                       // 搜索/筛选时先收起推荐轮播
        if (head) {
          // 只有"搜索中"才显示标题区（带匹配条数 + 清除筛选）；平时列表上方不摆那行体量说明
          // （体量信息在页脚）—— 标题区为空时整块隐藏，避免留出空白间距
          const sortLabel = SORT_LABEL[SORT] || '最新发布';
          const isDefaultSort = SORT === 'date-desc';
          if (q) {
            head.hidden = false;
            head.innerHTML = '<h1>搜索结果</h1><p class="sub">匹配「' + esc(q) + '」共 ' + all.length + ' 套'
              + (isDefaultSort ? '' : ' · 按' + esc(sortLabel))
              + ' · <a href="' + base + 'index.html" class="dim">清除筛选</a></p>';
          } else if (hero) {
            head.hidden = true;                             // 有轮播的首页：标题区整块不显示
            head.innerHTML = '';
          } else {
            head.hidden = false;                            // 无轮播的页面保留「全部图集」标题
            head.innerHTML = '<h1>全部图集</h1>';
          }
        }
        // 静态分页只在没筛选时显示；筛选时用客户端分页（注意别抓错元素：客户端那条也在 .pagination-wrap 里）
        const isFiltered = !!q || SORT !== 'date-desc';
        const staticPager = document.querySelector('.static-pager');
        if (staticPager) staticPager.hidden = isFiltered;
        if (clientPager) {
          clientPager.hidden = !isFiltered || pages <= 1;
          clientPager.innerHTML = (!isFiltered || pages <= 1) ? '' : clientPagerHtml(pages);
          clientPager.querySelectorAll('a[data-p]').forEach(a => a.addEventListener('click', (e) => {
            e.preventDefault();
            curPage = parseInt(a.dataset.p, 10) || 1;
            renderList(q);
            const g = document.getElementById('grid');
            if (g) window.scrollTo({ top: g.getBoundingClientRect().top + window.scrollY - 90, behavior: 'smooth' });
          }));
        }
        if (empty) {
          empty.hidden = all.length !== 0;
          empty.innerHTML = all.length === 0 ? emptyHtml(q) : '没有匹配的图集';
          if (all.length === 0) {
            // 空状态里的交互：清除搜索 / 点热门标签直接搜
            const clr = document.getElementById('emptyClear');
            if (clr) clr.addEventListener('click', () => {
              if (input) input.value = '';
              curPage = 1;
              renderList('');
              history.replaceState(null, '', base + 'index.html');
            });
            empty.querySelectorAll('#emptyTags button[data-tag]').forEach(b => b.addEventListener('click', () => {
              const t = b.dataset.tag;
              if (input) input.value = t;
              curPage = 1;
              renderList(t.toLowerCase());
              history.replaceState(null, '', base + 'index.html?q=' + encodeURIComponent(t));
            }));
          }
        }
      };
      // 快捷筛选芯片：热门系列 + 模特
      if (chips) {
        const seriesCount = {}, modelCount = {};
        INDEX.sets.forEach(s => {
          if (s.series) seriesCount[s.series] = (seriesCount[s.series] || 0) + 1;
          if (s.model) modelCount[s.model] = (modelCount[s.model] || 0) + 1;
        });
        const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 6);
        const mk = (label, val) => '<button data-q="' + esc(val) + '">' + esc(label) + '</button>';
        chips.innerHTML = top(seriesCount).map(([k, n]) => mk(k + ' ' + n, k)).join('');
        chips.querySelectorAll('button[data-q]').forEach(b => b.addEventListener('click', () => {
          const q = b.dataset.q;
          chips.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
          if (input) input.value = q;
          curPage = 1;
          renderList(q.toLowerCase());
          history.replaceState(null, '', base + 'index.html?q=' + encodeURIComponent(q));
        }));
      }
      if (sortChips) sortChips.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-sort]');
        if (!btn) return;
        SORT = btn.dataset.sort || 'date-desc';
        sortChips.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === btn));
        const q = (document.getElementById('q')?.value || '').trim().toLowerCase();
        curPage = 1;
        renderList(q);
      });
      if (false) (() => {
        const q = (document.getElementById('q')?.value || '').trim().toLowerCase();
        curPage = 1;
        renderList(q);
      });
      const toTop = document.getElementById('toTop');
      if (toTop) {
        window.addEventListener('scroll', () => { toTop.hidden = window.scrollY < 600; }, { passive: true });
        toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
      }
      // 置顶推荐轮播：自动播放 5s，悬停暂停，支持箭头/圆点/触摸滑动
      const heroBox = document.getElementById('hero');
      if (heroBox) {
        const slides = [...heroBox.querySelectorAll('.hero-slide')];
        const dots = [...heroBox.querySelectorAll('.hero-dot')];
        const items = [...heroBox.querySelectorAll('.hero-item')];
        const listInner = heroBox.querySelector('.hero-list-inner');
        // 选中项始终滚到可视区正中间（清单比轮播高时才有意义）
        const centerItem = (k) => {
          const el = items[k];
          if (!el || !listInner || listInner.scrollHeight <= listInner.clientHeight + 2) return;
          const cr = listInner.getBoundingClientRect(), er = el.getBoundingClientRect();
          const delta = (er.top - cr.top) - (cr.height / 2 - er.height / 2);
          listInner.scrollTo({ top: listInner.scrollTop + delta, behavior: 'smooth' });
        };
        // 滚轮：只滚清单本身（不带动页面），每次一格匀速
        if (listInner) {
          listInner.addEventListener('wheel', (e) => {
            if (listInner.scrollHeight <= listInner.clientHeight + 2) return;   // 没得滚就交给页面
            e.preventDefault();
            listInner.scrollTop += e.deltaY;
          }, { passive: false });
        }
        if (slides.length > 1) {
          let hi = 0, ht = null;
          const show = (i, center) => {
            hi = (i + slides.length) % slides.length;
            slides.forEach((el, k) => el.classList.toggle('on', k === hi));
            dots.forEach((el, k) => el.classList.toggle('on', k === hi));
            items.forEach((el, k) => el.classList.toggle('on', k === hi));
            if (center !== false) centerItem(hi);
          };
          const stop = () => { if (ht) { clearInterval(ht); ht = null; } };
          const play = () => { stop(); ht = setInterval(() => show(hi + 1), 5000); };
          const jump = (i) => { show(i); play(); };
          heroBox.querySelector('.hero-prev').addEventListener('click', () => jump(hi - 1));
          heroBox.querySelector('.hero-next').addEventListener('click', () => jump(hi + 1));
          dots.forEach((el, k) => el.addEventListener('click', () => jump(k)));
          items.forEach((el, k) => el.addEventListener('mouseenter', () => { show(k); centerItem(k); }));
          heroBox.addEventListener('mouseenter', stop);
          heroBox.addEventListener('mouseleave', play);
          let hx = null;
          heroBox.addEventListener('touchstart', (e) => { hx = e.touches[0].clientX; stop(); }, { passive: true });
          heroBox.addEventListener('touchend', (e) => {
            if (hx === null) return;
            const dx = e.changedTouches[0].clientX - hx;
            if (Math.abs(dx) > 40) show(hi + (dx < 0 ? 1 : -1));
            hx = null; play();
          }, { passive: true });
          show(0, false); play();
        }
      }
      // 函数都就位了，现在才安全地按 URL 里的 ?q= 渲染初始结果
      if (q0) renderList(q0.toLowerCase());
    }).catch((e) => { console.error('[列表页]', e); });
  }

  // 详情页预览：行式铺满布局（每行 2~3 张，横向铺满整行，图片保持原比例不裁剪）
  // 宽高比在构建时就写进 data-ratio → 不依赖图片加载，布局一次算完、刷新完全一致。
  // 行组合用 DP 选：让每行高度尽量贴近目标高度，且不会剩下一张孤图。
  const gallery = document.getElementById('gallery');
  const loadedCount = document.getElementById('loadedCount');
  if (gallery) {
    const GAP = 16;
    const ROW_TARGET = ${JSON.stringify(config.previewRowTarget || 460)};   // 目标行高（site.json: previewRowTarget）
    const ROW_MAX = ${JSON.stringify(Math.min(3, Math.max(2, config.previewRowMax || 3)))};   // 每行最多几张（site.json: previewRowMax，2~3）
    const ROW_MIN_H = Math.round(ROW_TARGET * 0.42);    // 行高下限
    const ROW_MAX_H = Math.round(ROW_TARGET * 1.45);    // 行高上限
    const BIG_PENALTY = 900;
    const items = [...gallery.querySelectorAll('.preview')];
    let W = 0;

    // 把 items 按 2~ROW_MAX 张切成若干行：DP 求总代价最小的切法
    const splitRows = () => {
      const n = items.length;
      const ratioAt = i => parseFloat(items[i].dataset.ratio) || 0.75;
      const hOf = (i, k) => {
        let s = 0;
        for (let j = i; j < i + k; j++) s += ratioAt(j);
        return (W - GAP * (k - 1)) / s;
      };
      const minTileW = Math.max(120, Math.min(200, W * 0.26));   // 单张太窄就扣分（窄屏自动放宽）
      const cost = (i, k) => {
        const h = hOf(i, k);
        let c = Math.abs(h - ROW_TARGET);
        if (h < ROW_MIN_H || h > ROW_MAX_H) c += BIG_PENALTY;
        for (let j = i; j < i + k; j++) { if (ratioAt(j) * h < minTileW) { c += BIG_PENALTY; break; } }
        return c;
      };
      const dp = new Array(n + 1).fill(Infinity), pick = new Array(n + 1).fill(0);
      const minPer = W < 460 ? 1 : 2;    // 手机窄屏：允许单张一行（否则瓦片会缩到 100px 出头）
      dp[n] = 0;
      for (let i = n - 1; i >= 0; i--) {
        for (let k = minPer; k <= ROW_MAX; k++) {
          if (i + k > n) continue;
          const c = cost(i, k) + dp[i + k];
          if (c < dp[i]) { dp[i] = c; pick[i] = k; }
        }
      }
      // 兜底：只剩 1 张（图集只有 1 张预览）时单独一行，铺满整行
      if (!isFinite(dp[0])) {
        const rows = [];
        for (let i = 0; i < n; i += 2) rows.push({ i, k: Math.min(2, n - i) });
        return rows;
      }
      const rows = [];
      let i = 0;
      while (i < n) { const k = pick[i]; rows.push({ i, k }); i += k; }
      return rows;
    };

    const layout = (instant) => {
      W = gallery.clientWidth || gallery.parentElement.clientWidth;
      if (!items.length || !W) return;
      if (instant || !ioStarted) gallery.classList.add('no-anim');
      const rows = splitRows();
      let y = 0;
      rows.forEach(r => {
        let sum = 0;
        for (let j = 0; j < r.k; j++) sum += parseFloat(items[r.i + j].dataset.ratio) || 0.75;
        const h = Math.round((W - GAP * (r.k - 1)) / sum);
        let x = 0;
        for (let j = 0; j < r.k; j++) {
          const el = items[r.i + j];
          // 最后一张吃掉取整误差 → 每一行都正好铺满整行
          const w = (j === r.k - 1) ? (W - x) : Math.round((parseFloat(el.dataset.ratio) || 0.75) * h);
          el.style.width = w + 'px';
          el.style.height = h + 'px';
          el.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
          el.classList.add('placed');
          x += w + GAP;
        }
        y += h + GAP;
      });
      gallery.style.height = Math.max(0, y - GAP) + 'px';
      // 等两帧：让禁用动画后的最终位置提交给浏览器，再恢复过渡并开始懒加载观察。
      // （观察器若在动画/旧几何下启动，会把整页瓦片都当成"在视口里"，一次性下载全部缩略图）
      if (!ioStarted) requestAnimationFrame(() => requestAnimationFrame(() => {
        gallery.classList.remove('no-anim');
        startLoading();
      }));
    };

    // 图片加载：懒加载 + WebP 失败回退 JPG；只负责显示，不再改变落位（避免布局抖动）
    let loadedN = 0;
    const hintLoading = document.getElementById('hintLoading');
    const hintDone = document.getElementById('hintDone');
    const hintTotal = parseInt((document.getElementById('streamHint') || {}).dataset?.total || '0', 10) || items.length;
    const syncHint = () => {
      if (loadedCount) loadedCount.textContent = loadedN;
      // 全部加载完就换成"已加载完"文案，避免 8 / 8 被误读成图集张数
      if (hintLoading && hintDone && loadedN >= hintTotal) {
        hintLoading.hidden = true;
        hintDone.hidden = false;
      }
    };
    const loadOne = (el) => {
      if (el.dataset.done) return;
      el.dataset.done = '1';
      const img = el.querySelector('img');
      let tried = 0, counted = false;
      const done = () => {
        img.classList.add('loaded');
        if (!counted) { counted = true; loadedN++; syncHint(); }
      };
      const attempt = (src) => {
        const real = new Image();
        real.onload = () => { img.src = real.src; done(); };
        real.onerror = () => {
          if (tried === 0 && img.dataset.fallback) { tried = 1; attempt(img.dataset.fallback); return; }
          el.classList.add('failed');
        };
        real.src = src;
        if (real.complete && real.naturalWidth) { img.src = real.src; done(); }
      };
      attempt(img.dataset.src || img.src);
    };

    // 懒加载观察器：必须等"排好版"之后再观察。
    // 否则首次 layout() 时容器宽度还是 0（样式未就绪）→ 所有瓦片都堆在左上角 →
    // 观察器以为整页都在视口里，一口气把几十上百张缩略图全下载了。
    let ioStarted = false;
    const startLoading = () => {
      if (ioStarted || !items.length) return;
      ioStarted = true;
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
          entries.forEach(e => { if (e.isIntersecting) { loadOne(e.target); io.unobserve(e.target); } });
        }, { rootMargin: '400px 0px' });
        items.forEach(el => io.observe(el));
        // 兜底：快速滚动/直接跳转时，中间的瓦片可能一帧之间就被划过去了，
        // 观察器不会为它们触发 → 这里在滚动停止后把"已经滚过"的补上（不预加载下方未看到的）
        let st = null;
        window.addEventListener('scroll', () => {
          if (st) return;
          st = setTimeout(() => {
            st = null;
            const limit = window.scrollY + window.innerHeight + 400;
            items.forEach(el => {
              if (el.dataset.done) return;
              const r = el.getBoundingClientRect();
              if (r.top + window.scrollY < limit) loadOne(el);
            });
          }, 180);
        }, { passive: true });
      } else {
        items.forEach(loadOne);
      }
    };

    // 首次排版（成功的话 layout() 内部会启动懒加载观察；失败则等 load 事件重排后再启动）
    layout();

    // 尺寸变化 → 用同一套算法重排（结果可预期）
    let rt = null;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(layout, 140);
    });
    // 首屏 clientWidth 可能取到 0（字体/滚动条就绪前）→ 加载完再校一次
    window.addEventListener('load', () => setTimeout(layout, 60));

    // 调试钩子（控制台可用：__masonry.layout()）
    window.__masonry = { layout, items, gallery };
  }

  // 详情页侧栏：内容能一屏放下就完整显示（不加 max-height → 不出滚动条）；
  // 只有内容比视口还高时才加 side-tall 收口（栏内滚动，滚动条隐藏）。
  const sideEl = document.querySelector('.detail-side');
  if (sideEl) {
    const fitSide = () => {
      const vh = window.innerHeight;
      sideEl.classList.toggle('side-tall', sideEl.scrollHeight > vh - 96);
    };
    fitSide();
    window.addEventListener('resize', fitSide);
    window.addEventListener('load', () => setTimeout(fitSide, 80));
  }

  // 详情页：PhotoSwipe 画廊（成熟组件：缩放/滑动切换/键盘/缩略图索引）
  if (document.getElementById('gallery')) {
    const base = (location.pathname.includes('/set/') ? '../../' : '');
    import(base + 'assets/photoswipe/photoswipe-lightbox.esm.min.js').then(({ default: PhotoSwipeLightbox }) => {
      const lightbox = new PhotoSwipeLightbox({
        gallery: '#gallery',
        children: 'a.preview-link',
        pswpModule: () => import(base + 'assets/photoswipe/photoswipe.esm.min.js'),
        showHideAnimationType: 'zoom',
        bgOpacity: 0.96,
        padding: { top: 24, bottom: 76, left: 8, right: 8 },
        imageClickAction: 'zoom',
        tapAction: 'toggle-controls',
        doubleTapAction: 'zoom',
      });
      lightbox.on('uiRegister', () => {
        // 顶部标题
        lightbox.pswp.ui.registerElement({
          name: 'caption',
          order: 9, isButton: false, appendTo: 'root',
          html: '', onInit: (el, pswp) => {
            pswp.on('change', () => {
              const t = document.querySelector('.detail-title')?.textContent || document.title;
              el.textContent = t + '　（' + (pswp.currIndex + 1) + ' / ' + pswp.getNumItems() + '）';
              el.className = 'pswp-caption';
            });
          },
        });
      });
      lightbox.init();
    }).catch(() => {
      // 兜底：直接新窗口打开原图
      document.querySelectorAll('a.preview-link').forEach(a => {
        a.addEventListener('click', (e) => { e.preventDefault(); window.open(a.href, '_blank'); });
      });
    });
  }
})();`

// ─────────────────────────── 构建 ───────────────────────────
/** 落盘样式与脚本（构建开头与结尾各调一次：开头这次保证"构建被打断也不会裸奔无样式"） */
function writeAssets() {
  mkdirSync(join(DIST, 'assets'), { recursive: true })
  writeFileSync(join(DIST, 'assets', 'style.css'), STYLE)
  writeFileSync(join(DIST, 'assets', 'app.js'), APP)
  writeFileSync(join(DIST, 'assets', 'photoswipe-extra.css'), PSWP_EXTRA)
  // 模特头像（后台裁剪生成，models/avatar/<模特>.{webp,jpg,png}）→ 站点静态资源
  const avSrc = join(ROOT, 'models', 'avatar')
  if (existsSync(avSrc)) {
    const avOut = join(DIST, 'assets', 'avatar')
    mkdirSync(avOut, { recursive: true })
    for (const f of readdirSync(avSrc)) {
      if (!/\.(webp|jpe?g|png)$/i.test(f)) continue
      copyFileSync(join(avSrc, f), join(avOut, f))
    }
  }
  // PhotoSwipe（本地化，无 CDN 依赖）
  const pswpSrc = join(ROOT, 'vendor', 'photoswipe')
  if (existsSync(pswpSrc)) {
    const pswpOut = join(DIST, 'assets', 'photoswipe')
    mkdirSync(pswpOut, { recursive: true })
    for (const f of readdirSync(pswpSrc)) {
      const dst = join(pswpOut, f)
      if (!existsSync(dst) || statSync(dst).size !== statSync(join(pswpSrc, f)).size) {
        copyFileSync(join(pswpSrc, f), dst)
      }
    }
  } else {
    console.warn('! 未找到 vendor/photoswipe（画廊组件缺失，将回退为新窗口打开原图）')
  }
  return true
}

/** 同步等待（不引额外依赖，也不用假的 shell sleep） */
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch {} }

/**
 * 逐个删目录内容（Windows 上整树 rmSync 常因文件被杀软/预览服务器瞬时占用而
 * 抛 ENOTEMPTY/EBUSY）。返回没删掉的项数。
 */
function rmContents(dir) {
  let left = 0
  let names = []
  try { names = readdirSync(dir) } catch { return 0 }
  for (const name of names) {
    const p = join(dir, name)
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      try { rmSync(p, { recursive: true, force: true }) } catch { left++ }
    }
  }
  return left
}

/** 清空一个目录（先整树删、失败再逐个删；仍失败也不抛错，交给调用方决定） */
function wipeDist(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
    return 0
  } catch { /* 落到逐个删 */ }
  return rmContents(dir)
}

/**
 * 原子切换：暂存目录建好后整体换上去。
 * 这样"构建到一半"永远不会影响访客看到的 dist（构建期间读的一直是旧产物）。
 *
 * 坑：Windows 上 rename 的**目标目录已存在**时会报 EPERM（不是被占用！），
 * 所以备份名必须保证不存在 —— 上一次残留的空 dist.old 就足以让下一次切换失败。
 */
function promoteStage() {
  // 1) 备份名：优先 dist.old，被占就换 dist.old1/2/3…（顺带清理历史残留）
  let oldPath = DIST_OLD
  for (let i = 1; existsSync(oldPath) && i <= 20; i++) {
    rmContents(oldPath)
    try { rmSync(oldPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }) } catch {}
    if (!existsSync(oldPath)) break
    oldPath = join(ROOT, 'dist.old' + i)
  }
  // 2) dist → 备份名
  try {
    renameSync(DIST_REAL, oldPath)
  } catch (e) {
    // 不删 dist！宁可这次构建不算数，也不让访客看到半成品
    rmContents(DIST_STAGE)
    console.error('× 无法切换产物：dist 改名失败（' + (e.code || e.message) + '）')
    console.error('  dist 保持原样未动；本次构建结果在 dist.new/，关掉占用 dist 的程序后重跑即可')
    process.exit(1)
  }
  // 3) dist.new → dist；失败则回滚，绝不留下"没有 dist"的状态
  try {
    renameSync(DIST_STAGE, DIST_REAL)
  } catch (e) {
    try { renameSync(oldPath, DIST_REAL) } catch {}
    console.error('× 产物切换失败：' + (e.code || e.message) + '（已回滚到上一版 dist）')
    process.exit(1)
  }
  // 4) 清掉旧产物（删不掉就留着，下次构建开头再清）
  rmContents(oldPath)
  try { rmSync(oldPath, { recursive: true, force: true }) } catch { /* 空目录残留无妨 */ }
}

function build() {
  if (!existsSync(SETS_DIR)) { console.error('× 找不到 sets/ 目录'); process.exit(1) }
  // 全程写暂存目录，最后原子切换（构建中途失败/被打断，访客读到的 dist 依然是上一版完整的）
  DIST = DIST_STAGE
  const leftStage = wipeDist(DIST_STAGE)
  if (leftStage) console.warn(`! dist.new 里有 ${leftStage} 项没删掉（被占用），会直接覆盖写入`)
  mkdirSync(join(DIST, 'assets'), { recursive: true })
  ASSET_V = createHash('sha1').update(STYLE + APP).digest('hex').slice(0, 8)
    + (config.assetSalt ? '-' + config.assetSalt : '')
  ANALYTICS = ANALYTICS_RAW()
  // 安全网：APP 是模板字符串，正则里的反斜杠转义容易被吃掉（曾导致整站 JS 静默失效）
  // 这里只编译不执行，语法有问题立刻中断构建
  try {
    new Function(APP)
  } catch (e) {
    console.error('× assets/app.js 语法错误（常见原因：模板字符串吞掉了 \\ 转义）→ ' + e.message)
    process.exit(1)
  }

  const slugs = readdirSync(SETS_DIR).filter(name => statSync(join(SETS_DIR, name)).isDirectory())
  const sets = slugs.map(readSet).filter(Boolean)
    .sort((a, b) => cmpDateDesc(a, b))
  hiddenCountGlobal = sets.filter(s => s.hiddenOk).length
  // 页脚用的整站体量文案（跟分页无关，一次算好给 layout 用）
  {
    const bytes = sets.reduce((n, s) => n + (s.bytes || 0), 0)
    const imgs = sets.reduce((n, s) => n + (s.imageCount || 0), 0)
    SITE_BITS = `共 ${sets.length} 套 · ${imgs} 张${bytes ? ` · 合计 ${fmtSize(bytes)}` : ''}`
  }
  // 同名作品（不同模特 / 不同系列拍同一主题）很常见：给它们标一个**真能区分开**的标签 ——
  // 模特都不重样就用模特，模特重样但系列不重样就用系列，两者都重样才用「模特·系列」
  const titleGroups = {}
  sets.forEach(s => { const t = (s.title || '').trim(); (titleGroups[t] = titleGroups[t] || []).push(s) })
  Object.values(titleGroups).forEach(list => {
    if (list.length < 2) return
    const allUnique = (key) => new Set(list.map(x => String(x[key] || '').trim())).size === list.length
    const useModel = allUnique('model'), useSeries = allUnique('series')
    list.forEach(x => {
      x.dupTitle = true
      x.dupTag = useModel ? (x.model || '')
        : useSeries ? (x.series || '')
          : (x.model && x.series ? `${x.model}·${x.series}` : (x.model || x.series || x.slug))
    })
  })
  // 卡片角标用的模特头像：自定义头像优先，否则用该模特最新一套公开图集的封面
  const byModelAll = {}
  sets.forEach(s => { if (s.model) (byModelAll[s.model] = byModelAll[s.model] || []).push(s) })
  for (const [m, list] of Object.entries(byModelAll)) {
    const av = avatarUrl(m, '')
    if (av) { MODEL_FACE[m] = av.replace(/^\//, ''); continue }
    const pub = list.filter(s => !s.hidden && s.coverFile).sort((a, b) => cmpDateDesc(a, b))[0]
    if (pub) MODEL_FACE[m] = setCoverUrl(pub, '').replace(/^\//, '')
  }
  // 置顶推荐（列表页顶部轮播）：按 pinOrder 升序，没填的排在后面并按日期
  // 置顶推荐也包含隐藏图集：它在轮播里显示模糊封面 + 🔒，点它要输密码
  const pinnedSets = sets.filter(s => s.pinned)
    .sort((a, b) => (a.pinOrder || 9999) - (b.pinOrder || 9999) || cmpDateDesc(a, b))
  if (!sets.length) console.warn('! sets/ 下没有有效图集（每个图集目录需含 meta.json）')
  // ★ 先把样式/脚本落盘：后面复制缩略图要花几十秒，万一构建被打断（关掉后台、重启进程等），
  //   至少页面还是有样式的。曾经的坑：assets 放在最后写，构建中途被杀 → 全站裸奔无 CSS。
  writeAssets()

  // 列表页分页
  const per = config.setsPerPage
  const totalPages = Math.max(1, Math.ceil(sets.length / per))
  for (let p = 1; p <= totalPages; p++) {
    const pageSets = sets.slice((p - 1) * per, p * per)
    // 分页页在 dist/page/N.html，比首页深一层 → 相对路径只用一级 ../
    // （原来写的 ../../ 靠浏览器"不能上到域名之上"夹住才没出错，路径本身是错的）
    const rel = p === 1 ? '' : '../'
    const html = listPage(pageSets, p, totalPages, rel, sets.length, sets, pinnedSets)
    if (p === 1) writeFileSync(join(DIST, 'index.html'), html)
    else { mkdirSync(join(DIST, 'page'), { recursive: true }); writeFileSync(join(DIST, `page/${p}.html`), html) }
  }

  // ── 系列 / 标签统计（详情页侧栏与分类页共用，必须先算）──
  const bySeries = {}, byTag = {}
  sets.forEach(s => {
    if (s.series) (bySeries[s.series] = bySeries[s.series] || []).push(s)
    s.tags.forEach(t => (byTag[t] = byTag[t] || []).push(s))
  })

  // 详情页 + 资源
  let deployedThumbCount = 0
  const hiddenNoPw = sets.filter(s => s.hidden && !s.hiddenOk).map(s => s.slug)
  if (hiddenNoPw.length) console.warn(`! 这些图集勾了隐藏但没配密码（构建时会被当成无入口的糊图）：${hiddenNoPw.join('、')}`)
  let hiddenCount = 0
  sets.forEach((s, i) => {
    // 隐藏套图写到 h/<token>/ 下：地址由密码算出，公开的目录里找不到它
    const outDir = join(DIST, ...(s.hiddenOk ? ['h', s.token] : ['set', s.slug]))
    if (s.hiddenOk) hiddenCount++
    mkdirSync(outDir, { recursive: true })
    const related = relatedSets(s, sets)
    // 模特的其他作品（侧栏推荐）：同系列优先，再按日期倒序，取 5 套
    const sameModel = s.model ? sets.filter(x => x.model === s.model && x.slug !== s.slug) : []
    const moreSets = sameModel.slice().sort((a, b) => {
      const sa = (s.series && a.series === s.series) ? 0 : 1
      const sb = (s.series && b.series === s.series) ? 0 : 1
      return sa - sb || String(b.date || '').localeCompare(String(a.date || ''))
    }).slice(0, config.modelSideCount || 5)
    const detailUrl = s.hiddenOk ? pageUrl(`h/${s.token}/`) : pageUrl(`set/${encodeURIComponent(s.slug)}/`)
    writeFileSync(join(outDir, 'index.html'), detailPage(s, sets[i - 1], sets[i + 1], detailUrl, related, byTag, moreSets, sameModel.length + 1))

    // 预览图（原图；精简模式下不复制，改用缩略图作为大图）
    const imgOut = join(outDir, 'images')
    if (!LITE) {
      mkdirSync(imgOut, { recursive: true })
      s.images.forEach(f => copyFileSync(join(s.dir, 'images', f), join(imgOut, f)))
    }
    // 压缩包（精简模式下不复制，依赖网盘外链）
    if (s.hasPack && !LITE) copyFileSync(s.packPath, join(outDir, 'pack.zip'))

    // 缩略图：全部部署，webp 与 jpg 两种格式都带上（jpg 作为老浏览器回退）
    // 清晰度优先：100 套约 8500 个文件，仍在 Pages 免费额度 2 万以内
    if (s.hasThumbs) {
      const thumbOut = join(outDir, 'thumbs')
      const keep = new Set([...s.thumbs, ...Object.values(s.thumbAlt || {}), s.coverThumb, s.bannerThumb].filter(Boolean))
      mkdirSync(thumbOut, { recursive: true })
      keep.forEach(f => copyFileSync(join(s.dir, 'thumbs', f), join(thumbOut, f)))
      deployedThumbCount += keep.size
    }

    // 封面 / 自定义 Banner
    if (s.coverFile) copyFileSync(join(s.dir, s.coverFile), join(outDir, s.coverFile))
    if (s.bannerFile && s.bannerFile !== s.coverFile) copyFileSync(join(s.dir, s.bannerFile), join(outDir, s.bannerFile))
  })

  // 公开的模糊小图（锁定卡片用）：放 dist/blur/<slug>.webp，谁都能取，但只有 24px 色块
  const blurOut = join(DIST, 'blur')
  const blurSets = sets.filter(s => s.hidden && (s.blurThumb || s.blurFile))
  if (blurSets.length) {
    mkdirSync(blurOut, { recursive: true })
    blurSets.forEach(s => {
      const src = s.blurThumb ? join(s.dir, 'thumbs', s.blurThumb) : join(s.dir, s.blurFile)
      copyFileSync(src, join(blurOut, `${s.slug}.webp`))
    })
  }
  if (hiddenCount) console.log(`  隐藏套图 ${hiddenCount} 套 → h/<密码算出的地址>/（公开目录里查不到）`)

  // ── 系列页 / 标签页（静态化，SEO 友好）──
  mkdirSync(join(DIST, 'series'), { recursive: true })
  mkdirSync(join(DIST, 'tag'), { recursive: true })
  // 标签/系列云（按图集数排序）：给每个标签页底部一份，方便访客横向浏览
  const tagCloud = Object.entries(byTag).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  const seriesCloud = Object.entries(bySeries).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  for (const [name, list] of Object.entries(bySeries)) {
    writeFileSync(join(DIST, 'series', `${name}.html`), collectionPage('series', name, list, sets, '../', seriesCloud))
  }
  for (const [name, list] of Object.entries(byTag)) {
    writeFileSync(join(DIST, 'tag', `${name}.html`), collectionPage('tag', name, list, sets, '../', tagCloud))
  }
  // ── 模特：列表页 + 每位模特一个独立页 ──
  // 模特名来自每套图的 meta.model（后台「模特管理」可批量改名/合并，改一次全站生效）
  const byModel = {}
  sets.forEach(s => { if (s.model) (byModel[s.model] = byModel[s.model] || []).push(s) })
  mkdirSync(join(DIST, 'model'), { recursive: true })
  for (const [name, list] of Object.entries(byModel)) {
    writeFileSync(join(DIST, 'model', `${name}.html`), modelPage(name, list, '../'))
  }
  if (Object.keys(byModel).length) writeFileSync(join(DIST, 'models.html'), modelsIndexPage(byModel, sets))
  // 系列列表页：只在真的有系列时生成（否则是个空页面，反而困惑）
  if (Object.keys(bySeries).length) writeFileSync(join(DIST, 'series.html'), seriesIndexPage(bySeries, sets))

  // 系列/标签索引页
  writeFileSync(join(DIST, 'collections.html'), layout({
    title: `全部系列与标签 - ${config.siteName}`,
    desc: `${config.siteName} 的系列与标签索引`,
    rel: '',
    body: `<div class="page-head"><h1>系列与标签</h1><p class="sub">共 ${Object.keys(bySeries).length} 个系列 · ${Object.keys(byTag).length} 个标签 · ${Object.keys(byModel).length} 位模特</p></div>
      <h2 class="sec-title" id="models">模特</h2>
      <div class="chips-cloud">${Object.entries(byModel).sort((a, b) => b[1].length - a[1].length).map(([n, l]) => `<a class="cloud-chip" href="model/${encodeURIComponent(n)}.html">👤 ${esc(n)}<span>${l.length}</span></a>`).join('') || '<span class="dim">暂无</span>'}</div>
      <h2 class="sec-title" id="series">系列</h2>
      <div class="chips-cloud">${Object.entries(bySeries).sort((a, b) => b[1].length - a[1].length).map(([n, l]) => `<a class="cloud-chip" href="series/${encodeURIComponent(n)}.html">${esc(n)}<span>${l.length}</span></a>`).join('') || '<span class="dim">还没有系列：在后台编辑图集时填「系列」字段（比如某个模特的第几期），这里就会自动出现系列页</span>'}</div>
      <h2 class="sec-title" id="tags">标签</h2>
      <div class="chips-cloud">${Object.entries(byTag).sort((a, b) => b[1].length - a[1].length).map(([n, l]) => `<a class="cloud-chip" href="tag/${encodeURIComponent(n)}.html">#${esc(n)}<span>${l.length}</span></a>`).join('') || '<span class="dim">暂无</span>'}</div>`,
    canonical: pageUrl('collections.html'),
  }))

  // ── 合规页：免责声明 / DMCA + 隐私政策 ──
  const contact = config.dmca
    ? `<p>版权投诉与内容下架请联系：<strong>${esc(config.dmca)}</strong>。我们收到有效通知后会在 48 小时内处理。</p>`
    : `<p>版权投诉与内容下架，请通过站点管理员的联系方式提交，注明作品名称、权利证明与具体链接。我们收到有效通知后会在 48 小时内处理。</p>`
  writeFileSync(join(DIST, 'about.html'), layout({
    title: `免责声明与版权 - ${config.siteName}`,
    desc: `${config.siteName} 的免责声明、版权声明（DMCA）与内容来源说明`,
    rel: '',
    body: `<div class="page-head"><h1>免责声明与版权</h1><p class="sub">最后更新：${esc(new Date().toISOString().slice(0, 10))}</p></div>
    <div class="legal">
      <h2>一、内容来源</h2>
      <p>本站为个人非商业性质的图片收集与整理站点，所有图集均来自互联网公开渠道的分享与转载，本站不生产、不销售、不提供任何付费内容。</p>
      <h2>二、版权归属</h2>
      <p>所有图片的著作权归原作者及合法权利人所有。本站仅作展示与索引，不主张任何版权。若您为权利人且不希望作品被本站收录，请与我们联系，我们将立即删除相关内容。</p>
      <h2>三、侵权处理（DMCA）</h2>
      ${contact}
      <h2>四、使用限制</h2>
      <p>本站内容仅供个人学习、研究与欣赏，<strong>禁止用于任何商业用途</strong>；请勿转载、二次分发或用于任何违法用途。请于下载后 24 小时内自行删除。</p>
      <h2>五、免责条款</h2>
      <p>${esc(config.disclaimer || defaultConfig.disclaimer)}</p>
      <p>本站可能包含来自第三方网站的外链（如网盘下载地址），本站无法控制其内容与可用性，亦不承担由此产生的任何责任。</p>
      <h2>六、未成年人</h2>
      <p>本站内容面向成年人。若您未满 18 周岁，请立即离开本站。</p>
    </div>`,
    canonical: pageUrl('about.html'),
  }))
  if (config.privacy) {
    writeFileSync(join(DIST, 'privacy.html'), layout({
      title: `隐私政策 - ${config.siteName}`,
      desc: `${config.siteName} 的隐私政策与 Cookie 使用说明`,
      rel: '',
      body: `<div class="page-head"><h1>隐私政策</h1><p class="sub">最后更新：${esc(new Date().toISOString().slice(0, 10))}</p></div>
      <div class="legal">${String(config.privacy).split(/\n{2,}/).map(p => `<p>${esc(p)}</p>`).join('')}</div>`,
      canonical: pageUrl('privacy.html'),
    }))
  }

  // ── 404 页（Cloudflare Pages / GitHub Pages / Netlify 均自动识别）──
  // 用根相对路径（rel: '/'），因为 404 会在任意层级被触发
  writeFileSync(join(DIST, '404.html'), layout({
    title: `页面不存在 - ${config.siteName}`,
    desc: '页面不存在',
    rel: '/',
    body: `<div class="page-head"><h1>404 · 页面不存在</h1><p class="sub">链接可能已失效，或这套图集已下架</p></div>
    <p class="notfound-actions">
      <a class="btn btn-primary" href="/index.html">返回首页</a>
      <a class="btn ghost" href="/collections.html">浏览系列与标签</a>
    </p>`,
  }))

  // ── Cloudflare Pages 缓存/安全响应头（其他平台会忽略此文件，无副作用）──
  // 注意：_headers 规则里 * 只能出现一次（两个 splat 会整条失效），路径中段用 :placeholder
  writeFileSync(join(DIST, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer-when-downgrade
  X-Frame-Options: SAMEORIGIN

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/set/:slug/thumbs/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800

/set/:slug/images/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800

/*.html
  Cache-Control: public, max-age=300

/sitemap.xml
  Cache-Control: public, max-age=3600

/feed.xml
  Cache-Control: public, max-age=3600
`)
  // 说明：Cloudflare 的 splat 必须独占一个路径段，`/*.html` 这类规则实际不生效，
  // 而 Pages 对 HTML 的默认行为正是 `max-age=0, must-revalidate`（带 ETag 协商缓存），
  // 对内容站恰好是最优解 —— 保持默认即可，上面那条规则仅为其他平台兼容而保留。

  // 资源与索引（CSS/JS 在构建开头就已写过一次，这里复写一次保证内容是最新的）
  writeAssets()
  // 隐藏套图：索引里只给 slug + 标题 + 模糊小图（不给任何真实路径），前端渲染成"锁定卡片"
  writeFileSync(join(DIST, 'search-index.json'), JSON.stringify({
    count: sets.length,
    generatedAt: new Date().toISOString(),
    sets: sets.map(s => ({
      slug: s.slug, title: s.title, displayTitle: s.displayTitle,
      series: s.series, model: s.model, date: s.date, addedAt: s.addedAt, tags: s.tags,
      imageCount: s.hidden ? 0 : s.imageCount, packSize: s.hidden ? '' : s.packSize,
      size: s.hidden ? '' : s.sizeText, bytes: s.hidden ? 0 : s.bytes,
      pinned: !!s.pinned && !s.hidden, pinOrder: s.pinOrder || 0,
      locked: !!s.hidden,
      dupTag: s.dupTag || '',
      face: s.model ? (MODEL_FACE[s.model] || '') : '',   // 卡片模特行的头像（客户端渲染要用）
      cover: s.hidden
        ? (s.blurThumb || s.blurFile ? `blur/${s.slug}.webp` : '')
        : (s.coverThumb ? `set/${s.slug}/thumbs/${s.coverThumb}${verQ(s.thumbVer[s.coverThumb])}` : (s.coverFile ? `set/${s.slug}/${s.coverFile}` : '')),
    })),
  }, null, 2))
  writeFileSync(join(DIST, '.nojekyll'), '')

  // ── SEO：robots.txt / sitemap.xml / RSS ──
  const base = (config.baseUrl || '').replace(/\/+$/, '')
  writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${base ? base + '/' : ''}sitemap.xml\n`)
  const urls = [
    { loc: pageUrl('index.html'), lastmod: sets[0]?.date || '', pri: '1.0' },
    ...(Object.keys(byModel).length ? [{ loc: pageUrl('models.html'), lastmod: sets[0]?.date || '', pri: '0.8' }] : []),
    ...(Object.keys(bySeries).length ? [{ loc: pageUrl('series.html'), lastmod: sets[0]?.date || '', pri: '0.6' }] : []),
    { loc: pageUrl('collections.html'), lastmod: sets[0]?.date || '', pri: '0.6' },
    { loc: pageUrl('about.html'), lastmod: '', pri: '0.3' },
    ...(config.privacy ? [{ loc: pageUrl('privacy.html'), lastmod: '', pri: '0.3' }] : []),
    ...Object.entries(byModel).map(([n, l]) => ({ loc: pageUrl(`model/${encodeURIComponent(n)}.html`), lastmod: l.map(s => s.date || '').sort().pop() || '', pri: '0.7' })),
    ...sets.filter(s => !s.hidden).map(s => ({ loc: pageUrl(`set/${encodeURIComponent(s.slug)}/index.html`), lastmod: s.date, pri: '0.8' })),
    ...Object.entries(bySeries).map(([n, l]) => ({ loc: pageUrl(`series/${encodeURIComponent(n)}.html`), lastmod: l[0]?.date || '', pri: '0.5' })),
    ...Object.entries(byTag).map(([n, l]) => ({ loc: pageUrl(`tag/${encodeURIComponent(n)}.html`), lastmod: l[0]?.date || '', pri: '0.5' })),
  ]
  writeFileSync(join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map(u => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ''}<priority>${u.pri}</priority></url>`).join('\n')
    + `\n</urlset>\n`)
  const rssDate = (d) => { try { return new Date(d + 'T00:00:00Z').toUTCString() } catch { return new Date().toUTCString() } }
  writeFileSync(join(DIST, 'feed.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n<title>${esc(config.siteName)}</title>\n<link>${esc(base || '/')}</link>\n<description>${esc(config.siteSubtitle)}</description>\n`
    + sets.filter(s => !s.hidden).slice(0, 30).map(s => `  <item>\n    <title>${esc(s.title)}</title>\n    <link>${esc(pageUrl(`set/${encodeURIComponent(s.slug)}/index.html`))}</link>\n    <guid>${esc(pageUrl(`set/${encodeURIComponent(s.slug)}/index.html`))}</guid>\n    <pubDate>${rssDate(s.date)}</pubDate>\n    <description>${esc(s.description || s.tags.join('、'))}</description>\n  </item>`).join('\n')
    + `\n</channel></rss>\n`)

  // ★ 全部写完 → 原子切换到 dist/（构建中途失败时访客读到的还是上一版完整站点）
  promoteStage()

  console.log(`✓ 构建完成：${sets.length} 套图集 · ${totalPages} 个列表页 → dist/`)
  console.log(`  缩略图部署 ${deployedThumbCount} 个`)
  // 原图托管地址是内网 IP 时提醒：公网访客打不开这些链接
  if (OL && /^https?:\/\/(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(OL.base))) {
    console.warn(`! OpenList 地址是内网地址（${OL.base}）→ 公网访客点「原图」「打开原图目录」会打不开`)
    console.warn('  对外可用需先用 Cloudflare Tunnel / 端口映射暴露，再把 site.json 的 openlist.base 换成公网域名')
  }
  sets.slice(0, 5).forEach(s => console.log(`   · ${s.displayTitle}（${s.imageCount}P${s.sizeText ? ' / ' + s.sizeText : ''}）`))
  if (sets.length > 5) console.log(`   … 另有 ${sets.length - 5} 套`)
}

build()
