<#
.SYNOPSIS
    dsh-go-gateway-fix —— DSH 一键接线 / 还原脚本。

.DESCRIPTION
    把 DSH profile 的 cordis.patch.yml 里 opencode-go-ds41 这条 provider 的
    baseURL 改成指向本地修复代理：

        原值：https://opencode.ai/zen/go/v1
        新值：http://127.0.0.1:<Port>/zen/go/v1

    行为：
      1. 先备份原文件到 <原文件名>.bak-<时间戳>（同目录，绝不覆盖旧备份）
      2. 只在 opencode-go-ds41 这个 provider 块内替换 baseURL，其它字节不动
      3. 校验改动后的 YAML（结构检查 + 有 python 时做一次真实解析）
      4. 打印逐行 diff 与回滚方法

    安全说明：
      * 本脚本不重启 DSH，不碰别的文件，不改注册表。
      * DSH 会自己热重载 patch 层；万一配置写坏了，用 -Restore 或
        手动把 .bak-* 拷回来即可。
      * 加 -DryRun 可以只预览、不落盘。

.PARAMETER Restore
    还原：把最新的 .bak-* 备份拷回原位（同样会先给当前文件留一份备份）。

.PARAMETER Port
    本地代理端口，默认 8899。

.PARAMETER ProfilePath
    直接指定 cordis.patch.yml 的完整路径。默认自动找
    ~/.dsh/profiles/desktop/cordis.patch.yml。

.PARAMETER DryRun
    只打印将要做的改动，不写文件、不备份。

.EXAMPLE
    # 先预览
    pwsh -File scripts\dsh-wire.ps1 -DryRun

.EXAMPLE
    # 正式接线
    pwsh -File scripts\dsh-wire.ps1

.EXAMPLE
    # 还原
    pwsh -File scripts\dsh-wire.ps1 -Restore
#>

[CmdletBinding()]
param(
    [switch]$Restore,
    [int]$Port = 8899,
    [string]$ProfilePath,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$ProviderId = 'opencode-go-ds41'
$ProxyBaseUrl = "http://127.0.0.1:$Port/zen/go/v1"
$OriginalBaseUrl = 'https://opencode.ai/zen/go/v1'

# ------------------------------------------------------------------ 定位文件
if (-not $ProfilePath) {
    $ProfilePath = Join-Path $HOME '.dsh\profiles\desktop\cordis.patch.yml'
}

if (-not (Test-Path -LiteralPath $ProfilePath)) {
    throw "找不到配置文件：$ProfilePath`n如果 DSH 装在别的地方，用 -ProfilePath 指定完整路径。"
}

$ProfilePath = (Resolve-Path -LiteralPath $ProfilePath).Path
$Dir = Split-Path -Parent $ProfilePath
$FileName = Split-Path -Leaf $ProfilePath
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Host "配置文件：$ProfilePath"
Write-Host ""

# ------------------------------------------------------------------ 工具函数
function New-Backup {
    param([string]$Path, [string]$Tag)
    $d = Split-Path -Parent $Path
    $f = Split-Path -Leaf $Path
    $target = Join-Path $d ("{0}.bak-{1}{2}" -f $f, $Stamp, $Tag)
    Copy-Item -LiteralPath $Path -Destination $target -Force
    return $target
}

function Get-Backups {
    param([string]$Path)
    $d = Split-Path -Parent $Path
    $f = Split-Path -Leaf $Path
    return @(Get-ChildItem -LiteralPath $d -Filter "$f.bak-*" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending)
}

# ------------------------------------------------------------------ 还原分支
if ($Restore) {
    $backups = Get-Backups -Path $ProfilePath
    if ($backups.Count -eq 0) {
        Write-Host "没找到任何备份（$FileName.bak-*），无法还原。" -ForegroundColor Yellow
        Write-Host "可以手动把 baseURL 改回：$OriginalBaseUrl"
        return
    }

    $newest = $backups[0]
    Write-Host "将用这个备份还原：" -ForegroundColor Cyan
    Write-Host "  $($newest.FullName)"
    Write-Host "  （$($newest.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))，$($newest.Length) 字节）"
    Write-Host ""

    if ($DryRun) {
        Write-Host "[DryRun] 不会真的还原。去掉 -DryRun 即可执行。" -ForegroundColor Yellow
        return
    }

    # 还原前先把「当前版本」也留一份，避免误操作丢东西
    $safety = New-Backup -Path $ProfilePath -Tag '-before-restore'
    Copy-Item -LiteralPath $newest.FullName -Destination $ProfilePath -Force

    Write-Host "已还原。" -ForegroundColor Green
    Write-Host "  当前文件已先备份到：$safety"
    Write-Host "  还原来源          ：$($newest.FullName)"
    Write-Host ""
    Write-Host "DSH 会自动热重载，无需重启。"
    return
}

# ------------------------------------------------------------------ 读取并定位 provider 块
$raw = Get-Content -LiteralPath $ProfilePath -Raw
$lines = Get-Content -LiteralPath $ProfilePath

# 找 provider 键行：形如 "      opencode-go-ds41:"
$startIdx = -1
$startIndent = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^([ \t]*)' + [regex]::Escape($ProviderId) + '\s*:\s*$') {
        $startIdx = $i
        $startIndent = $Matches[1].Length
        break
    }
}

if ($startIdx -lt 0) {
    throw "在 $FileName 里找不到 provider 块「${ProviderId}:」。`n请确认 DSH 里已经配好这条 OpenCode Go 路由，或手工把 baseURL 改成 $ProxyBaseUrl"
}

# 块范围：从 provider 行之后，到下一个「缩进 <= provider 缩进 且非空非注释」的行为止
$endIdx = $lines.Count - 1
for ($i = $startIdx + 1; $i -lt $lines.Count; $i++) {
    $t = $lines[$i]
    if ($t -match '^\s*$') { continue }
    if ($t -match '^\s*#') { continue }
    $ind = ($t -replace '^([ \t]*).*$', '$1').Length
    if ($ind -le $startIndent) { $endIdx = $i - 1; break }
}

Write-Host "provider 块：第 $($startIdx + 1) ~ $($endIdx + 1) 行（缩进 $startIndent）"

# 块内找 baseURL
$urlIdx = -1
for ($i = $startIdx + 1; $i -le $endIdx; $i++) {
    if ($lines[$i] -match '^([ \t]*)baseURL\s*:\s*(.+?)\s*$') {
        $urlIdx = $i
        $urlIndent = $Matches[1]
        $curUrl = $Matches[2].Trim("'").Trim('"')
        break
    }
}

if ($urlIdx -ge 0) {
    Write-Host "当前 baseURL：$curUrl"
    if ($curUrl -eq $ProxyBaseUrl) {
        Write-Host ""
        Write-Host "已经是代理地址了，无需改动。" -ForegroundColor Green
        Write-Host "还原：pwsh -File `"$($MyInvocation.MyCommand.Path)`" -Restore"
        return
    }
} else {
    # 没有 baseURL 行：插在块内 api: 行之后（没有就插在 provider 行之后）
    $insertAfter = $startIdx
    for ($i = $startIdx + 1; $i -le $endIdx; $i++) {
        if ($lines[$i] -match '^\s*api\s*:') { $insertAfter = $i; break }
    }
    $urlIdx = $insertAfter
    $urlIndent = ' ' * ($startIndent + 2)
    $curUrl = '(这一块本来没有 baseURL 行)'
    Write-Host "当前 baseURL：$curUrl —— 将新增一行"
}

# ------------------------------------------------------------------ 生成新内容
$newLine = "$urlIndent`baseURL: $ProxyBaseUrl"

if ($urlIdx -eq $startIdx -and $curUrl -eq '(这一块本来没有 baseURL 行)') {
    # 新增模式：插到 insertAfter 之后
    $before = @()
    if ($urlIdx -gt 0) { $before = $lines[0..($urlIdx - 1)] }
    $after = @()
    if ($urlIdx -lt $lines.Count) { $after = $lines[$urlIdx..($lines.Count - 1)] }
    $newLines = @($before) + @($newLine) + @($after)
} else {
    $newLines = @($lines)
    $newLines[$urlIdx] = $newLine
}

# ------------------------------------------------------------------ diff 预览
Write-Host ""
Write-Host "改动预览：" -ForegroundColor Cyan
Write-Host "  - $($lines[$urlIdx])" -ForegroundColor Red
Write-Host "  + $newLine" -ForegroundColor Green
Write-Host ""

if ($DryRun) {
    Write-Host "[DryRun] 只预览，不落盘。去掉 -DryRun 即可执行。" -ForegroundColor Yellow
    return
}

# ------------------------------------------------------------------ 备份 + 写入
$backup = New-Backup -Path $ProfilePath -Tag ''
Write-Host "已备份原文件：$backup" -ForegroundColor Green

# 写 UTF-8 无 BOM，行尾沿用 LF（DSH 的 YAML 用 LF 更稳）
$text = ($newLines -join "`n") + "`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ProfilePath, $text, $utf8NoBom)
Write-Host "已写入新配置。" -ForegroundColor Green

# ------------------------------------------------------------------ YAML 校验
Write-Host ""
Write-Host "校验中 ..." -ForegroundColor Cyan
$problems = @()

$check = Get-Content -LiteralPath $ProfilePath
if ($check.Count -eq 0) { $problems += '文件为空' }
if (-not ($check | Where-Object { $_ -match '^\s*-\s+id\s*:' })) {
    $problems += '找不到任何「- id:」条目，顶层结构可能被破坏'
}
if (-not ($check | Where-Object { $_ -match [regex]::Escape($ProviderId) + '\s*:' })) {
    $problems += "找不到 provider「${ProviderId}:」"
}
if (-not ($check | Where-Object { $_ -match [regex]::Escape($ProxyBaseUrl) })) {
    $problems += "找不到新 baseURL：$ProxyBaseUrl"
}
if ($check | Where-Object { $_ -match "`t" }) {
    $problems += '文件里出现了 TAB 字符（YAML 不允许用 TAB 缩进）'
}

# 结构检查：缩进必须是 2 的倍数
$badIndent = @()
for ($i = 0; $i -lt $check.Count; $i++) {
    $t = $check[$i]
    if ($t -match '^\s*$' -or $t -match '^\s*#') { continue }
    $ind = ($t -replace '^([ \t]*).*$', '$1').Length
    if ($ind % 2 -ne 0) { $badIndent += ($i + 1) }
}
if ($badIndent.Count -gt 0) {
    $problems += "以下行缩进不是 2 的倍数：$($badIndent -join ', ')"
}

# 有 python + PyYAML 的话做一次真实解析（尽力而为，失败不算错）
$yamlParsed = $false
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
if ($py) {
    $pyScript = 'import sys,yaml;d=yaml.safe_load(open(sys.argv[1],encoding="utf-8"));print("OK" if isinstance(d,list) else "NOT_A_LIST")'
    try {
        $out = & $py.Source -c $pyScript $ProfilePath 2>&1
        if ($LASTEXITCODE -eq 0 -and "$out" -match 'OK') {
            $yamlParsed = $true
            Write-Host "  PyYAML 解析：通过（顶层是数组，符合 DSH patch 层要求）" -ForegroundColor Green
        } else {
            Write-Host "  PyYAML 解析：未通过或被跳过（$out）" -ForegroundColor Yellow
            Write-Host "  → 这只是尽力而为的检查；若 DSH 能正常热重载就说明配置是好的。"
        }
    } catch {
        Write-Host "  PyYAML 解析：跳过（$($_.Exception.Message)）" -ForegroundColor Yellow
    }
} else {
    Write-Host "  本机没有 python，跳过真实 YAML 解析，只做结构检查。" -ForegroundColor Yellow
}

if ($problems.Count -gt 0) {
    Write-Host ""
    Write-Host "校验发现问题：" -ForegroundColor Red
    foreach ($p in $problems) { Write-Host "  * $p" -ForegroundColor Red }
    Write-Host ""
    Write-Host "建议立刻还原：" -ForegroundColor Yellow
    Write-Host "  pwsh -File `"$($MyInvocation.MyCommand.Path)`" -Restore"
    Write-Host "或者手动拷贝：Copy-Item `"$backup`" `"$ProfilePath`" -Force"
    exit 1
}

Write-Host "  结构检查：通过" -ForegroundColor Green
Write-Host ""

# ------------------------------------------------------------------ 收尾提示
Write-Host "接线完成。" -ForegroundColor Green
Write-Host ""
Write-Host "现在："
Write-Host "  1. 确认代理在跑：  Get-NetTCPConnection -LocalPort $Port -State Listen"
Write-Host "                     没跑就：& `"$(Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'scripts\start.cmd')`""
Write-Host "  2. DSH 会自动热重载 patch 层，不用重启。"
Write-Host "  3. 发一句话试试，然后看代理日志有没有新增行："
Write-Host "     Get-Content `"$(Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'proxy.log')`" -Tail 5"
Write-Host ""
Write-Host "回滚（三种都行）：" -ForegroundColor Cyan
Write-Host "  A. 本脚本还原：  pwsh -File `"$($MyInvocation.MyCommand.Path)`" -Restore"
Write-Host "  B. 手动拷贝备份：Copy-Item `"$backup`" `"$ProfilePath`" -Force"
Write-Host "  C. 只改一行：把 baseURL 改回 $OriginalBaseUrl"
Write-Host ""
Write-Host "备份文件（要留着，别删）：$backup"
