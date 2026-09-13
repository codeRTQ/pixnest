# 一键：发布到线上 + 提交代码到 GitHub
#
# 用法：
#   .\release.ps1                      发布；有代码改动则提示填写提交说明
#   .\release.ps1 "修复标签合并按钮"     发布 + 用给定说明提交并推送
#   .\release.ps1 -SkipPublish         只提交代码，不发布
#   .\release.ps1 -SkipGit             只发布，不提交
#
# 说明：内容目录 sets/ 与构建产物 dist/ 不入库，所以常常"只发布、无代码改动"，
#       脚本会自动识别并跳过提交，不会产生空提交。
param(
    [Parameter(Position = 0)][string]$Message = '',
    [switch]$SkipPublish,
    [switch]$SkipGit
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# ── 代理：仅当本机 Clash(7890) 在监听时启用（wrangler 访问 CF API、git push 走 GitHub 都需要）
if (Get-NetTCPConnection -State Listen -LocalPort 7890 -ErrorAction SilentlyContinue) {
    $env:HTTPS_PROXY = 'http://127.0.0.1:7890'
    $env:HTTP_PROXY = 'http://127.0.0.1:7890'
    Write-Host '已启用本地代理 127.0.0.1:7890' -ForegroundColor DarkGray
}

$project = 'pixnest-gallery'
$siteUrl = 'https://pixnest.dpdns.org'

# ── 1/3 发布 ──────────────────────────────────────────────
if (-not $SkipPublish) {
    Write-Host "`n=== 1/3 发布到线上（构建 → 体检 → 打包 → 上传，约 40-70 秒）===" -ForegroundColor Cyan
    python deploy.py --cloudflare --project $project --base-url $siteUrl
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n✗ 发布失败，已中止（代码未提交）" -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ 已上线：$siteUrl" -ForegroundColor Green
} else {
    Write-Host "`n=== 1/3 跳过发布（-SkipPublish）===" -ForegroundColor DarkGray
}

# ── 2/3 代码提交 ──────────────────────────────────────────
if ($SkipGit) {
    Write-Host "`n=== 2/3 跳过代码提交（-SkipGit）===" -ForegroundColor DarkGray
    exit 0
}

Write-Host "`n=== 2/3 检查代码改动 ===" -ForegroundColor Cyan
git add -A
$staged = git diff --cached --name-only
if (-not $staged) {
    Write-Host '  没有代码改动（内容更新不入库，属正常）→ 跳过提交' -ForegroundColor DarkGray
    Write-Host "`n✅ 完成：内容已发布，代码无改动。$siteUrl" -ForegroundColor Green
    exit 0
}

Write-Host '  改动文件：' -ForegroundColor DarkGray
$staged | ForEach-Object { Write-Host "    · $_" -ForegroundColor DarkGray }

if (-not $Message) {
    $tip = '更新站点 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')
    $input = Read-Host "  提交说明（直接回车用「$tip」）"
    $Message = if ([string]::IsNullOrWhiteSpace($input)) { $tip } else { $input.Trim() }
}
Write-Host "  提交说明：$Message"

# 提交说明走文件，避免引号/换行把命令行搞断
$msgFile = Join-Path $env:TEMP ('dsh-commit-' + [guid]::NewGuid().ToString('N') + '.txt')
[System.IO.File]::WriteAllText($msgFile, $Message, (New-Object System.Text.UTF8Encoding($false)))
git commit -q -F $msgFile
Remove-Item $msgFile -Force -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) { Write-Host '✗ 提交失败' -ForegroundColor Red; exit 1 }
$hash = (git log -1 --format='%h')
Write-Host "  ✅ 已提交：$hash" -ForegroundColor Green

# ── 3/3 推送 ──────────────────────────────────────────────
Write-Host "`n=== 3/3 推送到 GitHub ===" -ForegroundColor Cyan
git push
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n⚠️ 推送失败（本地提交仍在，可稍后手动 git push）" -ForegroundColor Yellow
    Write-Host "   常见原因：代理没开、GitHub 网络不通" -ForegroundColor DarkGray
    exit 1
}

Write-Host "`n✅ 全部完成" -ForegroundColor Green
if (-not $SkipPublish) { Write-Host "   线上：$siteUrl" -ForegroundColor Green }
Write-Host "   仓库：https://github.com/codeRTQ/pixnest （$hash）" -ForegroundColor Green
