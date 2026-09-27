#!/usr/bin/env bash
# ============================================================================
# dsh-go-gateway-fix —— macOS 安装脚本（launchd LaunchAgent）
#
# 用法：
#   ./install.sh              # 安装并启动
#   ./install.sh --remove     # 停止并卸载
#   ./install.sh --status     # 查看状态与日志
#
# 说明：
#   * 装成当前用户的 LaunchAgent，不需要 sudo。
#   * plist 里 KeepAlive=true，进程崩了会自动拉起。
#   * 日志写到 ~/Library/Logs/dsh-go-gateway-fix/。
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROXY_JS="$ROOT/proxy.js"
LABEL="com.dsh.gogatewayfix"
PLIST_SRC="$SCRIPT_DIR/$LABEL.plist"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST_DST="$AGENT_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/dsh-go-gateway-fix"

# ------------------------------------------------------------------ 前置检查
if [[ ! -f "$PROXY_JS" ]]; then
  echo "错误：找不到 $PROXY_JS" >&2
  echo "      本脚本必须放在发布包的 scripts/macos/ 目录里。" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误：找不到 node，请先安装 Node.js 18+（brew install node）。" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"

# launchd 不会展开 ~ 也不会读你的 shell PATH，所以必须用绝对路径
case "$NODE_BIN" in
  /*) : ;;
  *) echo "错误：node 路径不是绝对路径（$NODE_BIN），请检查 PATH。" >&2; exit 1 ;;
esac

# ------------------------------------------------------------------ 卸载
if [[ "${1:-}" == "--remove" ]]; then
  launchctl unload -w "$PLIST_DST" 2>/dev/null || true
  rm -f "$PLIST_DST"
  echo "已卸载：$PLIST_DST"
  echo "日志仍保留在 $LOG_DIR（要删自己删）。"
  exit 0
fi

# ------------------------------------------------------------------ 状态
if [[ "${1:-}" == "--status" ]]; then
  echo "--- launchctl ---"
  launchctl list | grep "$LABEL" || echo "（未加载）"
  echo
  echo "--- 代理 stdout 尾部 ---"
  tail -n 20 "$LOG_DIR/proxy.out.log" 2>/dev/null || echo "（暂无日志）"
  echo
  echo "--- 代理 stderr 尾部 ---"
  tail -n 20 "$LOG_DIR/proxy.err.log" 2>/dev/null || echo "（暂无日志）"
  exit 0
fi

# ------------------------------------------------------------------ 安装
mkdir -p "$AGENT_DIR" "$LOG_DIR"

sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__PROXY_JS__|$PROXY_JS|g" \
    -e "s|__WORK_DIR__|$ROOT|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    "$PLIST_SRC" > "$PLIST_DST"

# 校验生成的 plist 是不是合法 XML
if ! plutil -lint "$PLIST_DST" >/dev/null 2>&1; then
  echo "错误：生成的 plist 校验失败，请检查 $PLIST_DST" >&2
  plutil -lint "$PLIST_DST" || true
  exit 1
fi

echo "已生成 plist：$PLIST_DST"
echo "  node      = $NODE_BIN"
echo "  proxy.js  = $PROXY_JS"
echo "  日志目录  = $LOG_DIR"

# 先卸掉旧的，避免重复加载
launchctl unload -w "$PLIST_DST" 2>/dev/null || true
launchctl load -w "$PLIST_DST"

sleep 1
echo
launchctl list | grep "$LABEL" || true
echo
echo "完成。常用命令："
echo "  launchctl list | grep $LABEL"
echo "  launchctl unload -w $PLIST_DST && launchctl load -w $PLIST_DST   # 重启"
echo "  tail -f $LOG_DIR/proxy.out.log"
echo "  $SCRIPT_DIR/install.sh --remove"
echo
echo "想开启碎片合并：编辑 $PLIST_DST，在 EnvironmentVariables 里加上"
echo "  <key>DSH_MERGE_FRAGMENT</key><string>1</string>"
echo "然后卸载再加载一次（见上面的重启命令）。"
