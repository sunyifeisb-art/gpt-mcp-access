---
name: gpt-mcp-access
description: 把本地/私有 MCP 连接到 ChatGPT 网页端，并把 ChatGPT Web 作为 Codex 原生模型使用。当前优先使用 OpenAI Secure MCP Tunnel（443 主动出站），支持常驻 MCP、认证 shim、按需拉起、5 分钟空闲关闭，以及 Plus 账户的 Codex Web GPT Instant/Medium/High 路由；Cloudflare + 自建 OAuth 仅作兼容备选。Use when connecting IMA/元典/DevSpace/custom MCP to ChatGPT, routing Codex through ChatGPT Web, or diagnosing template fetch, OAuth, tunnel, network-switch, and local lifecycle failures.
---

# GPT 网页端接入本地 MCP / Codex Web GPT

## 一、默认判断：先区分两条链路

### A. ChatGPT 网页端调用本地 MCP

```text
ChatGPT Connector
  → OpenAI MCP control plane
  → 本机 tunnel-client（主动 HTTPS 443 出站）
  → 127.0.0.1 本地 MCP / shim / on-demand gateway
```

### B. Codex 原生模型直接使用 ChatGPT Web

```text
Codex task
  → local Responses bridge
  → ChatGPT Web
  → 可选 Codex Native2 专用 tunnel
  → 当前 Codex task 的工具 harness
```

两条链路可以并存。不要为了 B 覆盖 A 已经给 IMA、元典或其他 MCP 使用的 tunnel；Codex Native2 应使用独立 connector/profile。

处理任何“GPT MCP 断了”时，先检查 A，不要一上来改 Cloudflare、域名、Shadowrocket fake-IP 或公网 IP。处理“Codex 里看不到/用不了 Web GPT”时，先检查 B 的 launcher、账户能力、Codex route 与 models cache。

只有以下情况才优先读旧 Cloudflare 方案：

- 用户明确说当前连接器填的是公网 URL/域名；
- 账号没有 Tunnels 功能；
- 现有部署必须继续兼容 Cloudflare/自建 OAuth bridge。

## 二、五种接入形态

### A. 本地 HTTP MCP、无认证

直接用 tunnel-client 指向 loopback：

```bash
tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile local-http \
  --tunnel-id tunnel_REPLACE_ME \
  --mcp-server-url http://127.0.0.1:3001/mcp

export CONTROL_PLANE_API_KEY="..."
tunnel-client doctor --profile local-http --explain
tunnel-client run --profile local-http
```

ChatGPT Connector 选择同一 tunnel；本地 MCP 不实现 OAuth 时选 **No Authentication**。

### B. 本地 stdio MCP

tunnel-client 可以直接启动 stdio 命令：

```bash
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile local-stdio \
  --tunnel-id tunnel_REPLACE_ME \
  --mcp-command "python /absolute/path/server.py"
```

如果要求“5 分钟不用就关”，不要把重后端直接当永久 tunnel 进程；使用 C 的常驻轻网关 + 按需后端结构。

### C. 按需后端

- tunnel-client 常驻；
- `scripts/on-demand-mcp-gateway.mjs` 常驻；
- 真正 MCP 只在 `/mcp` 请求到达时启动；
- 300 秒无请求且没有活跃 SSE/HTTP 请求时关闭整个进程组。

配置见 `references/on-demand-lifecycle.md` 与 `examples/`。

### D. 本地 MCP 自带 OAuth/内部认证

OpenAI Tunnel 不会替本地目标凭空实现 OAuth。三种做法：

1. 本地 MCP 真正实现 OAuth/DCR/PRMD：保留 metadata，ChatGPT 选择 OAuth。
2. ChatGPT 连接器选 No Authentication，由 loopback shim 在本机注入 bearer token（推荐用于单机私有后端）。
3. 旧公网部署继续使用本仓库的 owner-password OAuth bridge（仅兼容方案）。

### E. Codex 原生 Web GPT（ChatGPT Plus）

当用户要求“Codex 内部直接用网页版 GPT / Web GPT”时，优先使用本仓库的 Plus wrapper：

```bash
./scripts/install-codex-webgpt-plus.sh
```

固定规则：

- Plus 只按权限使用 `ChatGPT Web — Instant / Medium / High`；
- 不伪造、不别名映射 `Extra High / Pro`；
- 首次 ChatGPT 登录由用户本人在 `Codex Web GPT` launcher 中完成，不复制浏览器 Cookie；
- 安装模型后重启 Codex 一次；
- 需要当前 Codex task 的本地工具时，创建独立 `Codex Native2` connector/tunnel；
- 原有 IMA、元典和通用 MCP tunnel 不覆盖、不删除。

验证：

```bash
./scripts/codex-webgpt-status.sh
```

详细结构见 `references/codex-webgpt-plus.md`。

## 三、OpenAI Tunnel 标准操作顺序

1. 创建或确认 tunnel：`https://platform.openai.com/settings/organization/tunnels`。
2. 创建 Runtime API key；常驻 daemon 使用运行时 key，不使用 Admin key。
3. 用 `tunnel-client init` 或 `examples/tunnel-client/` 建 profile。
4. `tunnel-client doctor --profile <name> --explain`。
5. 启动 tunnel-client；长期运行应交给受监督的 runtime/LaunchAgent，不用 `nohup`/`disown` 冒充守护。
6. 同时看 `/healthz` 和 `/readyz`：health 只代表进程活着，ready 才包含 OAuth discovery 与 MCP probe。
7. tunnel-client 运行时，在 ChatGPT Connectors 选择同一 tunnel 和正确 workspace。
8. 用真实 MCP `initialize`、`tools/list` 和至少一个只读工具验证，不用 GET `/mcp` 的 404 判断协议是否坏了。

详见 `references/openai-secure-tunnel.md`。

## 四、最常见的新架构错误

| 症状 | 优先判断 | 修复 |
|---|---|---|
| Codex 看不到 Web GPT | launcher 未完成账户检测/Install models，或 Codex 未重启 | 先跑 smoke test + Install models，再重启 Codex |
| Plus 出现 Extra High/Pro | 账户能力或旧 models cache 不一致 | 刷新账户能力并重新安装模型，不强行调用 |
| Web GPT 能回答但不能用本地工具 | 处于 browser-only，或 Codex Native2 未连通 | 配置独立 Full Harness tunnel/connector |
| `does not implement OAuth` | 目标没有 OAuth metadata，却在连接器选了 OAuth | 改为 No Authentication，或实现真实 OAuth/DCR/PRMD |
| `/healthz` 200 但仍不可用 | 只验证了 liveness | 看 `/readyz`、MCP probe、同一 tunnel/workspace |
| `Failed to fetch template` | connector discovery/会话/本地目标任一段失败 | 按 control plane → tunnel → gateway → backend 分层检查 |
| gateway 显示 `backend: stopped` | 可能只是按需后端空闲 | 发 MCP 请求验证是否自动变为 running |
| 五分钟后第一次调用 400/404 | 后端重启后旧 MCP session 已失效 | 让客户端重新 initialize；若频繁影响体验，延长 idle 或实现稳定 session gateway |
| 换 Wi-Fi 后断开 | 长轮询/代理连接未恢复，不是公网 IP 必须固定 | 重启/检查 tunnel-client control-plane poll；无需重配域名 IP |
| connector 校验失败 | tunnel 未运行、workspace 不匹配或认证类型错 | 保持 daemon 运行，核对 tunnel/workspace/auth |

完整表见 `references/pitfalls-errors.md`。

## 五、旧 Cloudflare + OAuth 方案

Cloudflare 方案仍可用，但不是默认：

```text
ChatGPT → 公网 HTTPS 域名 → cloudflared → OAuth bridge → MCP
```

它依赖公网域名/临时 URL、Cloudflare edge、`7844` 网络质量及自建 OAuth 状态。在 Shadowrocket fake-IP/TUN 或不同网络环境中更容易出现 TLS EOF、530/1033、502 和间歇性断线。

- 固定域名：`references/cloudflare-tunnel.md`
- 临时 URL：`references/no-domain.md`
- owner-password OAuth：`references/oauth-auth.md`
- 旧 bridge：`scripts/bridge-stdio.mjs`、`scripts/bridge-remote-http.mjs`

不要删除旧部署，迁移时先并行验证 OpenAI Tunnel，再切换 ChatGPT Connector。

## 六、安全规则

- 不提交 Runtime/Admin API key、owner 密码、上游 API key、Cookie、bearer token。
- 不抽取或复制用户现有浏览器/ChatGPT App 的登录 Cookie 给 Codex Web GPT。
- 不伪造 Plus 不具备的 Extra High/Pro capability。
- 优先用 Keychain、环境变量或 `env:` / `file:` 引用。
- Admin key 只用于 tunnel CRUD；常驻 daemon 只拿 Runtime key。
- 健康端口、管理 UI、按需 gateway、Responses bridge 和 broker 只监听 `127.0.0.1`/本地 socket。
- 不长期启用 raw HTTP 日志；它可能包含 PII 和认证头。

## 七、验证完成标准

### 通用 MCP 链路

只有同时满足下列条件才报告成功：

1. tunnel-client `/healthz` 200；
2. `/readyz` 可解释且无阻断错误；
3. ChatGPT 使用同一 tunnel/workspace；
4. MCP `initialize`、`tools/list` 成功；
5. 至少一个真实只读工具成功；
6. 按需模式还要验证：空闲关闭、再次请求自动唤醒；
7. 仓库与日志中无密钥泄露。

### Codex Web GPT Plus 链路

报告“Codex 内可直接使用 Web GPT”前至少验证：

1. launcher 已安装并完成登录；
2. `proAvailable` 为 `false`；
3. Codex route 已安装；
4. models cache 有 Plus 可用 Web GPT 行；
5. Codex 中选中 Web GPT 后完成一次真实流式回答；
6. 若声明 Full Harness 可用，还必须完成一次真实当前-task 工具调用。
