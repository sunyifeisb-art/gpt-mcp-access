# gpt-mcp-access

把本地或私有 MCP 稳定接入 **ChatGPT 网页端** 的方法、模板和真实排障记录；同时支持把 **ChatGPT Web 直接作为 Codex 原生模型** 使用。

当前推荐架构已经更新为：

```text
ChatGPT Connector
    ↓ OpenAI control plane
OpenAI Secure MCP Tunnel（本机主动访问 api.openai.com:443）
    ↓ loopback
本地 MCP / 认证 shim / 按需唤醒网关
```

这与旧版“Cloudflare 公网域名 + 自建 OAuth bridge”不同：主链路不要求固定公网 IP、不需要路由器端口映射，也不再依赖 Cloudflare edge 的 `7844` 出站质量。Cloudflare 方案仍保留在仓库中，作为兼容旧部署或无法使用 OpenAI Tunnel 时的备选。

> 本仓库记录的是 2026-08-31 在 macOS 上实际跑通并完成断线排查、自动唤醒和空闲回收验证的架构。OpenAI Tunnel 是否可用取决于组织/账号是否显示对应功能与权限，请以本机 `tunnel-client help quickstart` 与 OpenAI Platform 的 Tunnels 页面为准。

## 能解决什么

- ChatGPT 网页端调用本地 HTTP MCP 或 stdio MCP。
- **Codex 原生模型选择器直接使用 ChatGPT Web**，保留 Codex 任务、上下文和流式 UI。
- ChatGPT Plus 账户按权限只暴露 `Instant / Medium / High`，不伪造 `Extra High / Pro`。
- 笔记本在不同 Wi-Fi、手机热点和代理网络之间切换，不依赖公网 IP 固定。
- 一个 MCP 永久常驻；另一些 MCP 只在 GPT 调用时启动，5 分钟无请求后关闭。
- 本地 MCP 需要 bearer token/OAuth 时，通过 loopback shim 或轻量网关注入，不把凭证暴露给 ChatGPT。
- 排查 `Failed to fetch template`、`does not implement OAuth`、400/502/530/1033、隧道在线但后端未启动等问题。

## Codex 内直接使用 Web GPT（Plus）

新增的 Codex 路由与原有通用 MCP tunnel **并存**：

```text
Codex task
  → local Responses bridge
  → ChatGPT Web（Plus：Instant / Medium / High）
  → 可选 Codex Native2 专用 tunnel
  → 当前 Codex task 的本地工具
```

macOS 安装：

```bash
./scripts/install-codex-webgpt-plus.sh
```

首次登录并安装模型后，检查：

```bash
./scripts/codex-webgpt-status.sh
```

完整设计、Full Harness 与现有 tunnel 的并存规则见 [`references/codex-webgpt-plus.md`](references/codex-webgpt-plus.md)。

## 推荐路径

| 场景 | 推荐连接方式 |
|---|---|
| Codex 里直接使用 ChatGPT Web（Plus） | `scripts/install-codex-webgpt-plus.sh` → Web GPT launcher → Codex 原生模型 |
| 本地 HTTP MCP，无认证 | `tunnel-client` 直接指向 `127.0.0.1:<port>/mcp` |
| 本地 stdio MCP | `tunnel-client init --sample sample_mcp_stdio_local` |
| 本地 HTTP MCP，有内部认证 | OpenAI Tunnel → loopback shim → MCP |
| 后端不想常驻 | OpenAI Tunnel → 常驻轻量网关 → 按需后端 |
| 账号没有 OpenAI Tunnels | Cloudflare/其他公网 HTTPS 隧道作为备选 |

## 快速开始：OpenAI Secure MCP Tunnel

1. 在 [OpenAI Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) 创建 tunnel。
2. 创建**运行时 API key**，运行 tunnel-client 的主体需要 `Tunnels Read + Use`；不要把 Admin key 交给常驻 daemon。
3. 生成配置并先做 doctor：

   ```bash
   tunnel-client init \
     --sample sample_mcp_remote_no_auth \
     --profile local-mcp \
     --tunnel-id tunnel_REPLACE_ME \
     --mcp-server-url http://127.0.0.1:3001/mcp

   export CONTROL_PLANE_API_KEY="..."
   tunnel-client doctor --profile local-mcp --explain
   tunnel-client run --profile local-mcp
   ```

4. 检查 `/healthz`、`/readyz`，然后在 [ChatGPT Connectors](https://chatgpt.com/#settings/Connectors) 选择同一个 tunnel。
5. 本地目标没有 OAuth/PRMD metadata 时，连接器选择 **No Authentication / 无身份验证**；不要强行选择 OAuth。

完整说明见 [OpenAI Secure MCP Tunnel](references/openai-secure-tunnel.md)。

## 按需启动与五分钟空闲关闭

仓库提供可直接改造的模板：

- [`scripts/on-demand-mcp-gateway.mjs`](scripts/on-demand-mcp-gateway.mjs)：常驻轻量 loopback 网关。
- [`examples/scripts/backend.example.sh`](examples/scripts/backend.example.sh)：真实 MCP 后端启动器。
- [`examples/scripts/on-demand-gateway.example.sh`](examples/scripts/on-demand-gateway.example.sh)：网关环境配置。
- [`examples/tunnel-client/http-on-demand.yaml`](examples/tunnel-client/http-on-demand.yaml)：OpenAI tunnel-client profile。
- [`examples/launchd/`](examples/launchd/)：macOS LaunchAgent 模板。

数据面流程：

```text
OpenAI Tunnel（常驻）
    ↓
on-demand gateway（常驻，资源占用很小）
    ↓ 首次 /mcp 请求时启动
真实 MCP backend（按需）
    ↓ 300 秒无请求且无活跃 SSE
关闭整个 backend 进程组
```

```bash
node scripts/test-on-demand-gateway.mjs
```

详见 [按需生命周期](references/on-demand-lifecycle.md)。

## 目录

```text
SKILL.md
references/
  codex-webgpt-plus.md      Codex 原生 Web GPT（Plus）与 Full Harness
  openai-secure-tunnel.md   当前首选连接方式
  on-demand-lifecycle.md    按需拉起、空闲关闭与 macOS 托管
  architecture.md           MCP 类型、shim/bridge 选择
  pitfalls-errors.md        新旧两套链路错误速查
  cloudflare-tunnel.md      旧 Cloudflare 方案（备选）
  no-domain.md              临时公网隧道（备选）
  oauth-auth.md             自建 OAuth bridge（兼容旧部署）
scripts/
  install-codex-webgpt-plus.sh
  codex-webgpt-status.sh
  on-demand-mcp-gateway.mjs
  test-on-demand-gateway.mjs
  bridge-stdio.mjs
  bridge-remote-http.mjs
  state-store.mjs
examples/
  tunnel-client/
  scripts/
  launchd/
```

## 安全边界

- tunnel ID 可以写配置；运行时 API key、Admin key、owner 密码、API key、Cookie、bearer token 不得提交。
- ChatGPT Web 登录状态不从 Safari/Chrome/ChatGPT App 抽取或复制；首次在 Codex Web GPT 中本人登录。
- Plus 不伪造 Extra High/Pro capability。
- 推荐使用 macOS Keychain、环境变量或 `env:` / `file:` 引用凭证。
- tunnel-client 的健康/UI 默认只监听 `127.0.0.1`；不要无意使用 `--allow-remote-ui`。
- `--log.http-raw-unsafe` 可能记录请求体和敏感头，只能短时调试，不能作为常驻设置。

## 旧方案如何处理

已有 `gpt.bytelegal.cn` 一类域名不等于 ChatGPT 当前仍从该域名传输。迁移到 OpenAI Secure MCP Tunnel 后，域名可以继续服务其他客户端或保留兼容配置，但 ChatGPT Connector 的主路径已经变为 OpenAI control plane → 本机 tunnel-client。

Cloudflare 文档和 OAuth bridge 模板没有删除，避免破坏历史部署；它们已明确标成 fallback/legacy，不应再作为换网断线问题的第一修复方向。

## License

MIT
