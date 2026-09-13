#!/usr/bin/env node
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
  // 缩略图版本戳：文件变了 URL 就变，避免读到旧缓存
  const thumbVer = {}
  for (const f of [...thumbs, coverThumb].filter(Boolean)) thumbVer[f] = fileVer(join(dir, 'thumbs', f))
  const lqip = {}
  for (const f of images) {
    const p = join(dir, 'thumbs', f.replace(/\.[^.]+$/, '.lqip.jpg'))
    if (existsSync(p)) lqip[f] = 'data:image/jpeg;base64,' + readFileSync(p).toString('base64')
  }

  const date = meta.date || new Date(statSync(metaPath).mtime).toISOString().slice(0, 10)
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
    previews: images.slice(0, meta.previewCount || config.previewCount),
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
  <div class="grid">${sets.map(s => card(s, rel)).join('')}</div>
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
const layout = ({ title, desc, body, rel = '', nav = '', pswp = false, og = null, canonical = '', jsonld = '' }) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
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
    <a class="icon-btn" href="${rel}collections.html" title="系列与标签">☰</a>
  </div>
  ${nav}
</header>
<main class="wrap">${body}</main>
<footer class="site-footer">
  <div class="wrap">
    <p>${esc(config.siteName)} · 静态生成 · 共 <span id="set-total"></span> 套图</p>
    <p class="foot-links">
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
</body>
</html>`

const card = (s, rel = '') => `
<article class="card" data-title="${esc((s.displayTitle + ' ' + s.model + ' ' + s.tags.join(' ')).toLowerCase())}">
  <a class="card-link" href="${rel}set/${s.slug}/index.html">
    <div class="card-cover">
      ${s.coverFile
        ? `<img loading="lazy" src="${rel}set/${s.slug}/${s.coverThumb ? 'thumbs/' + s.coverThumb + verQ(s.thumbVer[s.coverThumb]) : s.coverFile}" alt="${esc(s.title)}">`
        : `<div class="no-cover">无封面</div>`}
      <span class="badge">${s.imageCount}P</span>
      ${s.sizeText ? `<span class="badge badge-size" title="原图总大小 ${esc(s.sizeText)}">${esc(s.sizeText)}</span>` : (s.packSize ? `<span class="badge badge-size">${esc(s.packSize)}</span>` : '')}
    </div>
    <h2 class="card-title">${esc(s.title)}</h2>
  </a>
  <div class="card-meta">
    ${s.series ? `<a class="tag tag-series" href="${rel}series/${encodeURIComponent(s.series)}.html" title="查看该系列全部图集">${esc(s.series)}</a>` : ''}
    ${s.tags.slice(0, 2).map(t => `<a class="tag tag-link" href="${rel}tag/${encodeURIComponent(t)}.html" title="查看同标签图集">${esc(t)}</a>`).join('')}
    <time datetime="${esc(s.date)}">${esc(s.date)}</time>
  </div>
</article>`

function listPage(sets, page, totalPages, rel = '', total = sets.length, allSets = null) {
  // 站内总张数与总体量（整站口径，跟分页无关）
  const siteList = allSets || sets
  const siteBytes = siteList.reduce((n, s) => n + (s.bytes || 0), 0)
  const siteCount = siteList.reduce((n, s) => n + (s.imageCount || 0), 0)
  const body = `
  <div class="page-head">
    <h1>最新图集</h1>
    <p class="sub">共 ${total} 套${siteBytes ? ` · ${siteCount} 张 · 合计 <b class="size-strong">${esc(fmtSize(siteBytes))}</b>` : ''}${totalPages > 1 ? ` · 第 ${page} / ${totalPages} 页（本页 ${sets.length} 套）` : ''}</p>
  </div>
  <div class="filters" id="filters">
    <select id="sortSel" title="排序方式">
      <option value="date-desc">最新发布</option>
      <option value="date-asc">最早发布</option>
      <option value="count-desc">图片最多</option>
      <option value="title-asc">标题排序</option>
    </select>
    <span class="filter-chips" id="filterChips"></span>
  </div>
  <div class="grid" id="grid">${sets.map(s => card(s, rel)).join('')}</div>
  <p class="empty" id="empty" hidden>没有匹配的图集</p>
  ${totalPages > 1 ? `<nav class="pager">
    ${page > 1 ? `<a href="${rel}${page === 2 ? 'index.html' : `page/${page - 1}.html`}">← 上一页</a>` : '<span class="dim">← 上一页</span>'}
    <span class="pager-now">${page} / ${totalPages}</span>
    ${page < totalPages ? `<a href="${rel}page/${page + 1}.html">下一页 →</a>` : '<span class="dim">下一页 →</span>'}
  </nav>` : ''}
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

function detailPage(s, prev, next, canonical = '', related = [], tagCounts = {}, moreSets = [], modelTotal = 0) {
  const rel = '../../'
  // 模特资料：仅展示填写过的字段（AI 不会生成这些）
  const pf = s.profile || {}
  // 社交账号单独渲染成可点链接（微博/抖音等平台按关键词搜索，避免写错主页地址）
  const pfSocial = { weibo: '微博', douyin: '抖音', x: 'X', ins: 'Instagram', bilibili: 'B站', xhs: '小红书' }
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
  // 模特资料：渲染成一段引文式文字（不堆卡片，可读性更好）
  // 顺序：出生 → 星座 → 常驻 → 身高/体重/三围/鞋码 → 风格 → 其他；labels 为空的字段本身已说明含义，不加前缀
  const pfOrder = [
    ['birth', '出生'], ['sign', ''], ['city', ''],
    ['height', '身高'], ['weight', '体重'], ['measure', '三围'], ['shoes', '鞋码'],
    ['style', ''], ['other', ''],
  ]
  const pfParts = []
  pfOrder.forEach(([k, label]) => {
    if (!pf[k]) return
    const v = String(pf[k]).trim()
    if (!label) { pfParts.push(v); return }
    // 「1998 年」→「1998 年出生」读起来更顺
    pfParts.push(k === 'birth' && /^\d{4}\s*年?$/.test(v) ? v.replace(/\s*年?$/, ' 年出生') : `${label} ${v}`)
  })
  const pfSocialItems = Object.keys(pfSocial).filter(k => pf[k]).map(k => {
    const v = String(pf[k])
    const u = socialUrl(k, v)
    return `${pfSocial[k]} ${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v)}`
  })
  const pfText = pfParts.join(' · ')
  // 模特资料引文：搬到右侧栏「👤 模特与系列」里（原来是放在正文顶部）
  const profileBlock = (pfText || pfSocialItems.length)
    ? `<blockquote class="pf-quote side-quote">${pfText ? `<p>${esc(pfText)}</p>` : ''}${pfSocialItems.length ? `<p class="pf-social">${pfSocialItems.join(' · ')}</p>` : ''}</blockquote>`
    : ''

  const previews = s.previews.length
    ? `<div class="previews" id="gallery">
      ${s.previews.map((f, i) => {
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
        const bigSrc = LITE ? `${rel}set/${s.slug}/${thumb}${verQ(s.thumbVer[tf])}` : `${rel}set/${s.slug}/images/${f}`
        return `<figure class="preview" data-ratio="${(size.w / size.h).toFixed(4)}">
        <a class="preview-link" href="${bigSrc}"
           data-pswp-width="${bigW}" data-pswp-height="${bigH}"
           data-pswp-srcset="${rel}set/${s.slug}/${thumb}${verQ(s.thumbVer[tf])} ${bigW}w"
           data-orig-w="${size.w}" data-orig-h="${size.h}"
           target="_blank" rel="noopener">
          <img class="ph" ${ph} data-src="${rel}set/${s.slug}/${thumb}${verQ(s.thumbVer[tf])}"
               ${alt ? `data-fallback="${rel}set/${s.slug}/thumbs/${alt}${verQ(s.thumbVer[alt])}"` : ''}
               alt="${esc(s.title)} 预览图 ${i + 1}" decoding="async">
        </a>
        ${olUrl ? `<a class="orig-link" href="${esc(olUrl)}" target="_blank" rel="noopener" title="在${esc(s.netdisk || 'OpenList')}打开原图（${size.w}×${size.h}）">原图 ↗</a>` : ''}
        <figcaption>${i + 1} / ${s.imageCount}</figcaption>
      </figure>`
      }).join('')}
    </div>
    ${s.imageCount > s.previews.length ? `<p class="more-hint">本套共 ${s.imageCount} 张${s.sizeText ? ` · 总大小 ${esc(s.sizeText)}` : ''}，以上为部分预览 · ${s.olDir ? `完整原图请到 <a href="${esc(s.olDir)}" target="_blank" rel="noopener">${esc(s.netdisk || 'OpenList')}</a> 查看` : (s.downloadUrl ? `完整图集请点上方下载按钮${s.netdisk ? `（${esc(s.netdisk)}）` : ''}` : '完整图集请下载压缩包')}</p>` : ''}`
    : '<p class="empty">暂无预览图</p>'
  // 加载进度提示：原来在预览区下面，现在提到预览区上方（原来「预览图（8 / 32）」标题的位置）
  const streamHint = s.previews.length
    ? `<p class="stream-hint top" id="streamHint">已加载 <span id="loadedCount">0</span> / ${s.previews.length} 张预览 · 滚动时自动加载 · <b>点击图片打开画廊</b>${s.olDir ? ' · 右上角「原图 ↗」直达原图' : ''}</p>`
    : ''

  // ── 右侧栏（参考同类站：下载 / 模特与系列 / 本套信息 / 热门标签）──
  const dlBtn = s.olDir
    ? `<a class="btn btn-primary side-dl" href="${esc(s.olDir)}" target="_blank" rel="noopener">⬇ 打开原图目录</a>`
    : (s.downloadUrl && !s.hasPack
      ? `<a class="btn btn-primary side-dl" href="${esc(s.downloadUrl)}" target="_blank" rel="noopener">⬇ 下载图集</a>`
      : (s.hasPack && !LITE
        ? `<a class="btn btn-primary side-dl" href="${rel}set/${s.slug}/pack.zip" download>⬇ 下载压缩包</a>`
        : (s.hasPack && LITE
          ? `<span class="btn btn-disabled side-dl">压缩包未随站点部署</span>`
          : `<span class="btn btn-disabled side-dl">⬇ 下载链接待补充</span>`)))
  const hasDlTarget = !!(s.olDir || s.downloadUrl || s.hasPack)
  const dlCodes = [
    hasDlTarget && s.netdisk ? `网盘：${esc(s.netdisk)}` : '',
    hasDlTarget && s.shareCode ? `提取码 <code>${esc(s.shareCode)}</code>` : '',
    hasDlTarget && s.password ? `解压密码 <code>${esc(s.password)}</code>` : '',
  ].filter(Boolean)
  const hotTags = Object.entries(tagCounts || {}).sort((a, b) => b[1].length - a[1].length).slice(0, 18)
  const sideBlock = `
  <aside class="detail-side">
    <section class="side-box">
      <h3 class="side-title">⬇ 下载这套图</h3>
      <div class="side-dl-wrap">${dlBtn}</div>
      ${dlCodes.length ? `<p class="side-note">${dlCodes.join(' · ')}</p>` : ''}
      ${s.imageCount > s.previews.length ? `<p class="side-note dim">本页展示前 ${s.previews.length} 张预览${hasDlTarget ? `，完整 ${s.imageCount} 张请点上方按钮` : `（共 ${s.imageCount} 张）`}</p>` : ''}
      ${!hasDlTarget && !PUBLIC ? `<p class="side-note dim">在后台「✎ 编辑这套图集」里填上网盘链接 / 提取码 / 解压密码，这里会自动变成下载按钮。</p>` : ''}
    </section>
    ${(s.model || s.series) ? `<section class="side-box">
      <h3 class="side-title">👤 模特与系列</h3>
      ${profileBlock
        ? `<p class="side-sub first">模特信息${s.model ? `<span class="dim"> · ${esc(s.model)}</span>` : ''}</p>${profileBlock}`
        : `<div class="side-links">
        ${s.model ? `<a class="side-link" href="${rel}index.html?q=${encodeURIComponent(s.model)}">${esc(s.model)} <span class="dim">的全部作品${modelTotal > 1 ? `（${modelTotal} 套）` : ''}</span></a>` : ''}
      </div>`}
      ${s.series ? `<div class="side-links"><a class="side-link" href="${rel}series/${encodeURIComponent(s.series)}.html">${esc(s.series)} <span class="dim">系列全部</span></a></div>` : ''}
      ${moreSets.length ? `<div class="side-sets">
        <p class="side-sub">${esc(s.model || s.series)} 的其他作品</p>
        ${moreSets.map(x => `<a class="side-set" href="${rel}set/${x.slug}/index.html" title="${esc(x.title)}">
          <span class="ss-cover">${x.coverFile
            ? `<img loading="lazy" src="${rel}set/${x.slug}/${x.coverThumb ? 'thumbs/' + x.coverThumb + verQ(x.thumbVer[x.coverThumb]) : x.coverFile}" alt="${esc(x.title)}">`
            : ''}</span>
          <span class="ss-body">
            <b>${esc(x.title)}</b>
            <span class="ss-meta">${esc(x.date)} · ${x.imageCount}P${x.sizeText ? ' · ' + esc(x.sizeText) : (x.packSize ? ' · ' + esc(x.packSize) : '')}</span>
          </span>
        </a>`).join('')}
        ${modelTotal > moreSets.length + 1 ? `<a class="side-more" href="${rel}index.html?q=${encodeURIComponent(s.model || '')}">查看全部 ${modelTotal} 套 →</a>` : ''}
      </div>` : ''}
    </section>` : ''}
    <section class="side-box">
      <h3 class="side-title">📋 本套信息</h3>
      <dl class="side-info">
        <dt>图片数量</dt><dd>${s.imageCount} 张</dd>
        ${s.resolution ? `<dt>图片像素</dt><dd>${esc(s.resolution)}</dd>` : ''}
        ${s.sizeText ? `<dt>总大小</dt><dd>${esc(s.sizeText)}<span class="dim"> · 单张约 ${esc(fmtSize(Math.round(s.bytes / Math.max(1, s.imageCount))))}</span></dd>` : ''}
        ${s.packSize ? `<dt>压缩包</dt><dd>${esc(s.packSize)}</dd>` : ''}
        ${s.netdisk || !hasDlTarget ? `<dt>${s.olDir ? '原图存放' : '下载方式'}</dt><dd>${hasDlTarget && s.netdisk ? esc(s.netdisk) : '<span class="dim">暂未提供下载</span>'}</dd>` : ''}
        <dt>发布时间</dt><dd>${esc(s.date)}</dd>
        ${s.password ? `<dt>解压密码</dt><dd><code>${esc(s.password)}</code></dd>` : ''}
      </dl>
    </section>
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
      ${s.model ? `<a class="tag tag-model" href="${rel}index.html?q=${encodeURIComponent(s.model)}" title="查看该模特全部图集">模特：${esc(s.model)}</a>` : ''}
      ${s.tags.map(t => `<a class="tag tag-link" href="${rel}tag/${encodeURIComponent(t)}.html" title="查看同标签图集">#${esc(t)}</a>`).join('')}
    </div>
    ${s.description ? `<p class="detail-desc">${esc(s.description)}</p>` : ''}
    ${streamHint}
    ${previews}
    <nav class="prevnext">
      ${prev ? `<a class="pn" href="${rel}set/${prev.slug}/index.html"><small>上一套</small><span>${esc(prev.title)}</span></a>` : '<span class="pn dim">已是第一套</span>'}
      ${next ? `<a class="pn" href="${rel}set/${next.slug}/index.html"><small>下一套</small><span>${esc(next.title)}</span></a>` : '<span class="pn dim">已是最后一套</span>'}
    </nav>
    ${related && related.length ? `<h2 class="sec-title">相关推荐</h2>
    <div class="grid related">${related.map(x => card(x, rel)).join('')}</div>` : ''}
  </article>
  ${sideBlock}
  </div>
  <div class="mobile-dl-bar"${hasDlTarget ? '' : ' hidden'}>${dlBtn}</div>`
  return layout({
    title: `${s.title} - ${config.siteName}`,
    desc: s.description || s.modelInfo || `${s.displayTitle}${s.tags.length ? ' · ' + s.tags.join('、') : ''}`,
    body, rel, pswp: true,
    canonical,
    og: {
      type: 'article',
      url: canonical,
      image: s.coverFile ? pageUrl(`set/${encodeURIComponent(s.slug)}/${s.coverThumb ? 'thumbs/' + s.coverThumb + verQ(s.thumbVer[s.coverThumb]) : s.coverFile}`) : '',
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
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;transition:transform .15s,border-color .15s}
.card:hover{transform:translateY(-3px);border-color:var(--accent)}
.card-cover{position:relative;aspect-ratio:3/4;background:var(--panel2);overflow:hidden}
.card-cover img{width:100%;height:100%;object-fit:cover}
.no-cover{display:flex;align-items:center;justify-content:center;height:100%;color:var(--dim)}
.badge{position:absolute;top:8px;left:8px;background:rgba(0,0,0,.65);color:#fff;font-size:12px;padding:2px 8px;border-radius:999px}
.badge-size{left:auto;right:8px;background:rgba(91,140,255,.85)}
.card-title{margin:0;padding:12px 12px 6px;font-size:14px;line-height:1.5;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:0 12px 12px;font-size:12px;color:var(--dim)}
/* 日期固定单独占一行右对齐：标签多少不一，若跟着标签排会出现"有的同行、有的换行" */
.card-meta time{flex:1 0 100%;margin:0;text-align:right}
.tag{padding:1px 8px;border-radius:999px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);font-size:12px;text-decoration:none;display:inline-block;transition:.15s}
.tag-series{color:var(--accent);border-color:rgba(91,140,255,.4)}
/* 详情页标题旁的体量标签（原图总大小）＋分类页「合计」强调 */
.tag-size{color:#4ec99a;border-color:rgba(78,201,154,.42);background:rgba(78,201,154,.10);cursor:default}
.size-strong{color:var(--fg);font-weight:600}
.card-meta a.tag:hover,.detail-meta a.tag:hover{color:var(--accent);border-color:var(--accent);background:rgba(91,140,255,.12)}
.pager{display:flex;align-items:center;justify-content:center;gap:18px;margin:34px 0}
/* 筛选栏 */
.filters{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 16px}
.filters select{padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--fg);font:inherit;cursor:pointer}
.filter-chips{display:flex;gap:6px;flex-wrap:wrap}
.filter-chips button{font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--dim);cursor:pointer}
.filter-chips button:hover{color:var(--fg);border-color:var(--accent)}
.filter-chips button.on{background:rgba(91,140,255,.18);border-color:var(--accent);color:var(--fg)}
/* 回到顶部 */
.to-top{position:fixed;right:22px;bottom:26px;width:44px;height:44px;border-radius:50%;border:1px solid var(--line);
  background:var(--panel);color:var(--fg);font-size:18px;cursor:pointer;z-index:30;box-shadow:0 8px 24px rgba(0,0,0,.4)}
.to-top:hover{border-color:var(--accent)}
.pager a{padding:8px 16px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
.pager a:hover{border-color:var(--accent)}
.dim{color:var(--dim)}
.empty{text-align:center;color:var(--dim);padding:40px 0}
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
.detail-side{flex:0 0 316px;width:316px;position:sticky;top:80px;max-height:calc(100vh - 96px);overflow-y:auto;
  scrollbar-width:thin;scrollbar-color:var(--line) transparent;padding-right:2px}
.detail-side::-webkit-scrollbar{width:6px}
.detail-side::-webkit-scrollbar-thumb{background:var(--line);border-radius:3px}
.detail-side::-webkit-scrollbar-track{background:transparent}
.detail-side.side-tall{position:static;max-height:none;overflow:visible}
.side-box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:14px}
.side-title{margin:0 0 10px;font-size:14px;font-weight:600;color:var(--accent2)}
.side-dl-wrap{margin:0 0 8px}
/* 侧栏：模特的其他作品（缩略图 + 标题 + 日期/张数） */
.side-sub{margin:12px 0 8px;font-size:12px;color:var(--dim);border-top:1px solid var(--line);padding-top:10px}
.side-sub.first{margin-top:0;border-top:0;padding-top:0}
/* 侧栏里的模特资料引文（原正文顶部的那段，搬进侧栏后收紧排版）
   用 .pf-quote.side-quote 提高权重，否则会被后面的 .pf-quote 覆盖 */
.pf-quote.side-quote{margin:0 0 4px;padding:8px 0 8px 11px;font-size:12.5px;line-height:1.9;
  border-left:3px solid var(--accent2);background:linear-gradient(90deg,rgba(255,180,84,.10),transparent 70%)}
/* 亮色主题下 .pf-quote 有自己的背景规则，权重更高，这里单独再盖一次 */
html[data-theme="light"] .pf-quote.side-quote{background:linear-gradient(90deg,rgba(255,180,84,.16),transparent 70%)}
.pf-quote.side-quote p{margin:0}
.pf-quote.side-quote p + p{margin-top:5px}
.side-sets{display:flex;flex-direction:column;gap:4px}
.side-set{display:flex;gap:9px;align-items:center;padding:5px 6px;border-radius:9px;text-decoration:none;color:inherit;transition:background .15s}
.side-set:hover{background:var(--panel2)}
.ss-cover{flex:0 0 52px;width:52px;height:69px;border-radius:7px;overflow:hidden;background:var(--panel2)}
.ss-cover img{width:100%;height:100%;object-fit:cover;display:block}
.ss-body{min-width:0;display:flex;flex-direction:column;gap:3px}
.ss-body b{font-size:13px;line-height:1.4;font-weight:600;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ss-meta{font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.side-more{display:block;margin-top:8px;font-size:12.5px;color:var(--accent);text-decoration:none}
.side-more:hover{text-decoration:underline}
.side-box .btn{width:100%;justify-content:center;display:flex}
.side-note{margin:8px 0 0;font-size:12px;line-height:1.7;color:var(--dim)}
.side-note code{background:var(--panel2);padding:1px 6px;border-radius:5px;color:var(--fg)}
.side-links{display:flex;flex-direction:column;gap:8px}
.side-link{display:block;padding:8px 12px;border-radius:8px;background:var(--panel2);border:1px solid var(--line);
  color:var(--fg);text-decoration:none;font-size:13px;transition:.15s}
.side-link:hover{border-color:var(--accent);color:var(--accent)}
.side-info{margin:0;display:grid;grid-template-columns:auto 1fr;gap:7px 12px;font-size:13px}
.side-info dt{color:var(--dim);white-space:nowrap}
.side-info dd{margin:0;word-break:break-word}
.side-info code{background:var(--panel2);padding:1px 6px;border-radius:5px}
.side-tags{display:flex;flex-wrap:wrap;gap:6px}
.side-tag{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;background:var(--panel2);
  border:1px solid var(--line);color:var(--dim);font-size:12px;text-decoration:none;transition:.15s}
.side-tag span{font-size:11px;opacity:.7}
.side-tag:hover{color:var(--accent);border-color:var(--accent)}
/* 窄屏：单栏 + 底部固定下载条（参考同类站的做法） */
.mobile-dl-bar{display:none}
.mobile-dl-bar[hidden]{display:none}
@media (max-width:1000px){
  .detail-layout{flex-direction:column;gap:18px}
  .detail-side{position:static;width:100%;flex:none;max-height:none;overflow:visible}
  body:has(.mobile-dl-bar:not([hidden])) .side-box:first-child{display:none}  /* 下载已在底部固定条里 */
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

  // ── 随便看看：从索引随机跳一套 ──
  const randBtn = document.getElementById('randomBtn');
  if (randBtn) {
    const base = (location.pathname.includes('/set/') || location.pathname.includes('/series/') || location.pathname.includes('/tag/') || location.pathname.includes('/page/')) ? '../../' : '';
    randBtn.addEventListener('click', () => {
      fetch(base + 'search-index.json').then(r => r.json()).then(d => {
        const s = d.sets[Math.floor(Math.random() * d.sets.length)];
        if (s) location.href = base + 'set/' + encodeURIComponent(s.slug) + '/index.html';
      }).catch(() => {});
    });
  }

  ${ADMIN_JS}
  // ── 列表页：全站搜索/筛选（读 search-index.json，跨分页生效）──
  const grid = document.getElementById('grid');
  const input = document.getElementById('q');
  const empty = document.getElementById('empty');
  const total = document.getElementById('set-total');
  if (grid) {
    const base = location.pathname.includes('/page/') ? '../../' : '';
    let INDEX = null;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const cardHtml = (s) => [
      '<article class="card">',
      '<a class="card-link" href="' + base + 'set/' + encodeURIComponent(s.slug) + '/index.html">',
      '<div class="card-cover">',
      (s.cover ? '<img loading="lazy" src="' + base + s.cover + '" alt="' + esc(s.title) + '">' : '<div class="no-cover">无封面</div>'),
      '<span class="badge">' + s.imageCount + 'P</span>',
      (s.size || s.packSize ? '<span class="badge badge-size">' + esc(s.size || s.packSize) + '</span>' : ''),
      '</div>',
      '<h2 class="card-title">' + esc(s.title) + '</h2>',
      '</a>',
      '<div class="card-meta">',
      (s.series ? '<a class="tag tag-series" href="' + base + 'series/' + encodeURIComponent(s.series) + '.html">' + esc(s.series) + '</a>' : ''),
      (s.tags || []).slice(0, 2).map(t => '<a class="tag tag-link" href="' + base + 'tag/' + encodeURIComponent(t) + '.html">' + esc(t) + '</a>').join(''),
      '<time>' + esc(s.date) + '</time>',
      '</div></article>',
    ].join('');
    const hits = (s, q) => {
      if (!q) return true;
      const hay = [s.title, s.series, s.model, (s.tags || []).join(' '), s.date].join(' ').toLowerCase();
      return q.split(/\\s+/).filter(Boolean).every(part => hay.includes(part));
    };
    fetch(base + 'search-index.json').then(r => r.ok ? r.json() : null).then(d => {
      if (!d) return;
      INDEX = d;
      if (total) total.textContent = d.count;
      const params = new URLSearchParams(location.search);
      const q0 = (params.get('q') || '').trim();
      if (q0 && input) input.value = q0;
      if (q0) renderList(q0.toLowerCase());
      if (input) {
        let t = null;
        input.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(() => {
            const q = input.value.trim().toLowerCase();
            renderList(q);
            const url = q ? (base + 'index.html?q=' + encodeURIComponent(input.value.trim())) : (base + 'index.html');
            history.replaceState(null, '', url);
          }, 180);
        });
      }
      // 排序 + 快捷筛选（系列/模特）+ 回到顶部
      const sortSel = document.getElementById('sortSel');
      const chips = document.getElementById('filterChips');
      const applySort = (list) => {
        const v = sortSel ? sortSel.value : 'date-desc';
        const arr = list.slice();
        if (v === 'date-desc') arr.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        else if (v === 'date-asc') arr.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        else if (v === 'count-desc') arr.sort((a, b) => (b.imageCount || 0) - (a.imageCount || 0));
        else if (v === 'title-asc') arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'));
        return arr;
      };
      const renderList = (q) => {
        const list = applySort(INDEX.sets.filter(s => hits(s, q)));
        grid.innerHTML = list.map(cardHtml).join('');
        const head = document.querySelector('.page-head');
        if (head) {
          head.innerHTML = '<h1>' + (q ? '搜索结果' : '最新图集') + '</h1><p class="sub">'
            + (q ? '匹配「' + esc(q) + '」共 ' + list.length + ' 套 · <a href="' + base + 'index.html" class="dim">清除筛选</a>'
                 : '共 ' + INDEX.count + ' 套') + '</p>';
        }
        const pager = document.querySelector('.pager');
        if (pager) pager.hidden = !!q;
        if (empty) empty.hidden = list.length !== 0;
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
        chips.innerHTML = top(seriesCount).map(([k, n]) => mk(k + ' ' + n, k)).join('')
          + top(modelCount).map(([k, n]) => mk('👤 ' + k + ' ' + n, k)).join('');
        chips.querySelectorAll('button[data-q]').forEach(b => b.addEventListener('click', () => {
          const q = b.dataset.q;
          chips.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
          if (input) input.value = q;
          renderList(q.toLowerCase());
          history.replaceState(null, '', base + 'index.html?q=' + encodeURIComponent(q));
        }));
      }
      if (sortSel) sortSel.addEventListener('change', () => {
        const q = (document.getElementById('q')?.value || '').trim().toLowerCase();
        renderList(q);
      });
      const toTop = document.getElementById('toTop');
      if (toTop) {
        window.addEventListener('scroll', () => { toTop.hidden = window.scrollY < 600; }, { passive: true });
        toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
      }
    }).catch(() => {});
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

    const layout = () => {
      W = gallery.clientWidth || gallery.parentElement.clientWidth;
      if (!items.length || !W) return;
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
    };

    // 图片加载：懒加载 + WebP 失败回退 JPG；只负责显示，不再改变落位（避免布局抖动）
    let loadedN = 0;
    const loadOne = (el) => {
      if (el.dataset.done) return;
      el.dataset.done = '1';
      const img = el.querySelector('img');
      let tried = 0, counted = false;
      const done = () => {
        img.classList.add('loaded');
        if (!counted) { counted = true; loadedN++; if (loadedCount) loadedCount.textContent = loadedN; }
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

    layout();

    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(e => { if (e.isIntersecting) { loadOne(e.target); io.unobserve(e.target); } });
      }, { rootMargin: '500px 0px' });
      items.forEach(el => io.observe(el));
    } else {
      items.forEach(loadOne);
    }

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

  // 详情页侧栏：内容比屏幕高时不再吸顶（避免嵌套滚动条），跟着页面一起滚
  const sideEl = document.querySelector('.detail-side');
  if (sideEl) {
    const fitSide = () => sideEl.classList.toggle('side-tall', sideEl.scrollHeight > window.innerHeight - 120);
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
  const sets = slugs.map(readSet).filter(Boolean).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
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
    const html = listPage(pageSets, p, totalPages, rel, sets.length, sets)
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
  sets.forEach((s, i) => {
    const outDir = join(DIST, 'set', s.slug)
    mkdirSync(outDir, { recursive: true })
    const related = relatedSets(s, sets)
    // 模特的其他作品（侧栏推荐）：同系列优先，再按日期倒序，取 5 套
    const sameModel = s.model ? sets.filter(x => x.model === s.model && x.slug !== s.slug) : []
    const moreSets = sameModel.slice().sort((a, b) => {
      const sa = (s.series && a.series === s.series) ? 0 : 1
      const sb = (s.series && b.series === s.series) ? 0 : 1
      return sa - sb || String(b.date || '').localeCompare(String(a.date || ''))
    }).slice(0, config.modelSideCount || 5)
    writeFileSync(join(outDir, 'index.html'), detailPage(s, sets[i - 1], sets[i + 1], pageUrl(`set/${encodeURIComponent(s.slug)}/`), related, byTag, moreSets, sameModel.length + 1))

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
      const keep = new Set([...s.thumbs, ...Object.values(s.thumbAlt || {}), s.coverThumb].filter(Boolean))
      mkdirSync(thumbOut, { recursive: true })
      keep.forEach(f => copyFileSync(join(s.dir, 'thumbs', f), join(thumbOut, f)))
      deployedThumbCount += keep.size
    }

    // 封面
    if (s.coverFile) copyFileSync(join(s.dir, s.coverFile), join(outDir, s.coverFile))
  })

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
  // 系列/标签索引页
  writeFileSync(join(DIST, 'collections.html'), layout({
    title: `全部系列与标签 - ${config.siteName}`,
    desc: `${config.siteName} 的系列与标签索引`,
    rel: '',
    body: `<div class="page-head"><h1>系列与标签</h1><p class="sub">共 ${Object.keys(bySeries).length} 个系列 · ${Object.keys(byTag).length} 个标签</p></div>
      <h2 class="sec-title" id="series">系列</h2>
      <div class="chips-cloud">${Object.entries(bySeries).sort((a, b) => b[1].length - a[1].length).map(([n, l]) => `<a class="cloud-chip" href="series/${encodeURIComponent(n)}.html">${esc(n)}<span>${l.length}</span></a>`).join('') || '<span class="dim">暂无</span>'}</div>
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
  writeFileSync(join(DIST, 'search-index.json'), JSON.stringify({
    count: sets.length,
    generatedAt: new Date().toISOString(),
    sets: sets.map(s => ({
      slug: s.slug, title: s.title, displayTitle: s.displayTitle,
      series: s.series, model: s.model, date: s.date, tags: s.tags,
      imageCount: s.imageCount, packSize: s.packSize, size: s.sizeText, bytes: s.bytes,
      cover: s.coverThumb ? `set/${s.slug}/thumbs/${s.coverThumb}${verQ(s.thumbVer[s.coverThumb])}` : (s.coverFile ? `set/${s.slug}/${s.coverFile}` : ''),
    })),
  }, null, 2))
  writeFileSync(join(DIST, '.nojekyll'), '')

  // ── SEO：robots.txt / sitemap.xml / RSS ──
  const base = (config.baseUrl || '').replace(/\/+$/, '')
  writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${base ? base + '/' : ''}sitemap.xml\n`)
  const urls = [
    { loc: pageUrl('index.html'), lastmod: sets[0]?.date || '', pri: '1.0' },
    { loc: pageUrl('collections.html'), lastmod: sets[0]?.date || '', pri: '0.6' },
    { loc: pageUrl('about.html'), lastmod: '', pri: '0.3' },
    ...(config.privacy ? [{ loc: pageUrl('privacy.html'), lastmod: '', pri: '0.3' }] : []),
    ...sets.map(s => ({ loc: pageUrl(`set/${encodeURIComponent(s.slug)}/index.html`), lastmod: s.date, pri: '0.8' })),
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
    + sets.slice(0, 30).map(s => `  <item>\n    <title>${esc(s.title)}</title>\n    <link>${esc(pageUrl(`set/${encodeURIComponent(s.slug)}/index.html`))}</link>\n    <guid>${esc(pageUrl(`set/${encodeURIComponent(s.slug)}/index.html`))}</guid>\n    <pubDate>${rssDate(s.date)}</pubDate>\n    <description>${esc(s.description || s.tags.join('、'))}</description>\n  </item>`).join('\n')
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
