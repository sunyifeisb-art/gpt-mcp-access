# OpenAI Secure MCP Tunnel（当前首选）

## 1. 为什么替代公网域名主链路

OpenAI `tunnel-client` 是本机长驻 daemon。它把本地或私有 MCP 连接到 OpenAI control plane，主连接由本机向 `https://api.openai.com` 主动发起。

```text
ChatGPT Connector
    ↓
OpenAI MCP control plane
    ↓ daemon 长轮询/命令通道（本机主动 HTTPS 443 出站）
tunnel-client
    ↓ loopback HTTP 或 stdio
local MCP
```

因此：

- 不要求固定公网 IP；
- 不要求路由器开放入站端口；
- 不要求把本地服务暴露到公网域名；
- 切换 Wi-Fi/热点后，通常只需 daemon 恢复到 OpenAI 的出站连接；
- Cloudflare 域名可以保留给其他客户端，但不再是 ChatGPT Connector 的必经路径。

## 2. 值从哪里来

管理入口：

- Tunnels：`https://platform.openai.com/settings/organization/tunnels`
- Runtime API keys：`https://platform.openai.com/settings/organization/api-keys`
- Admin API keys：`https://platform.openai.com/settings/organization/admin-keys`
- ChatGPT Connectors：`https://chatgpt.com/#settings/Connectors`

权限分离：

- 常驻 tunnel-client 使用 Runtime API key，主体需要 `Tunnels Read + Use`。
- 创建/更新/删除 tunnel 需要 `Tunnels Read + Manage`。
- Admin key 只用于管理面操作，不能当常驻 daemon 的普通运行时凭证。

## 3. 初始化三种目标

### 本地 HTTP、无 OAuth

```bash
tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile local-http \
  --tunnel-id tunnel_REPLACE_ME \
  --mcp-server-url http://127.0.0.1:3001/mcp
```

### 本地 stdio

```bash
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile local-stdio \
  --tunnel-id tunnel_REPLACE_ME \
  --mcp-command "python /absolute/path/server.py"
```

### HTTP MCP，带 OAuth/DCR metadata

```bash
tunnel-client init \
  --sample sample_mcp_with_dcr \
  --profile local-oauth \
  --tunnel-id tunnel_REPLACE_ME \
  --mcp-server-url http://127.0.0.1:3001/mcp
```

profile 的最小结构见 `examples/tunnel-client/http-on-demand.yaml`。密钥只写引用：

```yaml
control_plane:
  base_url: "https://api.openai.com"
  tunnel_id: "tunnel_REPLACE_ME"
  api_key: "env:CONTROL_PLANE_API_KEY"
```

## 4. 启动前必须 doctor

```bash
export CONTROL_PLANE_API_KEY="..."
tunnel-client doctor --profile local-http --explain
tunnel-client run --profile local-http
```

长期运行：

- 优先使用 `tunnel-client runtimes connect ...` 等受监督 runtime；
- macOS 自建部署可以使用 LaunchAgent；
- 不用 `nohup`/`disown`，否则换网、退出终端和进程崩溃后状态难以确认。

## 5. health 不等于 ready

- `/healthz`：liveness；HTTP 200 只代表 daemon 活着。
- `/readyz`：包含 OAuth discovery、MCP startup probe 等 readiness gate。
- `/ui`：查看 channel routing、OAuth discovery、日志和指标；默认仅 loopback。

常用操作：

```bash
tunnel-client doctor --profile local-http --explain
tunnel-client doctor --profile local-http --json
tunnel-client health --port 8080
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
open http://127.0.0.1:8080/ui
```

不要用 GET `/mcp` 是否 200 判断 MCP；Streamable HTTP 的核心流量是 POST JSON-RPC。

## 6. ChatGPT 连接器认证怎么选

选择取决于**本地目标**是否真的实现 OAuth metadata：

- 目标没有 `/.well-known/oauth-protected-resource/mcp` / authorization server metadata：选 **No Authentication**。
- 目标完整实现 OAuth/DCR/PRMD：选 OAuth。
- 如果内部 MCP 需要 bearer token，但不想让 ChatGPT 参与 OAuth：连接器选 No Authentication，在本机 loopback shim/gateway 中注入 token。

报错：

```text
MCP server ... does not implement OAuth
```

通常不是 tunnel 坏了，而是认证类型选错。

## 7. 连接器创建/校验注意

1. tunnel-client 必须正在运行；
2. ChatGPT 选择的 tunnel ID 必须与 daemon profile 相同；
3. tunnel 必须关联当前使用的 ChatGPT workspace；
4. connector discovery 后还要验证 `initialize`、`tools/list` 和只读工具调用；
5. 多个 MCP 使用各自 profile、健康端口和 LaunchAgent，避免日志/端口混淆。

## 8. 换网络后的正确排查

公网 IP 变化不是这套架构的配置输入。换网后失败时：

1. 看 tunnel-client 进程是否还在；
2. 看 `/healthz`、`/readyz`；
3. 看 control-plane poll 是否恢复；
4. 检查新网络/代理是否阻断 `api.openai.com:443`；
5. 必要时重启 daemon，不需要更新 DNS 或公网 IP。

## 9. 凭证与日志

- `CONTROL_PLANE_API_KEY` 用 Keychain/env/file reference；
- 不把 Runtime key 或 Admin key写进 YAML；
- `--log.http-raw-unsafe` 会记录完整 HTTP 请求/响应，可能包含认证头或 PII，只能短时使用；
- 导出日志前确认工具有脱敏能力。

## 10. 本地官方帮助是可执行基线

该功能可能尚未被公开网页完整索引。安装 tunnel-client 后，以以下帮助为当前本机版本的直接基线：

```bash
tunnel-client help quickstart
tunnel-client help oauth
tunnel-client help troubleshooting
tunnel-client help samples
tunnel-client --version
```
