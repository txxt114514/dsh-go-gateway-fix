<#
.SYNOPSIS
    dsh-go-gateway-fix —— Windows 开机自启安装/卸载（写 HKCU Run，免提权）。

.DESCRIPTION
    在 HKCU:\Software\Microsoft\Windows\CurrentVersion\Run 下写一个值，
    登录时自动拉起代理。因为只动当前用户的注册表，所以不需要管理员权限，
    也不会弹 UAC。

    默认拉起的是 scripts\start.cmd（含崩溃自动重启循环）。
    用 -Port / -MergeFragment 可以把环境变量固化进命令行。

.EXAMPLE
    # 安装（默认端口 8899，碎片合并关闭）
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1

.EXAMPLE
    # 安装并开启碎片合并，端口 9000
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Port 9000 -MergeFragment

.EXAMPLE
    # 查看当前状态
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Status

.EXAMPLE
    # 卸载
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove
#>

[CmdletBinding()]
param(
    # 本地监听端口
    [int]$Port = 8899,
    # 是否开启碎片合并（默认关）
    [switch]$MergeFragment,
    # 卸载：删除自启项
    [switch]$Remove,
    # 只看当前状态，不做任何修改
    [switch]$Status
)

$ErrorActionPreference = 'Stop'

$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$ValueName = 'dsh-go-gateway-fix'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$ProxyJs = Join-Path $Root 'proxy.js'
$StartCmd = Join-Path $ScriptDir 'start.cmd'

function Get-CurrentValue {
    try {
        $item = Get-ItemProperty -Path $RunKey -Name $ValueName -ErrorAction Stop
        return $item.$ValueName
    } catch {
        return $null
    }
}

# ---------------------------------------------------------------- 状态
if ($Status) {
    $cur = Get-CurrentValue
    if ($cur) {
        Write-Host "已安装：" -NoNewline -ForegroundColor Green
        Write-Host $cur
    } else {
        Write-Host "未安装（$RunKey 下没有 $ValueName）" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "代理文件：$ProxyJs  （存在：$(Test-Path $ProxyJs)）"
    Write-Host "启动脚本：$StartCmd  （存在：$(Test-Path $StartCmd)）"
    $node = Get-Command node -ErrorAction SilentlyContinue
    Write-Host "node     ：$(if ($node) { $node.Source } else { '未找到！请先安装 Node.js >= 18' })"
    return
}

# ---------------------------------------------------------------- 卸载
if ($Remove) {
    $cur = Get-CurrentValue
    if (-not $cur) {
        Write-Host "本来就没装（$RunKey 下没有 $ValueName），无需卸载。" -ForegroundColor Yellow
        return
    }
    Remove-ItemProperty -Path $RunKey -Name $ValueName -Force
    Write-Host "已删除自启项：$ValueName" -ForegroundColor Green
    Write-Host "原来指向：$cur"
    Write-Host ""
    Write-Host "注意：已经在跑的代理进程不会被这个命令停掉。"
    Write-Host "      要停它：Get-Process node | Where-Object { \$_.Path -and \$_.CommandLine -like '*proxy.js*' }"
    Write-Host "      或者直接在任务管理器里结束对应的 node.exe。"
    return
}

# ---------------------------------------------------------------- 安装
if (-not (Test-Path $ProxyJs)) {
    throw "找不到 proxy.js：$ProxyJs（本脚本必须放在发布包的 scripts\ 目录里）"
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw '找不到 node。请先安装 Node.js 18 或更高版本，并确保它在 PATH 里。'
}

# 优先用 start.cmd（带崩溃自动重启）；没有就退回直接跑 node。
# 内层命令自带引号，这样安装路径里含空格也不会断。
if (Test-Path $StartCmd) {
    $inner = '"{0}"' -f $StartCmd
} else {
    $inner = '"{0}" "{1}"' -f $nodeCmd.Source, $ProxyJs
}

# 把端口/开关固化进去：用 cmd 的 set 前缀，避免依赖用户环境变量。
# 固定写成 cmd.exe /c "set X=1&& "<内层命令>"" —— 实测这种写法在含空格的
# 路径下也能正确执行（写成 ""..."" 那种双引号形式反而会失败）。
$envPrefix = ''
if ($Port -ne 8899) { $envPrefix += "set PORT=$Port&& " }
if ($MergeFragment) { $envPrefix += 'set DSH_MERGE_FRAGMENT=1&& ' }

$target = 'cmd.exe /c "' + $envPrefix + $inner + '"'

# 确保 Run 键存在（正常系统都有）
if (-not (Test-Path $RunKey)) {
    New-Item -Path $RunKey -Force | Out-Null
}

$old = Get-CurrentValue
if ($old) {
    Write-Host "覆盖已有自启项：" -ForegroundColor Yellow
    Write-Host "  旧：$old"
}
Set-ItemProperty -Path $RunKey -Name $ValueName -Value $target

Write-Host "已写入开机自启。" -ForegroundColor Green
Write-Host "  位置：$RunKey"
Write-Host "  名称：$ValueName"
Write-Host "  命令：$target"
Write-Host "  端口：$Port    碎片合并：$(if ($MergeFragment) { '开' } else { '关（默认）' })"
Write-Host ""
Write-Host "下次登录会自动启动。想现在就起："
Write-Host "  & '$StartCmd'"
Write-Host ""
Write-Host "卸载：powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Remove"
