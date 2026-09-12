# 一键发布上线（构建 → 体检 → 打包 → 上传 Cloudflare Pages）
# 用法：右键「使用 PowerShell 运行」，或在终端执行  .\publish.ps1
#   .\publish.ps1          只发缩略图站点（默认，公网约 4.6 MB，推荐）
#   .\publish.ps1 -Full    连原图与压缩包一起上传（体积大 10-20 倍，不推荐）
param([switch]$Full)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 代理：仅当本机 Clash(7890) 在监听时才启用（wrangler 访问 API 需要）
if (Get-NetTCPConnection -State Listen -LocalPort 7890 -ErrorAction SilentlyContinue) {
    $env:HTTPS_PROXY = 'http://127.0.0.1:7890'
    $env:HTTP_PROXY = 'http://127.0.0.1:7890'
    Write-Host '已启用本地代理 127.0.0.1:7890' -ForegroundColor DarkGray
}

$deployArgs = @(
    'deploy.py',
    '--cloudflare',
    '--project', 'pixnest-gallery',
    '--base-url', 'https://pixnest.dpdns.org'
)
if ($Full) { $deployArgs += '--full' }

Write-Host '== 开始发布（约 40 秒）==' -ForegroundColor Cyan
python @deployArgs
if ($LASTEXITCODE -ne 0) { Write-Host '✗ 发布失败，请看上面的报错' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '✅ 发布完成： https://pixnest.dpdns.org/' -ForegroundColor Green
Write-Host '   若浏览器仍显示旧内容，按 Ctrl+F5 强制刷新' -ForegroundColor DarkGray
