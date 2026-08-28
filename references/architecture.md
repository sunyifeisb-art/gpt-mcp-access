# 架构与桥接代码要点

## 判断源 MCP 类型：stdio vs 远程 HTTP？(决定工作量)

| | stdio | 远程 HTTP |
|---|---|---|
| 形态 | 本地子进程（`python script.py`），走 stdin/stdout JSON-RPC | `https://host/path`，POST JSON-RPC |
| 怎么鉴定 | `ps` 看到本地进程；`python xxx.py` 是启动命令 | 能 `curl https://host/.well-known/oauth-authorization-server` 或返回 MCP 信息 |
| 鉴权 | 通常无，或凭证在脚本内部（cookie/API key） | `Authorization: Bearer <key>` 请求头 |
| 桥接方式 | `StdioClientTransport` spawn 子进程 | `StreamableHTTPClientTransport` 连上游 |
| 额外工作 | 完整桥接 + 可能还要登录抓凭证 | 极薄：OAuth + 转发 + 注入 Bearer |

## 通用桥接结构（两类都复用同一套 OAuth 外壳）

```js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
```

### 1) 连源 MCP（两种 transport）

**读 stdio：**
```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({ command: "python3", args: [SCRIPT], env: childEnv });
const client = new Client({ name: "bridge", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
```

**连远程 HTTP（注意：这是最容易写错的 API）：**
```js
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
// url 是第一个【位置参数】(URL)，headers 放在 opts.requestInit.headers——不是 {url, headers}
const t = new StreamableHTTPClientTransport(new URL(UPSTREAM_URL), {
  requestInit: { headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json, text/event-stream" } },
});
const client = new Client({ name: "bridge", version: "1.0.0" });
await client.connect(t);
```

### 2) 注册工具（必须 Zod schema）

`registerTool` 的 `inputSchema` **要 Zod schema/raw shape**，不是裸 JSON Schema。Python `tools/list` 返回的是 JSON Schema → 转换：
```js
function jsonSchemaToZod(s) {
  if (!s || typeof s !== "object") return z.any();
  if (Array.isArray(s.enum) && s.enum.length) return z.enum(s.enum.map(String));
  const t = s.type, desc = s.description; const d = (f) => (desc ? f.describe(desc) : f);
  switch (t) {
    case "string": case "integer": case "number": case "boolean":
      return d(t === "boolean" ? z.boolean() : (t === "string" ? z.string() : z.number()));
    case "array": return d(z.array(jsonSchemaToZod(s.items ?? {})));
    case "object": {
      const req = new Set(s.required ?? []);
      const shape = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) { const zv = jsonSchemaToZod(v); shape[k] = req.has(k) ? zv : zv.optional(); }
      return d(z.object(shape).passthrough());
    }
    default: return z.any();
  }
}
// 注册
server.registerTool(name, { description, inputSchema: jsonSchemaToZod(t.inputSchema) }, async (args) => {
  const r = await client.callTool({ name: t.name, arguments: args ?? {} });
  return { content: r.content ?? [], isError: r.isError ?? false };
});
```

**⚠️ 每个 connect 只能挂一个 McpServer**：多个 session 时，每个 `initialize` 分支**新建一个 McpServer** 再 connect（DevSpace 也这么干）。否则报 `Already connected to a transport`。

### 3) OAuth 外壳（express + owner 密码）

```js
const app = createMcpExpressApp({ host: "localhost", ...(allowedHosts ? { allowedHosts } : {}) });
app.set("trust proxy", 1);   // ⚠️ 必须=1，不能 true(502)也不能不设(报 X_FORWARDED_FOR)
const oauthProvider = new SingleUserOAuthProvider({ ownerToken, scopes, accessTokenTtlSeconds, refreshTokenTtlSeconds, stateDir }, mcpUrl);
const bearerAuth = requireBearerAuth({ verifier: oauthProvider, requiredScopes: [scopes[0]], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl) });
app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl, baseUrl, resourceServerUrl, scopesSupported, resourceName }));
app.all("/mcp", async (req, res) => {
  // bearerAuth → session → StreamableHTTPServerTransport → 新建 McpServer.connect
});
```

### 4) 错误码对照（桥接常见）

- **`Client secret is required`**：MemoryClientsStore.registerClient **不要**生成 client_secret（公开客户端 `token_endpoint_auth_method: "none"` 应无 secret）。否则被当成机密客户端。
- **`stream is not readable`**：别 `app.use(express.json())` 全局 — 跟 createMcpExpressApp 的 body 解析冲突。
- **`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` / `ERR_ERL_PERMISSIVE_TRUST_PROXY`**：trust proxy 设错 → 设 `1`。

完整代码模板见 `scripts/bridge-stdio.mjs` 和 `scripts/bridge-remote-http.mjs`。
