#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export MCP_GATEWAY_NAME="example"
export MCP_GATEWAY_LISTEN_HOST="127.0.0.1"
export MCP_GATEWAY_LISTEN_PORT="3101"
export MCP_UPSTREAM_HOST="127.0.0.1"
export MCP_UPSTREAM_PORT="3001"
export MCP_BACKEND_SCRIPT="/ABSOLUTE/PATH/TO/backend.example.sh"
export MCP_IDLE_MS="300000"
export MCP_STARTUP_MS="45000"
export MCP_BACKEND_LOG="/tmp/example-mcp-backend.log"

# If the local backend needs a bearer token, load it from Keychain or an
# environment/file reference. Never hardcode it in this repository.
# export MCP_UPSTREAM_BEARER_TOKEN="$(security find-generic-password -s SERVICE -w)"

exec node /ABSOLUTE/PATH/TO/gpt-mcp-access/scripts/on-demand-mcp-gateway.mjs
