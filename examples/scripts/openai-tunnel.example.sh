#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CONTROL_PLANE_API_KEY="$(security find-generic-password -s com.example.openai-tunnel-runtime -w)"

for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 1 http://127.0.0.1:3101/healthz >/dev/null; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "on-demand MCP gateway did not become healthy in time" >&2
    exit 1
  fi
  sleep 1
done

exec tunnel-client run --profile http-on-demand
