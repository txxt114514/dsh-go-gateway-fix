#!/usr/bin/env bash
# ============================================================================
# dsh-go-gateway-fix —— Linux 安装脚本（systemd --user）
#
# 用法：
#   ./install.sh              # 安装并启动
#   ./install.sh --remove     # 停止并卸载
#   ./install.sh --status     # 查看状态与日志
#
# 说明：
#   * 默认装成「用户级」服务（systemd --user），不需要 sudo，
#     也不需要 root。登录后自动启动，且崩溃后自动重启。
#   * 若想装成系统级服务（开机即启、无需登录），见脚本末尾的说明。
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROXY_JS="$ROOT/proxy.js"
UNIT_NAME="opencode-go-fix.service"
UNIT_SRC="$SCRIPT_DIR/$UNIT_NAME"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_DST="$UNIT_DIR/$UNIT_NAME"

# ------------------------------------------------------------------ 前置检查
if [[ ! -f "$PROXY_JS" ]]; then
  echo "错误：找不到 $PROXY_JS" >&2
  echo "      本脚本必须放在发布包的 scripts/linux/ 目录里。" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误：找不到 node，请先安装 Node.js 18+。" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "错误：这台机器上没有 systemctl，无法用 systemd 管理。" >&2
  echo "      可以手动跑：nohup node \"$PROXY_JS\" >> \"$ROOT/proxy.log\" 2>&1 &" >&2
  exit 1
fi

# ------------------------------------------------------------------ 卸载
if [[ "${1:-}" == "--remove" ]]; then
  systemctl --user stop  "$UNIT_NAME" 2>/dev/null || true
  systemctl --user disable "$UNIT_NAME" 2>/dev/null || true
  rm -f "$UNIT_DST"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "已卸载：$UNIT_DST"
  echo "日志文件仍保留在 $ROOT/proxy.log（要删自己删）。"
  exit 0
fi

# ------------------------------------------------------------------ 状态
if [[ "${1:-}" == "--status" ]]; then
  systemctl --user status "$UNIT_NAME" --no-pager || true
  echo
  echo "--- 最近 20 行日志 ---"
  journalctl --user -u "$UNIT_NAME" -n 20 --no-pager || true
  exit 0
fi

# ------------------------------------------------------------------ 安装
mkdir -p "$UNIT_DIR"

# 用真实的 node 路径与代理路径替换 unit 里的占位符。
# 注意：用户级 unit 里不能有 User= 这一行（systemd --user 会拒绝），所以删掉。
sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__PROXY_JS__|$PROXY_JS|g" \
    -e "s|__WORK_DIR__|$ROOT|g" \
    -e "/^User=/d" \
    "$UNIT_SRC" > "$UNIT_DST"

echo "已生成 unit：$UNIT_DST"
echo "  ExecStart = $NODE_BIN $PROXY_JS"
echo "  WorkingDirectory = $ROOT"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"

# 让服务在「未登录」时也能常驻（可选，失败不影响使用）
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$USER" >/dev/null 2>&1 || true
fi

echo
systemctl --user status "$UNIT_NAME" --no-pager || true
echo
echo "完成。常用命令："
echo "  systemctl --user status  $UNIT_NAME"
echo "  systemctl --user restart $UNIT_NAME"
echo "  journalctl --user -u $UNIT_NAME -f"
echo "  $SCRIPT_DIR/install.sh --remove"
echo
echo "想开启碎片合并：编辑 $UNIT_DST，在 [Service] 里加上"
echo "  Environment=DSH_MERGE_FRAGMENT=1"
echo "然后 systemctl --user daemon-reload && systemctl --user restart $UNIT_NAME"
echo
echo "---- 想装成系统级服务（开机即启，无需登录）----"
echo "  sudo cp $UNIT_DST /etc/systemd/system/$UNIT_NAME"
echo "  sudo sed -i \"s|^User=.*|User=$USER|\" /etc/systemd/system/$UNIT_NAME   # 或直接删掉 User= 行"
echo "  sudo systemctl daemon-reload && sudo systemctl enable --now $UNIT_NAME"
