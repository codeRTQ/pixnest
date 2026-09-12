# 本地预览 / 编辑环境（一键盘）
#   · 完整模式构建：包含原图与压缩包，页面带「编辑这套图集」入口（?admin=1）
#   · 启动静态预览站（8090）与管理后台（8091）
# 用法：右键「使用 PowerShell 运行」，或在终端执行  .\preview.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 本地模式：完整构建 + 保留后台入口 + 不带线上域名
$env:SITE_LITE = '0'
$env:SITE_PUBLIC = '0'
Remove-Item Env:SITE_BASE_URL -ErrorAction SilentlyContinue

Write-Host '== 构建（完整模式 / 本地管理入口保留）==' -ForegroundColor Cyan
node build.mjs
if ($LASTEXITCODE -ne 0) { Write-Host '构建失败' -ForegroundColor Red; exit 1 }

function Test-Port($p) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
}

if (Test-Port 8090) {
  Write-Host '站点预览已在运行： http://127.0.0.1:8090' -ForegroundColor Yellow
} else {
  Start-Process -FilePath 'python' -ArgumentList '-m', 'http.server', '8090', '--directory', 'dist' `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
  Start-Sleep -Seconds 1
  Write-Host '站点预览已启动： http://127.0.0.1:8090' -ForegroundColor Green
}

if (Test-Port 8091) {
  Write-Host '管理后台已在运行： http://127.0.0.1:8091' -ForegroundColor Yellow
} else {
  Start-Process -FilePath 'python' -ArgumentList 'admin.py' -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden -RedirectStandardOutput '_admin.log' -RedirectStandardError '_admin.err.log'
  Start-Sleep -Seconds 2
  Write-Host '管理后台已启动： http://127.0.0.1:8091' -ForegroundColor Green
}

Write-Host ''
Write-Host '详情页带 ?admin=1 会显示「编辑这套图集」入口' -ForegroundColor DarkGray
Write-Host '发布上线：python deploy.py --cloudflare --project pixnest-gallery --base-url https://pixnest-gallery.pages.dev' -ForegroundColor DarkGray
