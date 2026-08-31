#!/bin/bash
set -euo pipefail

# Start exactly one foreground MCP HTTP process. Use exec so the on-demand
# gateway can stop the whole process group after the idle timeout.
export MCP_PORT="${MCP_PORT:-3001}"
exec node /ABSOLUTE/PATH/TO/your-mcp-http-server.mjs
