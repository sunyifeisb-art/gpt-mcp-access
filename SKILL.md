---
name: gpt-mcp-access
description: 把任意 MCP（本地 stdio 或远程 HTTP）暴露给 ChatGPT 网页端（Web GPT）连接的完整方案。含 DevSpace 模式、stdio→远程OAuth桥接、远程MCP OAuth包装、Cloudflare隧道(有/无域名)、owner密码OAuth、ChatGPT缓存在client_id、常见错误与修复。When user wants to connect a local/remote MCP (IMA/元典/自定义) to the web-based GPT, or debug why a GPT-MCP connection fails.
---

# GPT 接入 MCP —— 把 MCP 暴露给 ChatGPT 网页端（Web GPT）

本 skill 沉淀了「如何让 ChatGPT 网页端能用上本地/远程的 MCP」，涵盖从零到一的全流程、真实踩过的坑、以及可复用的脚本模板。

## 一、最核心的认知（先读这个，否则方向会错）

1. **ChatGPT 网页端只能连「远程 HTTP MCP」**：一个 HTTPS 地址 + OAuth 授权。它**永远不能** spawn 本地子进程。
2. 所以任何本地 MCP 想给网页端用，**必须**变成"远程 HTTP + OAuth"。这一步绕不开。
3. MCP 源分两种，工作量差别巨大：
   - **stdio MCP**（本地子进程，如 legalwork 的 IMA Python）：需要**完整桥接**（spawn 子进程 + 转发 + OAuth）。
   - **远程 HTTP MCP**（如元典 `open.chineselaw.com`、北大法宝 `apim-gateway.pkulaw.com`）：已经是远程 HTTP，只需**极薄 OAuth 包装**（转发 + 注入 `Authorization: Bearer` 头）。**没有登录、没有 cookie、没有扫码。**
4. **DevSpace**（`@waishnav/devspace`）是这个模式的权威成品：让 ChatGPT 网页端连本机读文件/跑 shell。**我们的桥接直接复刻它的 OAuth「单 Owner 密码」授权模式。**

## 二、架构（三层）

```
ChatGPT 网页端 (MCP Client)
   │  HTTPS + OAuth (owner 密码授权)
   ▼
[隧道] Cloudflare / trycloudflare —— 把本地端口暴露成公网 URL
   │
   ▼
[桥接] Node + @modelcontextprotocol/sdk
   │  OAuth 授权 + 转发 tools/call
   ├──► [源 MCP: stdio]  Python/Node 子进程（ima-mcp-server.py 等）
   └──► [源 MCP: 远程HTTP] open.chineselaw.com 等（转发 + 注入 Bearer）
```

- **隧道**解决"本地端口 → 公网可访问"。
- **桥接**解决"ChatGPT 只认 OAuth 远程 MCP"的认证 + 传输问题。
- **源 MCP**提供真正的工具能力。

## 三、快速上手（三选一的路径）

选 A：**远程 HTTP MCP（最省事，元典/北大法宝这种）** —— 见 `references/architecture.md`
选 B：**本地 stdio MCP（IMA 这种）** —— 见 `references/architecture.md`
选 C：**只用 DevSpace 直连本机，不额外搭 MCP** —— 不在此范围，看 `references/github-projects.md` 的 DevSpace 链接。

通用 4 步：
1. 明确源 MCP 类型 + 拿到凭证（API key / cookie / token）。
2. 用 `scripts/` 里的模板复制一个 bridge，配好 env。
3. 起隧道（有域名 → Cloudflare 命名隧道；无域名 → trycloudflare 快速隧道）。详见 `references/cloudflare-tunnel.md` 和 `references/no-domain.md`。
4. ChatGPT 网页端添加 MCP URL + 输 owner 密码授权。

## 四、认证模型（owner 密码，DevSpace 模式）

- 网页端连 MCP 走 **OAuth 授权码 + PKCE**。
- 服务端用来鉴权的是**一个 Owner 密码**（`SingleUserOAuthProvider`，复刻自 DevSpace）。授权页是「Connect <name> + Owner password」表单，密码对了才发授权码。
- **两个致命坑（必须处理，否则网页端连不上）：**
  1. **ChatGPT 会永久缓存 client_id**（DCR 注册的），删了重加也**不重新注册**。一旦服务端重启把 client 丢了（内存存储时），它就永远 `invalid_client`。→ **方案：OAuth client/token 用 JSON 持久化**（`scripts/state-store.mjs`，同步写），**且自定义 `/authorize` 自动放行任何 client_id**（owner 密码才是真正的门）。详见 `references/oauth-auth.md`。
  2. token 存内存 → 每次重启失效 → 网页端每次都要重授权。→ **持久化解决**。

## 五、隧道（有 / 无域名）

- **有域名**：Cloudflare **命名隧道**（named tunnel），route 用 **「Published application routes」**（不是 Hostname routes，那是私网）。URL 永久稳定。脚本：`cloudflared tunnel run --protocol http2 --token <token>`。
- **无域名**：cloudflared **快速隧道**（`trycloudflare.com`），一条命令给临时 URL（`https://xxx.trycloudflare.com`）。**URL 每次重启会变**，网页端需每次重加。详见 `references/no-domain.md`。
- **境内关键**：http2(不要 QUIC)，否则反复断。详见 `references/cloudflare-tunnel.md`。

## 六、错误排查速查表（真实踩过）

| 症状 | 根因 | 修复 |
|---|---|---|
| Cloudflare **502** Bad gateway | `app.set("trust proxy", true)` 被 express-rate-limit v7 拒绝 | 改成 `app.set("trust proxy", 1)` |
| 公网 **530** / 错误码 **1033** / GET **000** | 隧道掉线（cloudflared 连不上 edge，Shadowrocket fake-ip） | 重启 cloudflared，见 `references/cloudflare-tunnel.md` |
| `invalid_client` / `Invalid client_id` | ChatGPT 缓存 client_id，服务端重启丢了 | 持久化 + 自定义 `/authorize` 自动放行 |
| `IMA_AUTH_EXPIRED` / 400 "couldn't connect your account" | IMA cookie 过期 | 调 `open_ima_login`/`refresh_ima_auth`，用户扫码 |
| "stream is not readable" | 全局 `express.json()` 与 createMcpExpressApp 冲突 | 别全局挂 json，用 SDK 自带解析 |
| registerTool 报 schema 错误 | `inputSchema` 要 Zod，不是 JSON Schema | 用 `jsonSchemaToZod()` 转换 |
| `Already connected to a transport` | 同一 McpServer 复用了多次 | 每个 session initialize 新建 McpServer |
| `Client secret is required` | MemoryClientsStore 擅自生成 secret | 公开客户端别生成 secret |
| 元典 402 | 元力余额不足 | 提示用户，别重试 |

完整版见 `references/pitfalls-errors.md`。

## 七、涉及的开源项目 / 技术栈

核心见 `references/github-projects.md`：
- `@modelcontextprotocol/sdk`（MCP 官方 SDK，npm）
- `@waishnav/devspace`（DevSpace，让 ChatGPT 连本机）
- `cloudflared`（Cloudflare 隧道）
- 腾讯 IMA（知识库，社区 `highkay/tencent-ima-copilot-mcp`）
- 元典 `open.chineselaw.com` / 北大法宝 `apim-gateway.pkulaw.com`（远程 HTTP MCP）

## 八、可复用脚本模板（scripts/）

- `bridge-stdio.mjs` —— stdio→远程 OAuth 桥接（IMA 用）
- `bridge-remote-http.mjs` —— 远程 HTTP MCP OAuth 包装（元典用，聚合多服务 + 工具加 `<svc>__` 前缀）
- `state-store.mjs` —— OAuth client/token JSON 持久化
- `ima-login.mjs` —— Playwright 扫码登录抓 cookie（IMA 专用）
- `ima-web-serve.sh` —— 幂等 start/status/health/stop

## 九、安全注意

- **owner 密码 / API key / cookie 都是机密**：写入本地配置文件或环境变量，**绝不硬编码进仓库**。本仓库脚本全部通过 env / 本地文件读取，不含真实密钥。
- 文档里的 URL、方法可公开，但 token 一律 `${...}` 占位。
