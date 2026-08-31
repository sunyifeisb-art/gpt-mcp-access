# 架构选择：OpenAI Tunnel、shim、按需网关与旧 bridge

## 1. 当前默认拓扑

```text
ChatGPT Connector
  → OpenAI MCP control plane
  → tunnel-client（本机主动 HTTPS 443 出站）
  → 127.0.0.1 本地目标
```

本地目标按能力选择：

```text
无认证 HTTP MCP       → tunnel-client 直接连接
stdio MCP             → tunnel-client mcp.command
内部 bearer/OAuth MCP → loopback shim 注入凭证
不想常驻的 MCP        → on-demand gateway 拉起 backend
旧公网 URL 部署        → Cloudflare + 自建 OAuth bridge（兼容）
```

## 2. 先判断源 MCP 类型

| 类型 | 识别方式 | OpenAI Tunnel 推荐接法 |
|---|---|---|
| stdio | 启动命令通过 stdin/stdout 交换 JSON-RPC | `sample_mcp_stdio_local` + `--mcp-command` |
| 本地 HTTP 无认证 | `127.0.0.1:<port>/mcp` 接受 Streamable HTTP | `sample_mcp_remote_no_auth` + `--mcp-server-url` |
| 本地 HTTP + OAuth/DCR | 有 PRMD/authorization-server metadata | `sample_mcp_with_dcr`，ChatGPT 选 OAuth |
| 本地 HTTP + 私有 bearer | 只认固定 Authorization header | ChatGPT 选 No Authentication，本机 shim/gateway 注入 |
| 远程 HTTP MCP | 已有 HTTPS MCP URL | 可直接配置远程 URL；需要隐藏上游 key 时仍用本机 shim |

不要再把“ChatGPT 只能连接公网 HTTPS URL，因此必须 Cloudflare + 自建 OAuth”当作绝对前提。OpenAI Secure MCP Tunnel 已经提供本地/私有 MCP 到 ChatGPT 的受控出站链路。

## 3. 直接连接还是加一层 shim

直接连接适合：

- 本地目标无认证；
- 目标原生实现 MCP Streamable HTTP；
- 不需要修改 headers、metadata 或生命周期。

加 loopback shim/gateway 适合：

- 需要注入 `Authorization: Bearer ...`；
- 旧服务的 OAuth/resource metadata 与新 tunnel URL 不一致；
- 需要隐藏本地 OAuth metadata，让 ChatGPT 明确使用 No Authentication；
- 需要按需启动/五分钟空闲关闭；
- 需要统一健康检查和日志边界。

shim 和 gateway 都只监听 `127.0.0.1`，不承担公网 TLS；公网/控制面边界由 OpenAI Tunnel 负责。

## 4. 常驻与按需的正确拆分

### 常驻 MCP

```text
tunnel-client（常驻） → shim（如需要，常驻） → backend（常驻）
```

适合 DevSpace、文件/终端类基础能力等需要随时响应的服务。

### 按需 MCP

```text
tunnel-client（常驻） → on-demand gateway（常驻） → backend（按需）
```

真实 backend 在第一个 `/mcp` 请求到来时启动；无活跃请求/SSE 且空闲 300 秒后关闭。实现见：

- `scripts/on-demand-mcp-gateway.mjs`
- `references/on-demand-lifecycle.md`
- `examples/`

## 5. 认证责任分层

这里有三种不同凭证，不能混：

| 凭证 | 谁使用 | 用途 |
|---|---|---|
| OpenAI Runtime API key | tunnel-client | 访问 OpenAI tunnel control plane |
| ChatGPT connector OAuth | ChatGPT ↔ MCP target | 仅当目标真正实现 OAuth/DCR/PRMD |
| 上游 API key/cookie/bearer | 本地 shim/backend | IMA、元典或自定义数据源认证 |

安全原则：

- Runtime key 不交给本地 MCP；
- 上游 key 不交给 ChatGPT；
- Admin key 不交给常驻 daemon；
- Keychain/env/file reference 代替仓库明文。

## 6. 旧 bridge 何时仍需要

`scripts/bridge-stdio.mjs` 与 `scripts/bridge-remote-http.mjs` 仍有价值，但定位改为兼容方案：

- 账号没有 OpenAI Tunnels；
- 需要给非 ChatGPT 客户端提供公网 MCP URL；
- 已有 Cloudflare 域名部署不能立即迁移；
- 目标明确要求自建 OAuth owner-password 模型。

旧 bridge 的 SDK 注意事项仍成立：

- `StreamableHTTPClientTransport` 的 URL 是第一个位置参数；
- `registerTool` 的 `inputSchema` 需要 Zod；
- 每个 MCP session 新建 `McpServer`；
- 不要让全局 `express.json()` 与 MCP body parser 冲突；
- OAuth client/token 必须持久化。

## 7. 完成验证的最短路径

1. `tunnel-client doctor --profile <name> --explain`；
2. `/healthz` 与 `/readyz`；
3. ChatGPT connector 选择同一 tunnel/workspace；
4. MCP `initialize`；
5. `tools/list`；
6. 一个只读工具；
7. 按需模式再测空闲关闭与二次唤醒。

不要仅凭 tunnel 进程存在、GET `/mcp`、域名能打开或连接器图标出现就宣布成功。
