#!/bin/sh
set -eu

CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
CORE_HOME="${CODEX_CHATGPT_WEB_HOME:-$HOME/.codex-chatgpt-web}"
CODEX_CONFIG="$CODEX_HOME_DIR/config.toml"
MODEL_CACHE="$CODEX_HOME_DIR/models_cache.json"
WEBGPT_CONFIG="$CORE_HOME/config.json"

APP="/Applications/Codex Web GPT.app"
if [ ! -d "$APP" ]; then
  APP="$HOME/Applications/Codex Web GPT.app"
fi

printf '%s\n' '== Codex Web GPT / Plus status =='

if [ -d "$APP" ]; then
  echo "launcher: installed ($APP)"
else
  echo "launcher: missing"
fi

if pgrep -x "Codex Web GPT" >/dev/null 2>&1; then
  echo "launcher_process: running"
else
  echo "launcher_process: stopped"
fi

if [ -f "$WEBGPT_CONFIG" ]; then
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$WEBGPT_CONFIG" <<'PY'
import json, sys
p = sys.argv[1]
try:
    data = json.load(open(p, 'r', encoding='utf-8'))
except Exception as exc:
    print(f"webgpt_config: unreadable ({exc})")
    raise SystemExit(0)
print("webgpt_config: present")
for key in ("mode", "browserHost", "browserInteractionMode", "solAvailable", "proAvailable", "experimentalBiggerContext"):
    if key in data:
        print(f"  {key}: {data[key]}")
if data.get("proAvailable") is True:
    print("  WARNING: account reports Pro capability; this wrapper is intended for a Plus-only account.")
PY
  else
    echo "webgpt_config: present (python3 unavailable; safe field parsing skipped)"
  fi
else
  echo "webgpt_config: missing (launcher setup not completed yet)"
fi

if [ -f "$CODEX_CONFIG" ]; then
  echo "codex_route:"
  ROUTE_LINES="$(grep -E '^[[:space:]]*(openai_base_url|experimental_realtime_webrtc_call_base_url)[[:space:]]*=' "$CODEX_CONFIG" 2>/dev/null || true)"
  if [ -n "$ROUTE_LINES" ]; then
    printf '%s\n' "$ROUTE_LINES" | sed 's/^/  /'
  else
    echo "  no managed Web GPT route found"
  fi
else
  echo "codex_route: config.toml missing"
fi

if [ -f "$MODEL_CACHE" ]; then
  MODELS="$(grep -o 'chatgpt-web/[A-Za-z0-9._-]*' "$MODEL_CACHE" 2>/dev/null | sort -u || true)"
  echo "codex_web_models:"
  if [ -n "$MODELS" ]; then
    printf '%s\n' "$MODELS" | sed 's/^/  /'
  else
    echo "  none"
  fi
  if printf '%s\n' "$MODELS" | grep -Eq 'chatgpt-web/(extra-high|pro)$'; then
    echo "WARNING: Extra High/Pro model rows are present. A Plus-only account should normally expose Instant/Medium/High only."
  fi
else
  echo "codex_web_models: models_cache.json missing"
fi

if [ -S "$CORE_HOME/runtime/turn-broker.sock" ]; then
  echo "turn_broker: socket present"
else
  echo "turn_broker: no socket (normal when Full Harness is not active)"
fi

if command -v tunnel-client >/dev/null 2>&1; then
  echo "tunnel_client: $(command -v tunnel-client)"
else
  echo "tunnel_client: not found in PATH"
fi

printf '%s\n' '== expected Plus rows: Instant / Medium / High =='
