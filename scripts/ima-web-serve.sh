#!/bin/bash
# IMA 知识库 MCP → 远程 HTTP+OAuth 桥接 启动/状态 脚本（GPT 可经 DevSpace 调用）
#
# 用法（GPT 只需记住一条）：
#   ~/.ima-web-mcp/ima-web-serve.sh          # 没跑就拉起，跑了不动（幂等）
#   ~/.ima-web-mcp/ima-web-serve.sh status   # 看是否在跑 + 本地健康
#   ~/.ima-web-mcp/ima-web-serve.sh health   # 看公网是否可达
#   ~/.ima-web-mcp/ima-web-serve.sh stop     # 停止（慎用）
#
# 常驻启动 ~/.ima-web-mcp/bridge.mjs，绑 3001，公网 https://ima.bytelegal.cn/mcp
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
MYDIR="$HOME/.ima-web-mcp"
PORT="${IMA_WEB_PORT:-3001}"
PUBLIC="https://ima.bytelegal.cn"
OWNER_FILE="$MYDIR/.owner-token.txt"
CREDS_FILE="$MYDIR/creds.json"
LOG="/tmp/ima-web-mcp.log"

export IMA_WEB_PORT="$PORT"
export IMA_WEB_PUBLIC_BASE_URL="$PUBLIC"
export IMA_WEB_ALLOWED_HOSTS="ima.bytelegal.cn,localhost,127.0.0.1"
# Owner 密码若已生成则读取文件（脚本内不再硬编码，从 .owner-token.txt 读）
if [ -f "$OWNER_FILE" ]; then
  export IMA_WEB_OWNER_TOKEN="$(grep -oE '[0-9a-f]{32}' "$OWNER_FILE" | head -1)"
fi
# 独立凭证文件存在才传
[ -f "$CREDS_FILE" ] && export IMA_CREDS_FILE="$CREDS_FILE"

is_running() { pgrep -f "node bridge.mjs" >/dev/null 2>&1; }
health() {
  curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && echo "UP" || echo "DOWN"
}

cmd="${1:-start}"
case "$cmd" in
  status)
    if is_running; then
      echo "RUNNING  local health=$(health)  url=$PUBLIC/mcp"
    else
      echo "STOPPED"
    fi
    exit 0
    ;;
  health)
    if hash curl 2>/dev/null; then
      code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 6 "https://$PUBLIC/.well-known/oauth-authorization-server" 2>/dev/null || true)
      echo "public oauth metadata HTTP: $code"
    fi
    exit 0
    ;;
  stop)
    echo "[$(date)] stop requested" >> "$LOG"
    pkill -f "node bridge.mjs" || true
    sleep 1
    echo "stopped (was: $(is_running && echo running || echo stopped))"
    exit 0
    ;;
esac

# 默认：幂等 start
cd "$MYDIR" || exit 1
if is_running; then
  echo "[$(date)] already running (health=$(health), url=$PUBLIC/mcp)" >> "$LOG"
  echo "ALREADY_RUNNING  local health=$(health)"
else
  echo "[$(date)] start" >> "$LOG"
  nohup node bridge.mjs > "$LOG" 2>&1 &
  disown 2>/dev/null || true
  sleep 2
  echo "[$(date)] started, health=$(health)" >> "$LOG"
  echo "STARTED  local health=$(health)  url=$PUBLIC/mcp"
fi
