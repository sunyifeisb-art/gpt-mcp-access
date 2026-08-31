# 错误排查与踩坑记录（真实踩过，逐条修复）

## 零、先确定正在排哪套链路

```text
新主链路：ChatGPT → OpenAI control plane → tunnel-client → loopback MCP
旧公网链路：ChatGPT → HTTPS 域名 → cloudflared → OAuth bridge → MCP
```

如果 ChatGPT Connector 里选的是 OpenAI tunnel，先看本节和 `openai-secure-tunnel.md`，不要先修改 Cloudflare、DNS、Shadowrocket fake-IP 规则。

### OpenAI Tunnel 错误速查

| 症状 | 根因 | 修复 |
|---|---|---|
| `does not implement OAuth` | 本地 target 无 OAuth metadata，但 connector 选了 OAuth | 改选 No Authentication；或实现完整 OAuth/DCR/PRMD |
| `/healthz` 200 仍连不上 | health 只是 liveness | 查 `/readyz`、OAuth discovery、MCP probe、tunnel/workspace 是否一致 |
| `Failed to fetch template` | connector discovery、control plane、daemon、gateway 或 backend 任一层失败 | 按层检查，不凭一个 502/400猜根因 |
| gateway `backend: stopped` | 按需后端已正常休眠 | 发 MCP initialize；应自动拉起并变 running |
| `backend_start_failed` | 启动脚本退出、健康路径/端口错、依赖或凭证失败 | 看 gateway/backend 日志，手工执行 backend wrapper |
| 空闲后第一条 400/404 | 后端关闭导致旧 MCP session 失效 | 客户端重新 initialize；必要时延长 idle 或做稳定 session gateway |
| 换网络后断线 | control-plane 长连接/轮询没有恢复，或新网络阻断 443 | 检查 daemon 和 `api.openai.com:443`，必要时重启 tunnel-client；不用改公网 IP |
| connector 校验失败 | daemon 不在线、tunnel/workspace 不匹配、认证类型错 | 保持 tunnel-client 运行并逐项核对 |

### 正确的健康判断

1. tunnel-client `/healthz`：进程是否活着；
2. tunnel-client `/readyz`：OAuth discovery/MCP probe；
3. on-demand gateway `/healthz`：`stopped` 可以是正常空闲；
4. 真正验证：MCP `initialize`、`tools/list`、一个只读工具；
5. 不用 GET `/mcp` 的 404 当作 Streamable HTTP 失败证据。

## 一、桥接代码层错误

| 错误 | 根因 | 修复 |
|---|---|---|
| `SyntaxError: Illegal return statement` | ESM 顶层 `return` 非法 | 逻辑包进 `async main(){...}`，最后 `process.exitCode = await main()` |
| `SyntaxError: Unexpected token '||'` | `??` 和 `||` 混用无括号 | 全用 `??`：`q.scope ?? b.scope ?? SCOPES[0]` |
| `inputSchema must be a Zod schema or raw shape` | `registerTool` 的 `inputSchema` 要 Zod，不是裸 JSON Schema | 用 `jsonSchemaToZod()` 转换 |
| `Already connected to a transport` | 对同一 `McpServer` 多次 `connect` | 每个 session 的 initialize 分支**新建一个 McpServer** |
| `stream is not readable` | 全局 `app.use(express.json())` 与 createMcpExpressApp 冲突 | 别全局挂 json，让 SDK 自带解析；只在 `/authorize` POST 挂 urlencoded |
| `Client secret is required` | MemoryClientsStore.registerClient 自动生成了 secret | 公开客户端（`token_endpoint_auth_method:"none"`）**不要生成 secret** |
| `Failed to parse URL from [object Object]` | `StreamableHTTPClientTransport` 传了 `{url,headers}` 一个对象 | url 是第一个位置参数(URL)，headers 放 `opts.requestInit.headers` |
| `Cannot find package 'playwright'` | 脚本在 /tmp 解析不到本地 node_modules | 脚本放项目目录，或相对路径 import |

## 二、OAuth / 网页端连接错误

| 错误 | 根因 | 修复 |
|---|---|---|
| `invalid_client` / `Invalid client_id`（网页端授权页黑屏） | ChatGPT 缓存了 client_id，服务端重启丢了 | **持久化** + 自定义 `/authorize` 自动放行（见 `oauth-auth.md`） |
| 网页端既无密码页也无登录页（502） | trust proxy 设成 `true` 被 express-rate-limit v7 拒绝 | 设 `app.set("trust proxy", 1)` |
| 每次重启都要重输 owner 密码 | token 存内存 | OAuth token 持久化（`state-store.mjs`） |
| 502 / 503 授权页 | 见上 trust proxy；或隧道问题（看下表） | 分别处理 |

## 三、旧 Cloudflare 隧道 / 网络错误

| 症状 | 根因 | 修复 |
|---|---|---|
| Cloudflare **502** | trust proxy= `true` 触发 `ERR_ERL_PERMISSIVE_TRUST_PROXY` | 设 `1` |
| `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` | 未设 trust proxy，而 Cloudflare 加了 X-Forwarded-For | 设 `1` |
| **530** / 错误码 **1033** / GET **000** | cloudflared 连不上 edge（Shadowrocket fake-ip，TLS EOF） | 重启 cloudflared；Shadowrocket 加 DIRECT 规则；用 http2 |
| 新 hostname 刚加 curl **000**后变200 | Cloudflare 边缘/证书分发延迟 ~60s | **不是配置错**，等一会儿即可 |
| `dig` 返回 198.18.x | Shadowrocket fake-ip 正常现象 | 别用 dig 判断；看 cloudflared `Registered tunnel connection` |

详见 `references/cloudflare-tunnel.md`。

## 四、上游 MCP 业务错误

| 错误 | 含义 | 处理 |
|---|---|---|
| `IMA_AUTH_EXPIRED` + "couldn't connect your account" | IMA cookie 过期/会话失效 | 调 `open_ima_login`（弹扫码窗）或 `refresh_ima_auth`，然后重试 |
| IMA `list_available_knowledge_bases` 空 | 走的是 cookie/登录页快照路径，cookie 没登录态 | 先 `open_ima_login` 扫码 |
| 元典 **402** | 元力余额不足 | 提示用户，别反复重试 |
| 元典/北大法宝某工具 not found | 工具名被聚合加了前缀（`<svc>__`） | 调用时带前缀；或核对工具列表 |

## 五、IMA 特有的坑

- **两个认证是两回事**：网页端连 MCP 用**owner 密码**（我们自己 OAuth）；IMA 自身用**cookie**（腾讯登录）。别混。
- **open_ima_login/refresh_ima_auth 在 standalone 下**：原本是为 legalwork 的 Electron 写触发文件；standalone 要让**bridge fs-watch 到触发文件再 spawn Playwright 登录脚本**（见 `scripts/ima-login.mjs`），否则是空转。
- **cookie 是快照**：复制来的 cookie 会随 IMA 会话过期；过期后要重新 `open_ima_login` 扫码抓新 cookie（`creds.json`）。
- **Playwright 驱动系统 Chrome**：`chromium.launch({ channel: "chrome" })`，装 `playwright` 时 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 跳过下 Chromium，用系统 Chrome。

## 六、防坑速查（每次操作前看一眼）

1. trust proxy 设 `1`，不要 `true` 也别不设。
2. client/token 用 JSON 持久化，别内存。
3. 自定义 `/authorize` 自动放行，否则 ChatGPT 缓存 client 连不上。
4. 远程 HTTP 的 `StreamableHTTPClientTransport`：`new StreamableHTTPClientTransport(new URL(u), { requestInit:{headers} })`。
5. 每个 session 新建 McpServer。
6. 域名路由用「Published application routes」，别用「Hostname routes」。
7. 境内隧道用 `--protocol http2`。
8. 判断隧道：看 cloudflared `Registered`，别信 dig。
9. 新 hostname 有 ~60s 分发延迟，别急着重启。
