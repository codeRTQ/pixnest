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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, openSync, readSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SETS_DIR = join(ROOT, 'sets')
const DIST = join(ROOT, 'dist')

// ─────────────────────────── 配置 ───────────────────────────
const defaultConfig = {
  siteName: '图集站',
  siteSubtitle: '高质量写真图集 · 定期更新',
  baseUrl: '',
  setsPerPage: 12,
  previewCount: 8,
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
  // 每张原图用哪个缩略图文件：优先 .webp（体积约为 jpg 的一半），没有才退回 .jpg
  const thumbFor = {}
  for (const f of images) {
    const webp = f.replace(/\.[^.]+$/, '.webp')
    if (thumbSet.has(webp)) thumbFor[f] = webp
    else if (thumbSet.has(f)) thumbFor[f] = f
  }
  const thumbs = Object.values(thumbFor)
  const coverThumb = ['cover.webp', 'cover.jpg', 'cover.jpeg', 'cover.png'].find(f => existsSync(join(dir, 'thumbs', f)))
  const lqip = {}
  for (const f of images) {
    const p = join(dir, 'thumbs', f.replace(/\.[^.]+$/, '.lqip.jpg'))
    if (existsSync(p)) lqip[f] = 'data:image/jpeg;base64,' + readFileSync(p).toString('base64')
  }

  const date = meta.date || new Date(statSync(metaPath).mtime).toISOString().slice(0, 10)
  const series = meta.series || ''
  const model = meta.model || ''
  const rawTitle = meta.title || slug
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
    netdisk: meta.netdisk || '',
    downloadUrl: meta.downloadUrl || (hasPack ? `pack.zip` : ''),
    resolution: meta.resolution || '',
    imageCount: meta.imageCount || images.length,
    packSize: meta.packSize || (hasPack ? fmtSize(statSync(packPath).size) : ''),
    hasPack,
    packPath: hasPack ? packPath : null,
    coverFile,
    coverThumb,
    images,
    thumbs,
    thumbFor,
    hasThumbs,
    lqip,
    modelInfo: meta.modelInfo || '',
    profile: meta.profile || null,
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

/** 计算某套图集的相关推荐（同系列 > 同模特 > 共享标签多者优先） */
function relatedSets(set, all, limit = 6) {
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
function collectionPage(kind, name, sets, all, rel = '../') {
  const label = kind === 'series' ? '系列' : '标签'
  const body = `
  <nav class="breadcrumb"><a href="${rel}index.html">首页</a><span>/</span><span>${label}</span><span>/</span><span class="cur">${esc(name)}</span></nav>
  <div class="page-head">
    <h1>${esc(name)}</h1>
    <p class="sub">${label}「${esc(name)}」共 ${sets.length} 套图集</p>
  </div>
  <div class="grid">${sets.map(s => card(s, rel)).join('')}</div>
  <p class="more-hint"><a href="${rel}index.html" class="dim">← 返回全部图集</a></p>`
  const url = pageUrl(`${kind === 'series' ? 'series' : 'tag'}/${encodeURIComponent(name)}.html`)
  return layout({
    title: `${name} · ${label} - ${config.siteName}`,
    desc: `${label}「${name}」下的全部图集，共 ${sets.length} 套。${config.siteSubtitle}`,
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
        ? `<img loading="lazy" src="${rel}set/${s.slug}/${s.coverThumb ? 'thumbs/' + s.coverThumb : s.coverFile}" alt="${esc(s.title)}">`
        : `<div class="no-cover">无封面</div>`}
      <span class="badge">${s.imageCount}P</span>
      ${s.packSize ? `<span class="badge badge-size">${esc(s.packSize)}</span>` : ''}
    </div>
    <h2 class="card-title">${esc(s.title)}</h2>
  </a>
  <div class="card-meta">
    ${s.series ? `<span class="tag tag-series">${esc(s.series)}</span>` : ''}
    ${s.tags.slice(0, 2).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
    <time datetime="${esc(s.date)}">${esc(s.date)}</time>
  </div>
</article>`

function listPage(sets, page, totalPages, rel = '') {
  const body = `
  <div class="page-head">
    <h1>最新图集</h1>
    <p class="sub">共 ${sets.length} 套</p>
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

function detailPage(s, prev, next, canonical = '', related = []) {
  const rel = '../../'
  // 模特资料：仅展示填写过的字段（AI 不会生成这些）
  const pf = s.profile || {}
  const pfLabels = { age: '年龄', height: '身高', weight: '体重', measure: '三围', shoes: '鞋码', other: '其他' }
  const pfItems = Object.keys(pfLabels).filter(k => pf[k]).map(k => `<div><dt>${pfLabels[k]}</dt><dd>${esc(pf[k])}</dd></div>`)
  const profileBlock = pfItems.length
    ? `<section class="profile"><h3 class="pf-title">模特资料</h3><dl class="pf-list">${pfItems.join('')}</dl></section>`
    : ''
  const downloadBlock = `
  <section class="download">
    <div class="dl-main">
      ${s.olDir
        ? `<a class="btn btn-primary" href="${esc(s.olDir)}" target="_blank" rel="noopener">⬇ 打开原图目录（${esc(s.netdisk || 'OpenList')}）</a>`
        : (s.downloadUrl && !s.hasPack
          ? `<a class="btn btn-primary" href="${esc(s.downloadUrl)}" target="_blank" rel="noopener">⬇ 图集下载 Download${s.netdisk ? `（${esc(s.netdisk)}）` : ''}</a>`
          : (s.hasPack && !LITE
            ? `<a class="btn btn-primary" href="${rel}set/${s.slug}/pack.zip" download>⬇ 下载图集压缩包（${esc(s.packSize)}）</a>`
            : (s.hasPack && LITE
              ? `<span class="btn btn-disabled">压缩包未随站点部署（请用网盘链接）</span>`
              : `<span class="btn btn-disabled">暂无下载</span>`)))}
      ${s.olDir && s.password ? `<span class="dl-hint">目录密码：<code>${esc(s.password)}</code></span>` : ''}
    </div>
    <dl class="dl-info">
      ${s.password ? `<div><dt>解压密码</dt><dd><code>${esc(s.password)}</code></dd></div>` : ''}
      ${s.netdisk ? `<div><dt>${s.olDir ? '原图存放' : '下载网盘'}</dt><dd>${esc(s.netdisk)}</dd></div>` : ''}
      ${s.resolution ? `<div><dt>图片像素</dt><dd>${esc(s.resolution)}</dd></div>` : ''}
      <div><dt>图片数量</dt><dd>${s.imageCount} 张</dd></div>
      ${s.packSize ? `<div><dt>压缩包大小</dt><dd>${esc(s.packSize)}</dd></div>` : ''}
      <div><dt>发布时间</dt><dd>${esc(s.date)}</dd></div>
    </dl>
  </section>`

  const previews = s.previews.length
    ? `<div class="previews" id="gallery">
      ${s.previews.map((f, i) => {
        // 缩略图文件：优先 webp（体积约为 jpg 一半），没有才用 jpg；构建时只会部署这一个
        const tf = s.thumbFor[f] || f
        const thumb = s.hasThumbs ? `thumbs/${tf}` : `images/${f}`
        const ph = s.lqip[f] ? `src="${s.lqip[f]}"` : ''
        const size = s.sizes[f] || { w: 1200, h: 1600 }
        // 精简模式：原图未随站点部署，画廊大图用缩略图，并标注像素
        const bigSrc = LITE
          ? `${rel}set/${s.slug}/${thumb}`
          : `${rel}set/${s.slug}/images/${f}`
        const bigW = LITE ? Math.min(size.w, 1080) : size.w
        const bigH = LITE ? Math.round(bigW / (size.w / size.h)) : size.h
        // 原图直链：本地 01.jpg ↔ 网盘 00001.jpg（按序号映射）
        const fi = fileIndex(f)
        const olUrl = (s.olDir && fi) ? olFileUrl(s, olFileName(fi)) : ''
        return `<figure class="preview" data-ratio="${(size.w / size.h).toFixed(4)}">
        <a class="preview-link" href="${bigSrc}"
           data-pswp-width="${bigW}" data-pswp-height="${bigH}"
           data-pswp-srcset="${rel}set/${s.slug}/${thumb} 1080w"
           data-orig-w="${size.w}" data-orig-h="${size.h}"
           target="_blank" rel="noopener">
          <img class="ph" ${ph} data-src="${rel}set/${s.slug}/${thumb}"
               alt="${esc(s.title)} 预览图 ${i + 1}" decoding="async">
        </a>
        ${olUrl ? `<a class="orig-link" href="${esc(olUrl)}" target="_blank" rel="noopener" title="在${esc(s.netdisk || 'OpenList')}打开原图（${size.w}×${size.h}）">原图 ↗</a>` : ''}
        <figcaption>${i + 1} / ${s.imageCount}</figcaption>
      </figure>`
      }).join('')}
    </div>
    <p class="stream-hint" id="streamHint">已加载 <span id="loadedCount">0</span> / ${s.previews.length} 张预览 · 滚动时自动加载 · <b>点击图片打开画廊</b>${s.olDir ? ` · 右上角「原图 ↗」直达原图` : ''}</p>
    ${s.imageCount > s.previews.length ? `<p class="more-hint">本套共 ${s.imageCount} 张，以上为部分预览 · ${s.olDir ? `完整原图请到 <a href="${esc(s.olDir)}" target="_blank" rel="noopener">${esc(s.netdisk || 'OpenList')}</a> 查看` : (s.downloadUrl ? `完整图集请点上方下载按钮${s.netdisk ? `（${esc(s.netdisk)}）` : ''}` : '完整图集请下载压缩包')}</p>` : ''}`
    : '<p class="empty">暂无预览图</p>'

  const body = `
  ${PUBLIC ? '' : `<div class="admin-bar" id="adminBar" hidden>
    <a class="btn btn-primary sm" href="http://127.0.0.1:8091/edit?slug=${encodeURIComponent(s.slug)}">✎ 编辑这套图集</a>
    <a class="btn ghost sm" href="http://127.0.0.1:8091/">管理后台</a>
    <span class="dim">（仅带 ?admin=1 时显示 · 访客看不到）</span>
  </div>`}
  <nav class="breadcrumb"><a href="${rel}index.html">首页</a><span>/</span><span class="cur">${esc(s.title)}</span></nav>
  <article class="detail">
    <h1 class="detail-title">${esc(s.title)}</h1>
    <div class="detail-meta">
      ${s.series ? `<a class="tag tag-series" href="${rel}series/${encodeURIComponent(s.series)}.html" title="查看该系列全部图集">${esc(s.series)}</a>` : ''}
      ${s.model ? `<a class="tag tag-model" href="${rel}index.html?q=${encodeURIComponent(s.model)}" title="查看该模特全部图集">模特：${esc(s.model)}</a>` : ''}
      ${s.tags.map(t => `<a class="tag tag-link" href="${rel}tag/${encodeURIComponent(t)}.html" title="查看同标签图集">#${esc(t)}</a>`).join('')}
    </div>
    ${profileBlock}
    ${s.description ? `<p class="detail-desc">${esc(s.description)}</p>` : ''}
    ${downloadBlock}
    <h2 class="sec-title">预览图<span class="dim">（${s.previews.length} / ${s.imageCount}）</span></h2>
    ${previews}
    <nav class="prevnext">
      ${prev ? `<a class="pn" href="${rel}set/${prev.slug}/index.html"><small>上一套</small><span>${esc(prev.title)}</span></a>` : '<span class="pn dim">已是第一套</span>'}
      ${next ? `<a class="pn" href="${rel}set/${next.slug}/index.html"><small>下一套</small><span>${esc(next.title)}</span></a>` : '<span class="pn dim">已是最后一套</span>'}
    </nav>
    ${related && related.length ? `<h2 class="sec-title">相关推荐</h2>
    <div class="grid related">${related.map(x => card(x, rel)).join('')}</div>` : ''}
  </article>`
  return layout({
    title: `${s.title} - ${config.siteName}`,
    desc: s.description || s.modelInfo || `${s.displayTitle}${s.tags.length ? ' · ' + s.tags.join('、') : ''}`,
    body, rel, pswp: true,
    canonical,
    og: {
      type: 'article',
      url: canonical,
      image: s.coverFile ? pageUrl(`set/${encodeURIComponent(s.slug)}/${s.coverThumb ? 'thumbs/' + s.coverThumb : s.coverFile}`) : '',
    },
    jsonld: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'ImageGallery',
      name: s.title,
      description: s.description || undefined,
      datePublished: s.date,
      image: s.coverFile ? pageUrl(`set/${encodeURIComponent(s.slug)}/${s.coverThumb ? 'thumbs/' + s.coverThumb : s.coverFile}`) : undefined,
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
.grid.related{grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}
.grid.related .card-title{font-size:13px}
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
.card-meta time{margin-left:auto}
.tag{padding:1px 8px;border-radius:999px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);font-size:12px}
.tag-series{color:var(--accent);border-color:rgba(91,140,255,.4)}
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
.tag-link{text-decoration:none;transition:.15s}
.tag-link:hover{color:var(--accent);border-color:var(--accent);background:rgba(91,140,255,.12)}
.tag-model{color:var(--accent2);border-color:rgba(255,180,84,.4)}
.model-info{display:flex;gap:10px;align-items:flex-start;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent2);border-radius:10px;padding:12px 14px;margin:0 0 18px;font-size:13.5px;line-height:1.7}
.mi-label{flex:0 0 auto;color:var(--accent2);font-weight:600}
.profile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 18px}
.pf-title{margin:0 0 10px;font-size:14px;color:var(--accent2);font-weight:600}
.pf-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:0}
.pf-list div{background:var(--panel2);border-radius:8px;padding:8px 12px}
.pf-list dt{color:var(--dim);font-size:12px}
.pf-list dd{margin:2px 0 0;font-weight:600;font-size:15px}
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
      (s.packSize ? '<span class="badge badge-size">' + esc(s.packSize) + '</span>' : ''),
      '</div>',
      '<h2 class="card-title">' + esc(s.title) + '</h2>',
      '</a>',
      '<div class="card-meta">',
      (s.series ? '<span class="tag tag-series">' + esc(s.series) + '</span>' : ''),
      (s.tags || []).slice(0, 2).map(t => '<span class="tag">' + esc(t) + '</span>').join(''),
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

  // 详情页：瀑布流
  // 关键点：宽高比在构建时就写进 data-ratio，图片没加载也能算出最终高度 →
  // 一次性把所有格子排完（与加载顺序无关），图片只负责淡入。
  // 这样每次刷新的布局完全一致，也不会出现空洞 / 错行 / 高度乱跳。
  const gallery = document.getElementById('gallery');
  const loadedCount = document.getElementById('loadedCount');
  if (gallery) {
    const GAP = 16;
    const MIN_COL = 300;          // 单列最小宽度（决定列数）
    const items = [...gallery.querySelectorAll('.preview')];
    let cols = 1, colW = 0;

    const metrics = () => {
      const W = gallery.clientWidth || gallery.parentElement.clientWidth;
      cols = Math.max(1, Math.min(4, Math.floor((W + GAP) / (MIN_COL + GAP))));
      colW = (W - GAP * (cols - 1)) / cols;
    };

    // 按 DOM 顺序一次排完：短列优先；横构图尝试跨双列（跨列会留长条空隙时退回单列）
    const layout = () => {
      metrics();
      const hh = new Array(cols).fill(0);
      items.forEach(el => {
        const ratio = parseFloat(el.dataset.ratio) || 0.75;
        let span = (cols >= 2 && ratio >= 1.25) ? 2 : 1;
        let col = 0, y = Infinity;
        if (span === 2) {
          for (let c = 0; c + 1 < cols; c++) {
            const yy = Math.max(hh[c], hh[c + 1]);
            if (yy < y) { y = yy; col = c; }
          }
          const single = Math.min(...hh);
          if (y - single > 140) { span = 1; }   // 退回单列，避免跨列下方留长条空隙
        }
        if (span === 1) {
          y = Math.min(...hh);
          col = hh.indexOf(y);
        }
        const w = colW * span + GAP * (span - 1);
        const h = Math.round(w / ratio);
        el.style.width = w + 'px';
        el.style.height = h + 'px';
        el.style.transform = 'translate(' + (col * (colW + GAP)) + 'px, ' + y + 'px)';
        el.classList.add('placed');
        for (let i = col; i < col + span && i < cols; i++) hh[i] = y + h + GAP;
      });
      const total = hh.length ? Math.max(...hh) : 0;
      gallery.style.height = Math.max(0, total - GAP) + 'px';
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
function build() {
  if (!existsSync(SETS_DIR)) { console.error('× 找不到 sets/ 目录'); process.exit(1) }
  rmSync(DIST, { recursive: true, force: true })
  mkdirSync(join(DIST, 'assets'), { recursive: true })
  ASSET_V = createHash('sha1').update(STYLE + APP).digest('hex').slice(0, 8)
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

  // 列表页分页
  const per = config.setsPerPage
  const totalPages = Math.max(1, Math.ceil(sets.length / per))
  for (let p = 1; p <= totalPages; p++) {
    const pageSets = sets.slice((p - 1) * per, p * per)
    const rel = p === 1 ? '' : '../../'
    const html = listPage(pageSets, p, totalPages, rel)
    if (p === 1) writeFileSync(join(DIST, 'index.html'), html)
    else { mkdirSync(join(DIST, 'page'), { recursive: true }); writeFileSync(join(DIST, `page/${p}.html`), html) }
  }

  // 详情页 + 资源
  let deployedThumbCount = 0
  sets.forEach((s, i) => {
    const outDir = join(DIST, 'set', s.slug)
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'index.html'), detailPage(s, sets[i - 1], sets[i + 1], pageUrl(`set/${encodeURIComponent(s.slug)}/`), relatedSets(s, sets)))

    // 预览图（原图；精简模式下不复制，改用缩略图作为大图）
    const imgOut = join(outDir, 'images')
    if (!LITE) {
      mkdirSync(imgOut, { recursive: true })
      s.images.forEach(f => copyFileSync(join(s.dir, 'images', f), join(imgOut, f)))
    }
    // 压缩包（精简模式下不复制，依赖网盘外链）
    if (s.hasPack && !LITE) copyFileSync(s.packPath, join(outDir, 'pack.zip'))

    // 缩略图：只复制"页面上真正会被显示"的那些
    // 线上站每套只展示 previewCount 张预览 + 封面，其余缩略图永远不会被访客请求
    // → 不复制可把每套文件数从 ~44 降到 ~11（Cloudflare Pages 免费额度是每站点 2 万文件）
    if (s.hasThumbs) {
      const thumbOut = join(outDir, 'thumbs')
      const keep = (LITE && config.deployThumbs !== 'all')
        ? new Set([...s.previews.map(f => s.thumbFor[f]).filter(Boolean), s.coverThumb].filter(Boolean))
        : new Set([...s.thumbs, s.coverThumb].filter(Boolean))
      mkdirSync(thumbOut, { recursive: true })
      keep.forEach(f => copyFileSync(join(s.dir, 'thumbs', f), join(thumbOut, f)))
      deployedThumbCount += keep.size
    }

    // 封面
    if (s.coverFile) copyFileSync(join(s.dir, s.coverFile), join(outDir, s.coverFile))
  })

  // ── 系列页 / 标签页（静态化，SEO 友好）──
  const bySeries = {}, byTag = {}
  sets.forEach(s => {
    if (s.series) (bySeries[s.series] = bySeries[s.series] || []).push(s)
    s.tags.forEach(t => (byTag[t] = byTag[t] || []).push(s))
  })
  mkdirSync(join(DIST, 'series'), { recursive: true })
  mkdirSync(join(DIST, 'tag'), { recursive: true })
  for (const [name, list] of Object.entries(bySeries)) {
    writeFileSync(join(DIST, 'series', `${name}.html`), collectionPage('series', name, list, sets))
  }
  for (const [name, list] of Object.entries(byTag)) {
    writeFileSync(join(DIST, 'tag', `${name}.html`), collectionPage('tag', name, list, sets))
  }
  // 系列/标签索引页
  writeFileSync(join(DIST, 'collections.html'), layout({
    title: `全部系列与标签 - ${config.siteName}`,
    desc: `${config.siteName} 的系列与标签索引`,
    rel: '',
    body: `<div class="page-head"><h1>系列与标签</h1><p class="sub">共 ${Object.keys(bySeries).length} 个系列 · ${Object.keys(byTag).length} 个标签</p></div>
      <h2 class="sec-title">系列</h2>
      <div class="chips-cloud">${Object.entries(bySeries).sort((a, b) => b[1].length - a[1].length).map(([n, l]) => `<a class="cloud-chip" href="series/${encodeURIComponent(n)}.html">${esc(n)}<span>${l.length}</span></a>`).join('') || '<span class="dim">暂无</span>'}</div>
      <h2 class="sec-title">标签</h2>
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

  // 资源与索引
  writeFileSync(join(DIST, 'assets', 'style.css'), STYLE)
  writeFileSync(join(DIST, 'assets', 'app.js'), APP)
  writeFileSync(join(DIST, 'assets', 'photoswipe-extra.css'), PSWP_EXTRA)
  // PhotoSwipe（本地化，无 CDN 依赖）
  const pswpSrc = join(ROOT, 'vendor', 'photoswipe')
  if (existsSync(pswpSrc)) {
    const pswpOut = join(DIST, 'assets', 'photoswipe')
    mkdirSync(pswpOut, { recursive: true })
    for (const f of readdirSync(pswpSrc)) copyFileSync(join(pswpSrc, f), join(pswpOut, f))
  } else {
    console.warn('! 未找到 vendor/photoswipe（画廊组件缺失，将回退为新窗口打开原图）')
  }
  writeFileSync(join(DIST, 'search-index.json'), JSON.stringify({
    count: sets.length,
    generatedAt: new Date().toISOString(),
    sets: sets.map(s => ({
      slug: s.slug, title: s.title, displayTitle: s.displayTitle,
      series: s.series, model: s.model, date: s.date, tags: s.tags,
      imageCount: s.imageCount, packSize: s.packSize,
      cover: s.coverThumb ? `set/${s.slug}/thumbs/${s.coverThumb}` : (s.coverFile ? `set/${s.slug}/${s.coverFile}` : ''),
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

  console.log(`✓ 构建完成：${sets.length} 套图集 · ${totalPages} 个列表页 → dist/`)
  console.log(`  缩略图部署 ${deployedThumbCount} 个${LITE && config.deployThumbs !== 'all' ? '（仅预览图与封面；SITE_LITE=0 本地构建会包含全部）' : ''}`)
  // 原图托管地址是内网 IP 时提醒：公网访客打不开这些链接
  if (OL && /^https?:\/\/(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(OL.base))) {
    console.warn(`! OpenList 地址是内网地址（${OL.base}）→ 公网访客点「原图」「打开原图目录」会打不开`)
    console.warn('  对外可用需先用 Cloudflare Tunnel / 端口映射暴露，再把 site.json 的 openlist.base 换成公网域名')
  }
  sets.slice(0, 5).forEach(s => console.log(`   · ${s.displayTitle}（${s.imageCount}P${s.packSize ? ' / ' + s.packSize : ''}）`))
  if (sets.length > 5) console.log(`   … 另有 ${sets.length - 5} 套`)
}

build()
