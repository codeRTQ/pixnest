# 本地预览 / 编辑环境（一键盘）
#   · 构建本地预览版（默认精简模式：只拷缩略图，几秒完成、约 500MB）
#   · 启动静态预览站（8090）与管理后台（8091）
# 用法：
#   .\preview.ps1          精简模式（推荐，与线上形态一致）
#   .\preview.ps1 -Full    完整模式：原图也拷进 dist（36 套约 21GB，很慢，仅在需要本地看原图时用）
param([switch]$Full)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 本地模式：保留后台编辑入口（?admin=1）、不带线上域名
$env:SITE_LITE = if ($Full) { '0' } else { '1' }
$env:SITE_PUBLIC = '0'
Remove-Item Env:SITE_BASE_URL -ErrorAction SilentlyContinue

if ($Full) {
    Write-Host '== 构建（完整模式：含原图，可能几分钟、占十几 GB）==' -ForegroundColor Yellow
} else {
    Write-Host '== 构建（精简模式：只拷缩略图，几秒）==' -ForegroundColor Cyan
}
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
Write-Host '改完内容后： .\release.ps1 "说明"   ← 发布上线 + 提交代码' -ForegroundColor DarkGray
