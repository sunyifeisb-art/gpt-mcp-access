#!/usr/bin/env node
/**
 * IMA 知识库 MCP → 远程 HTTP + OAuth 桥接
 *
 * 把 legalwork 里那份 ima-mcp-server.py（stdio MCP）用官方 @modelcontextprotocol/sdk
 * 包成「远程 streamable-http + OAuth」，让 ChatGPT 网页端能像连 DevSpace 一样连它。
 *
 * 不碰 legalwork 源码：Python MCP 由本文件作为子进程 spawn，凭证通过环境变量传入，
 * 桥接逻辑全部在本目录（~/.ima-web-mcp/）。
 *
 * 认证：复刻 DevSpace 的 SingleUserOAuthProvider（单 Owner 密码 / browser authorize 表单），
 * 只把 sqlite 存储换成内存 Map，去掉 better-sqlite3 原生依赖。
 */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { InvalidGrantError, InvalidRequestError, InvalidTokenError, AccessDeniedError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import express from "express";
import * as z from "zod";
import { watch, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPersistentOAuthStores } from "./state-store.mjs";

// ── JSON Schema → Zod（SDK registerTool 要 Zod schema，Python 返回 JSON Schema）──
function jsonSchemaToZod(s) {
  if (!s || typeof s !== "object") return z.any();
  if (Array.isArray(s.enum) && s.enum.length) return z.enum(s.enum.map(String));
  const t = s.type;
  const desc = s.description;
  const withDesc = (field) => (desc ? field.describe(desc) : field);
  switch (t) {
    case "string": return withDesc(z.string());
    case "integer":
    case "number": return withDesc(z.number());
    case "boolean": return withDesc(z.boolean());
    case "array": return withDesc(z.array(jsonSchemaToZod(s.items ?? s.contains ?? {})));
    case "object": {
      const req = new Set(s.required ?? []);
      const shape = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const zv = jsonSchemaToZod(v);
        shape[k] = req.has(k) ? zv : zv.optional();
      }
      return withDesc(z.object(shape).passthrough());
    }
    default: return z.any();
  }
}

// ── 配置（全部走环境变量，不留硬编码凭据）──
const PORT = parseInt(process.env.IMA_WEB_PORT || "3001", 10);
const PUBLIC_BASE = (process.env.IMA_WEB_PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const OWNER_TOKEN = process.env.IMA_WEB_OWNER_TOKEN || "";
const STATE_DIR = process.env.IMA_WEB_STATE_DIR || process.env.HOME + "/.ima-web-mcp/.state";
const PYTHON_CMD = process.env.IMA_PYTHON_CMD || "python3";
const PYTHON_SCRIPT = process.env.IMA_PYTHON_SCRIPT || process.env.HOME + "/.ima-web-mcp/ima-mcp-server.py";
const ALLOWED_HOSTS = (process.env.IMA_WEB_ALLOWED_HOSTS || "").split(",").filter(Boolean);
const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
// Python 的 open_ima_login / refresh_ima_auth 写触发文件，桥接 fs.watch 到后拉起 ima-login.mjs
const IMA_TRIGGER_PATH = process.env.IMA_REFRESH_TRIGGER_PATH || path.join(os.homedir(), ".ima-web-mcp", ".ima_refresh_trigger");

const mcpUrl = new URL("/mcp", PUBLIC_BASE);
const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
const SCOPES = ["ima"];

// ── 内存 OAuth 工具 ──
function randomToken() { return randomBytes(32).toString("base64url"); }
function safeEquals(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}
function hashToken(t) { return createHash("sha256").update(t).digest("base64url"); }
function htmlEscape(v) {
  return String(v)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// ── 内存 Client Store（DCR）──
class MemoryClientsStore {
  constructor() { this.map = new Map(); }
  getClient(clientId) { return this.map.get(clientId); }
  registerClient(client) {
    // handler 已生成 client_id / client_id_issued_at；公开客户端 client_secret 为 undefined。
    // 不加自己的 secret，否则会把公开客户端当成需 secret 的机密客户端。
    this.map.set(client.client_id, client);
    return client;
  }
}

// ── 内存 Token Store ──
class MemoryTokenStore {
  constructor() { this.access = new Map(); this.refresh = new Map(); }
  saveTokenPair({ accessTokenHash, accessToken, refreshTokenHash, refreshToken }, _consumedRefreshTokenHash) {
    this.access.set(accessTokenHash, accessToken);
    this.refresh.set(refreshTokenHash, refreshToken);
    return true;
  }
  getAccessToken(hash) { return this.access.get(hash); }
  getRefreshToken(hash) { return this.refresh.get(hash); }
  deleteAccessToken(hash) { this.access.delete(hash); }
  deleteRefreshToken(hash) { this.refresh.delete(hash); }
  close() {}
}

// ── 单 Owner 密码 OAuth Provider（复刻 DevSpace SingleUserOAuthProvider，内存版）──
const CODE_TTL_MS = 5 * 60 * 1000;
class SingleUserOAuthProvider {
  constructor({ ownerToken, scopes, accessTokenTtlSeconds, refreshTokenTtlSeconds, allowedRedirectHosts, stateDir }, resourceServerUrl) {
    this.config = { ownerToken, scopes, accessTokenTtlSeconds, refreshTokenTtlSeconds, allowedRedirectHosts };
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    // 持久化（JSON 文件），重启不丢 client/token → 网页端不因重启失效
    const stores = createPersistentOAuthStores(stateDir);
    this.oauthStore = stores.tokenStore;
    this.clientsStore = stores.clientsStore;
    this.codes = new Map();
  }
  authorizeForm(params) {
    const scopeText = params.scopes.length > 0 ? params.scopes.join(" ") : "ima";
    const resourceText = params.resource?.href ?? "IMA MCP endpoint";
    const error = params.error ? `<p class="error">${htmlEscape(params.error)}</p>` : "";
    const hidden = Object.entries(params.fields).filter(([, v]) => v !== undefined)
      .map(([n, v]) => `<input type="hidden" name="${htmlEscape(n)}" value="${htmlEscape(v)}" />`).join("\n");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect IMA Knowledge Base</title><style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#0f172a;color:#e2e8f0}
main{max-width:440px;margin:12vh auto;padding:32px;background:#111827;border:1px solid #334155;border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.35)}
h1{margin:0 0 12px;font-size:28px}p{line-height:1.5;color:#cbd5e1}dl{padding:16px;background:#020617;border-radius:12px}
dt{color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:.06em}dd{margin:4px 0 12px;word-break:break-word}
label{display:block;margin:18px 0 8px;font-weight:600}input{box-sizing:border-box;width:100%;padding:12px 14px;border-radius:10px;border:1px solid #475569;background:#020617;color:#e2e8f0;font-size:16px}
button{margin-top:18px;width:100%;border:0;border-radius:10px;padding:12px 14px;font-weight:700;color:#020617;background:#38bdf8;cursor:pointer}
.error{color:#fecaca;background:#7f1d1d;border-radius:10px;padding:10px 12px}.warning{color:#fde68a}
</style></head><body><main>
<h1>Connect IMA Knowledge Base</h1>
<p class="warning">Only approve this if you are intentionally connecting the IMA knowledge base to your MCP client.</p>
${error}<dl><dt>Client</dt><dd>${htmlEscape(params.clientName)}</dd><dt>Scope</dt><dd>${htmlEscape(scopeText)}</dd><dt>Resource</dt><dd>${htmlEscape(resourceText)}</dd></dl>
<form method="post">${hidden}<label for="owner_token">Owner password</label><input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required /><button type="submit">Authorize IMA</button></form>
</main></body></html>`;
  }
  async authorize(client, params, res) {
    if (!params.resource || !checkResourceAllowed({ requestedResource: params.resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidRequestError("Invalid or missing OAuth resource");
    }
    if (!(params.scopes ?? []).every((s) => this.config.scopes.includes(s))) {
      throw new InvalidRequestError("Requested scope is not supported");
    }
    const fields = {
      response_type: "code", client_id: client.client_id, redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge, code_challenge_method: "S256",
      scope: params.scopes?.join(" "), state: params.state, resource: params.resource?.href,
    };
    if (res.req.method !== "POST") {
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(this.authorizeForm({ clientName: client.client_name ?? client.client_id, scopes: params.scopes ?? this.config.scopes, resource: params.resource, fields, error: "" }));
      return;
    }
    const provided = String(res.req.body?.owner_token ?? "");
    if (!this.config.ownerToken || !safeEquals(provided, this.config.ownerToken)) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(this.authorizeForm({ clientName: client.client_name ?? client.client_id, scopes: params.scopes ?? this.config.scopes, resource: params.resource, fields, error: "The Owner password was not accepted." }));
      return;
    }
    const code = `code-${randomUUID()}`;
    this.codes.set(code, { clientId: client.client_id, params, expiresAtMs: Date.now() + CODE_TTL_MS });
    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state !== undefined) redirectUrl.searchParams.set("state", params.state);
    res.redirect(302, redirectUrl.href);
  }
  async challengeForAuthorizationCode(client, authorizationCode) {
    const rec = this.validCode(client, authorizationCode);
    return rec.params.codeChallenge;
  }
  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const rec = this.validCode(client, code);
    if (redirectUri && redirectUri !== rec.params.redirectUri) throw new InvalidGrantError("redirect_uri does not match");
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) throw new InvalidGrantError("Invalid resource");
    this.codes.delete(code);
    return this.issueTokens(client.client_id, rec.params.scopes ?? this.config.scopes, rec.params.resource);
  }
  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const rec = this.oauthStore.getRefreshToken(hashToken(refreshToken));
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < Math.floor(Date.now() / 1000)) throw new InvalidGrantError("Invalid refresh token");
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) throw new InvalidGrantError("Invalid resource");
    const reqScopes = scopes ?? rec.scopes;
    if (!reqScopes.every((s) => rec.scopes.includes(s))) throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    return this.issueTokens(client.client_id, reqScopes, resource ?? (rec.resource ? new URL(rec.resource) : undefined));
  }
  async verifyAccessToken(token) {
    const rec = this.oauthStore.getAccessToken(hashToken(token));
    if (!rec || rec.expiresAt < Math.floor(Date.now() / 1000)) throw new InvalidTokenError("Invalid or expired access token");
    return { token, clientId: rec.clientId, scopes: rec.scopes, expiresAt: rec.expiresAt, resource: rec.resource ? new URL(rec.resource) : undefined };
  }
  async revokeToken(_client, request) {
    const h = hashToken(request.token);
    this.oauthStore.deleteAccessToken(h);
    this.oauthStore.deleteRefreshToken(h);
  }
  issueTokens(clientId, scopes, resource) {
    const now = Math.floor(Date.now() / 1000);
    const at = randomToken(), rt = randomToken();
    const atExp = now + this.config.accessTokenTtlSeconds, rtExp = now + this.config.refreshTokenTtlSeconds;
    this.oauthStore.saveTokenPair({
      accessTokenHash: hashToken(at),
      accessToken: { clientId, scopes, expiresAt: atExp, resource: resource?.href },
      refreshTokenHash: hashToken(rt),
      refreshToken: { clientId, scopes, expiresAt: rtExp, resource: resource?.href },
    });
    return { access_token: at, token_type: "bearer", expires_in: this.config.accessTokenTtlSeconds, refresh_token: rt, scope: scopes.join(" ") };
  }
  validCode(client, authorizationCode) {
    const rec = this.codes.get(authorizationCode);
    if (!rec || rec.clientId !== client.client_id || rec.expiresAtMs < Date.now()) throw new InvalidGrantError("Invalid authorization code");
    return rec;
  }
  close() { this.oauthStore.close(); }
}

// ── 会话注册（避免残留连接堆积）──
const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
class McpSessionRegistry {
  constructor() { this.transports = new Map(); }
  get(id) { return this.transports.get(id); }
  register(id, transport) {
    transport.lastActiveAt = Date.now();
    this.transports.set(id, transport);
  }
  remove(id) { this.transports.delete(id); }
  closeIdle() {
    const now = Date.now();
    for (const [id, t] of this.transports) {
      const last = t.lastActiveAt ?? now;
      if (now - last > MCP_SESSION_IDLE_TIMEOUT_MS) {
        try { t.close(); } catch {}
        this.transports.delete(id);
      }
    }
    return [];
  }
}

// ── IMA 登录触发：python 的 open_ima_login / refresh_ima_auth 写触发文件，这里 watch 到后拉起登录脚本 ──
function setupImaLoginWatcher() {
  try {
    if (!existsSync(IMA_TRIGGER_PATH)) writeFileSync(IMA_TRIGGER_PATH, "{}");
  } catch {}
  let last = 0;
  watch(IMA_TRIGGER_PATH, () => {
    try {
      const d = JSON.parse(readFileSync(IMA_TRIGGER_PATH, "utf8"));
      if (Date.now() - last < 1500) return; // 防抖
      last = Date.now();
      const action = d.action || "refresh";
      console.log(`[ima-web-mcp] ima login trigger: ${action}`);
      if (action === "login" || action === "refresh") {
        const child = spawn("node", [path.join(BRIDGE_DIR, "ima-login.mjs")], { detached: true, stdio: "ignore" });
        child.unref();
      }
    } catch {}
  });
  console.log(`[ima-web-mcp] IMA login watcher on ${IMA_TRIGGER_PATH}`);
}

// ── 组装 ──
export async function createServer() {
  const { pathToFileURL } = await import("node:url");
  const scriptUrl = pathToFileURL(PYTHON_SCRIPT).href;

  // 1) 连接 Python IMA MCP（子进程，stdio）
  const childEnv = {
    ...process.env,
    IMA_CREDS_FILE: process.env.IMA_CREDS_FILE || "",
    IMA_REFRESH_TRIGGER_PATH: IMA_TRIGGER_PATH,
    IMA_OPENAPI_CLIENTID: process.env.IMA_OPENAPI_CLIENTID || "",
    IMA_OPENAPI_APIKEY: process.env.IMA_OPENAPI_APIKEY || "",
    IMA_X_IMA_COOKIE: process.env.IMA_X_IMA_COOKIE || "",
    IMA_X_IMA_BKN: process.env.IMA_X_IMA_BKN || "",
  };
  // 清除未赋值项，避免传空串干扰 python 内部的 os.environ.get 判断
  for (const k of Object.keys(childEnv)) {
    if ((k.startsWith("IMA_") || k.startsWith("OPENAPI_")) && (childEnv[k] === "" || childEnv[k] === undefined)) {
      delete childEnv[k];
    }
  }
  const transport = new StdioClientTransport({ command: PYTHON_CMD, args: [PYTHON_SCRIPT], env: childEnv });
  const client = new Client({ name: "ima-web-bridge", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();

  // 2) 预计算工具注册信息；每个 session initialize 时新建一个 McpServer 再注册
  //    （McpServer 只能 connect 一个 transport，不能跨 session 复用）
  const toolRegs = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: jsonSchemaToZod(t.inputSchema),
  }));
  const makeServer = () => {
    const s = new McpServer({ name: "ima-knowledge-base", version: "1.0.0" });
    for (const reg of toolRegs) {
      s.registerTool(reg.name, { description: reg.description, inputSchema: reg.inputSchema }, async (args) => {
        const r = await client.callTool({ name: reg.name, arguments: args ?? {} });
        return { content: r.content ?? [], isError: r.isError ?? false };
      });
    }
    return s;
  };

  // 3) Express + OAuth
  const allowedHosts = ALLOWED_HOSTS.length ? ALLOWED_HOSTS : undefined;
  const app = createMcpExpressApp({ host: "localhost", ...(allowedHosts ? { allowedHosts } : {}) });
  // 隧道(Cloudflare)会加 X-Forwarded-For；必须设 trust proxy 为【1】(信任一台代理/Cloudflare)。
  // 设成 true 会被 express-rate-limit v7 判为 PERMISSIVE 而抛错(ERR_ERL_PERMISSIVE_TRUST_PROXY)→502。
  app.set("trust proxy", 1);
  const oauthProvider = new SingleUserOAuthProvider({
    ownerToken: OWNER_TOKEN,
    scopes: SCOPES,
    accessTokenTtlSeconds: 60 * 60 * 24,
    refreshTokenTtlSeconds: 60 * 60 * 24 * 30,
    allowedRedirectHosts: [],
    stateDir: path.join(os.homedir(), ".ima-web-mcp", ".state-ima"),
  }, mcpUrl);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [SCOPES[0]],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });

  // 自定义 /authorize：ChatGPT 会复用旧的 client_id 而不重新 DCR（0d35dd2f 就是因此 lost）。
  // 这里直接自动注册并放行任何 client —— 真正的鉴权门槛是 owner 密码，自动放行不影响安全。
  const formBody = express.urlencoded({ extended: false });
  const handleAuthorize = async (req, res) => {
    const b = req.body ?? {};
    const q = req.query ?? {};
    const clientId = q.client_id ?? b.client_id;
    const redirectUri = q.redirect_uri ?? b.redirect_uri;
    if (!clientId || !redirectUri) {
      return res.status(400).json({ error: "invalid_request", error_description: "client_id and redirect_uri are required" });
    }
    // 自动注册并持久化该 client（公开客户端，无 secret）
    oauthProvider.clientsStore.registerClient({
      client_id: clientId,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      client_secret: undefined,
      client_secret_expires_at: undefined,
      client_name: b.client_name || "auto",
    });
    const resourceVal = q.resource ?? b.resource;
    const params = {
      redirectUri,
      codeChallenge: q.code_challenge ?? b.code_challenge,
      scopes: [q.scope ?? b.scope ?? SCOPES[0]],
      resource: resourceVal ? new URL(resourceVal) : resourceServerUrl,
      state: q.state ?? b.state,
    };
    await oauthProvider.authorize({ client_id: clientId, redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }, params, res);
  };
  app.get("/authorize", handleAuthorize);
  app.post("/authorize", formBody, handleAuthorize);

  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(PUBLIC_BASE),
    baseUrl: new URL(PUBLIC_BASE),
    resourceServerUrl,
    scopesSupported: SCOPES,
    resourceName: "IMA Knowledge Base",
  }));

  app.get("/healthz", (_req, res) => res.json({ ok: true, name: "ima-knowledge-base" }));

  const transports = new McpSessionRegistry();
  const timer = setInterval(() => { try { transports.closeIdle(); } catch {} }, MCP_SESSION_CLEANUP_INTERVAL_MS);
  timer.unref();

  app.all("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
    await new Promise((resolve, reject) => bearerAuth(req, res, (e) => (e ? reject(e) : resolve())));
    if (res.headersSent) return;
    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      return void res.status(401).send({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } });
    }
    let t;
    if (sessionId) {
      t = transports.get(sessionId);
      if (!t) return void res.status(404).send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Unknown MCP session" } });
    } else if (initializeRequest) {
      t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.register(id, t),
      });
      t.onclose = () => { if (t?.sessionId) transports.remove(t.sessionId); };
      const server = makeServer();
      await server.connect(t);
    } else {
      return void res.status(400).send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "No valid MCP session" } });
    }
    await t.handleRequest(req, res, req.body);
  });

  const httpServer = app.listen(PORT, () => {
    console.log(`[ima-web-mcp] listening on ${PORT}`);
    console.log(`[ima-web-mcp] public: ${PUBLIC_BASE}/mcp`);
    console.log(`[ima-web-mcp] tools bridged: ${tools.map((x) => x.name).join(", ")}`);
  });
  setupImaLoginWatcher();
  return { httpServer, client, oauthProvider };
}

// 启动
createServer().catch((e) => { console.error("[ima-web-mcp] startup failed:", e); process.exit(1); });
