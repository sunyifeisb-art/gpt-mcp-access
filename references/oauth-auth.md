# OAuth 认证：owner 密码模型 + 持久化 + 自动放行

## 一、模型（复刻 DevSpace 的 SingleUserOAuthProvider）

网页端连 MCP 走标准 **OAuth 授权码 + PKCE**。服务端唯一用来鉴权的是**一个 Owner 密码**：
- 网页端发起 OAuth → 浏览器跳 `/authorize?response_type=code&client_id=<id>&redirect_uri=...&code_challenge=...`
- 服务端渲染表单「Connect <name>」，要用户输入 **Owner password**
- 密码对 → 302 带 `code` → 网页端 `POST /token`（PKCE 换 access_token）→ 用 access_token 调 `/mcp`
- 每服务一个 owner 密码（IMA、元典各一个）

`SingleUserOAuthProvider` 核心方法（复刻自 DevSpace，唯一改动是把 sqlite 换成 JSON/内存）：
`authorize`（GET 渲染表单 / POST 校验密码发 code）、`challengeForAuthorizationCode`、`exchangeAuthorizationCode`、`exchangeRefreshToken`、`verifyAccessToken`、`revokeToken`。

## 二、⚠️ ChatGPT 的 client 缓存陷阱（必须处理）

**现象：** 网页端授权时报 `{ "error": "invalid_client", "error_description": "Invalid client_id" }`，删了重加也不消失。

**根因：** ChatGPT 网页端会做**动态客户端注册（DCR）**拿到一个 client_id，然后**永久缓存**它。服务端一旦因为是**内存存储**而重启，把 client 丢了，ChatGPT **不会重新注册**（它一直复用缓存的那个 client_id），于是永远 `invalid_client`。

**两个必须的修复（一起上）：**

### 1) OAuth client/token 持久化（JSON 文件）

用 `scripts/state-store.mjs`：client、access token、refresh token 写到 `~/.xxx/.state-<svc>/oauth.json`。
- **同步写**，别用 200ms 防抖——快速重启时防抖还没触发就丢数据了（踩过）。
- 这样服务重启，client 和 token 都还在，网页端不用重授权。

### 2) 自定义 `/authorize` 自动放行任何 client_id

因为 ChatGPT 可能带着一个**从未持久化过**的旧 client_id 来（比如换过机器/换过实现），光持久化不够。既然**真正的鉴权门是 owner 密码**，就让 `/authorize` 自动注册并放行任何 client_id：
```js
const formBody = express.urlencoded({ extended: false });
const handleAuthorize = async (req, res) => {
  const b = req.body ?? {}, q = req.query ?? {};
  const clientId = q.client_id ?? b.client_id, redirectUri = q.redirect_uri ?? b.redirect_uri;
  if (!clientId || !redirectUri) return res.status(400).json({ error: "invalid_request", error_description: "client_id and redirect_uri are required" });
  // 自动注册并持久化（公开客户端，无 secret）
  oauthProvider.clientsStore.registerClient({ client_id: clientId, redirect_uris: [redirectUri], token_endpoint_auth_method: "none", client_secret: undefined, client_secret_expires_at: undefined, client_name: b.client_name || "auto" });
  const resourceVal = q.resource ?? b.resource;
  const params = { redirectUri, codeChallenge: q.code_challenge ?? b.code_challenge, scopes: [q.scope ?? b.scope ?? SCOPES[0]], resource: resourceVal ? new URL(resourceVal) : resourceServerUrl, state: q.state ?? b.state };
  await oauthProvider.authorize({ client_id: clientId, redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }, params, res);
};
app.get("/authorize", handleAuthorize);
app.post("/authorize", formBody, handleAuthorize);   // 挂在 mcpAuthRouter 之前，抢先接管 /authorize
```
放行后 owner 密码才是真正的授权门槛，安全性不受影响。`test-autoauth.mjs` 用未知 client 走完整链路能通过。

## 三、@modelcontextprotocol/sdk 的 OAuth 存储接口

SDK 不内置内存版 client/token store，`OAuthServerProvider` 需要你提供 `clientsStore`：
- `clientsStore.getClient(id)` / `registerClient(client)` —— DCR 注册
- `tokenStore.saveTokenPair / getAccessToken / getRefreshToken / deleteAccessToken / deleteRefreshToken`
- 公开客户端注册时 **不要自动生成 client_secret**（否则被当成需 secret 的机密客户端，token 换不了）。

DevSpace 用 `SqliteOAuthStore`（better-sqlite3 原生）；单用户低频场景用 **JSON 文件**（`state-store.mjs`）更省心，去掉原生依赖。

## 四、MCP 请求受 OAuth 保护

`app.all("/mcp", async (req,res)=>{ ... bearerAuth ... })`：
- 无 token → 401 `invalid_token`。
- 有 token → 走 `StreamableHTTPServerTransport`（每个 initialize 新建一个 McpServer，见 `architecture.md`）。
- 注意 /mcp 的 `Accept` 需含 `application/json, text/event-stream`（真实 ChatGPT 客户端会自动带）。

## 五、授权页长什么样

`authorizeForm` 渲染一个「Connect <name> + Owner password」表单（复用 DevSpace 的 HTML/CSS，显示 client/scope/resource）。密码错误返回 401 并再渲染表单，密码对则 302 带 code。
