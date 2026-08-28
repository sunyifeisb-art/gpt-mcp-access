#!/usr/bin/env node
/**
 * 元典开放平台 MCP → 远程 HTTP + OAuth 桥接
 *
 * 元典是 4 个远程 streamable-http MCP（law/case/company/securities），
 * 用 Bearer token 鉴权。这里把它们聚合进【一个】OAuth 保护的 MCP 端点，
 * 供 ChatGPT 网页端添加。无登录、无 cookie、无每日领取。
 *
 * 工具名加 "<服务>__" 前缀避免跨服务重名。
 * 认证：复刻 DevSpace 的 SingleUserOAuthProvider（内存版），和 IMA bridge 一致。
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
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import * as z from "zod";
import os from "node:os";
import path from "node:path";
import { createPersistentOAuthStores } from "./state-store.mjs";

// ── 配置 ──
const PORT = parseInt(process.env.YD_WEB_PORT || "3002", 10);
const PUBLIC_BASE = (process.env.YD_WEB_PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const OWNER_TOKEN = process.env.YD_WEB_OWNER_TOKEN || "";
const ALLOWED_HOSTS = (process.env.YD_WEB_ALLOWED_HOSTS || "").split(",").filter(Boolean);
const YD_TOKEN = process.env.YUANDIAN_API_KEY || "";
const BASE = "https://open.chineselaw.com/mcp";

const SERVICES = [
  { id: "law", url: `${BASE}/law/stream` },
  { id: "case", url: `${BASE}/case/stream` },
  { id: "company", url: `${BASE}/company/stream` },
  { id: "securities", url: `${BASE}/securities/stream` },
];
const RESOURCE_NAME = "Yuandian";

const mcpUrl = new URL("/mcp", PUBLIC_BASE);
const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
const SCOPES = ["yuandian"];

// ── 内存 OAuth（同 IMA bridge）──
function randomToken() { return randomBytes(32).toString("base64url"); }
function safeEquals(a, b) { const l = Buffer.from(String(a ?? "")), r = Buffer.from(String(b ?? "")); return l.byteLength === r.byteLength && timingSafeEqual(l, r); }
function hashToken(t) { return createHash("sha256").update(t).digest("base64url"); }
function htmlEscape(v) { return String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }

class MemoryClientsStore { constructor() { this.map = new Map(); } getClient(id) { return this.map.get(id); } registerClient(c) { this.map.set(c.client_id, c); return c; } }
class MemoryTokenStore { constructor() { this.access = new Map(); this.refresh = new Map(); } saveTokenPair({ accessTokenHash, accessToken, refreshTokenHash, refreshToken }) { this.access.set(accessTokenHash, accessToken); this.refresh.set(refreshTokenHash, refreshToken); return true; } getAccessToken(h) { return this.access.get(h); } getRefreshToken(h) { return this.refresh.get(h); } deleteAccessToken(h) { this.access.delete(h); } deleteRefreshToken(h) { this.refresh.delete(h); } close() {} }

const CODE_TTL_MS = 5 * 60 * 1000;
class SingleUserOAuthProvider {
  constructor({ ownerToken, scopes, accessTokenTtlSeconds, refreshTokenTtlSeconds, stateDir }, resourceServerUrl) {
    this.config = { ownerToken, scopes, accessTokenTtlSeconds, refreshTokenTtlSeconds };
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    // 持久化（JSON），重启不丢 client/token
    const stores = createPersistentOAuthStores(stateDir);
    this.oauthStore = stores.tokenStore;
    this.clientsStore = stores.clientsStore;
    this.codes = new Map();
  }
  authorizeForm(params) {
    const scopeText = (params.scopes.length ? params.scopes : ["yuandian"]).join(" ");
    const resourceText = params.resource?.href ?? "Yuandian MCP endpoint";
    const error = params.error ? `<p class="error">${htmlEscape(params.error)}</p>` : "";
    const hidden = Object.entries(params.fields).filter(([, v]) => v !== undefined).map(([n, v]) => `<input type="hidden" name="${htmlEscape(n)}" value="${htmlEscape(v)}" />`).join("\n");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Yuandian</title><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#0f172a;color:#e2e8f0}main{max-width:440px;margin:12vh auto;padding:32px;background:#111827;border:1px solid #334155;border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.35)}h1{margin:0 0 12px;font-size:28px}p{line-height:1.5;color:#cbd5e1}dl{padding:16px;background:#020617;border-radius:12px}dt{color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:.06em}dd{margin:4px 0 12px;word-break:break-word}label{display:block;margin:18px 0 8px;font-weight:600}input{box-sizing:border-box;width:100%;padding:12px 14px;border-radius:10px;border:1px solid #475569;background:#020617;color:#e2e8f0;font-size:16px}button{margin-top:18px;width:100%;border:0;border-radius:10px;padding:12px 14px;font-weight:700;color:#020617;background:#38bdf8;cursor:pointer}.error{color:#fecaca;background:#7f1d1d;border-radius:10px;padding:10px 12px}.warning{color:#fde68a}</style></head><body><main><h1>Connect Yuandian</h1><p class="warning">Only approve this if you are intentionally connecting Yuandian MCP to your MCP client.</p>${error}<dl><dt>Client</dt><dd>${htmlEscape(params.clientName)}</dd><dt>Scope</dt><dd>${htmlEscape(scopeText)}</dd><dt>Resource</dt><dd>${htmlEscape(resourceText)}</dd></dl><form method="post">${hidden}<label for="owner_token">Owner password</label><input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required /><button type="submit">Authorize Yuandian</button></form></main></body></html>`;
  }
  async authorize(client, params, res) {
    if (!params.resource || !checkResourceAllowed({ requestedResource: params.resource, configuredResource: this.resourceServerUrl })) throw new InvalidRequestError("Invalid or missing OAuth resource");
    if (!(params.scopes ?? []).every((s) => this.config.scopes.includes(s))) throw new InvalidRequestError("Requested scope not supported");
    const fields = { response_type: "code", client_id: client.client_id, redirect_uri: params.redirectUri, code_challenge: params.codeChallenge, code_challenge_method: "S256", scope: params.scopes?.join(" "), state: params.state, resource: params.resource?.href };
    if (res.req.method !== "POST") { res.status(200).setHeader("Content-Type", "text/html; charset=utf-8"); res.send(this.authorizeForm({ clientName: client.client_name ?? client.client_id, scopes: params.scopes ?? this.config.scopes, resource: params.resource, fields, error: "" })); return; }
    if (!this.config.ownerToken || !safeEquals(String(res.req.body?.owner_token ?? ""), this.config.ownerToken)) { res.status(401).setHeader("Content-Type", "text/html; charset=utf-8"); res.send(this.authorizeForm({ clientName: client.client_name ?? client.client_id, scopes: params.scopes ?? this.config.scopes, resource: params.resource, fields, error: "The Owner password was not accepted." })); return; }
    const code = `code-${randomUUID()}`; this.codes.set(code, { clientId: client.client_id, params, expiresAtMs: Date.now() + CODE_TTL_MS });
    const redirectUrl = new URL(params.redirectUri); redirectUrl.searchParams.set("code", code); if (params.state !== undefined) redirectUrl.searchParams.set("state", params.state); res.redirect(302, redirectUrl.href);
  }
  async challengeForAuthorizationCode(client, code) { return this.validCode(client, code).params.codeChallenge; }
  async exchangeAuthorizationCode(client, code, _v, redirectUri, resource) { const rec = this.validCode(client, code); if (redirectUri && redirectUri !== rec.params.redirectUri) throw new InvalidGrantError("redirect_uri mismatch"); if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) throw new InvalidGrantError("Invalid resource"); this.codes.delete(code); return this.issueTokens(client.client_id, rec.params.scopes ?? this.config.scopes, rec.params.resource); }
  async exchangeRefreshToken(client, refreshToken, scopes, resource) { const rec = this.oauthStore.getRefreshToken(hashToken(refreshToken)); if (!rec || rec.clientId !== client.client_id || rec.expiresAt < Math.floor(Date.now() / 1000)) throw new InvalidGrantError("Invalid refresh token"); if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) throw new InvalidGrantError("Invalid resource"); const req = scopes ?? rec.scopes; if (!req.every((s) => rec.scopes.includes(s))) throw new AccessDeniedError("Scope not allowed"); return this.issueTokens(client.client_id, req, resource ?? (rec.resource ? new URL(rec.resource) : undefined)); }
  async verifyAccessToken(token) { const rec = this.oauthStore.getAccessToken(hashToken(token)); if (!rec || rec.expiresAt < Math.floor(Date.now() / 1000)) throw new InvalidTokenError("Invalid or expired access token"); return { token, clientId: rec.clientId, scopes: rec.scopes, expiresAt: rec.expiresAt, resource: rec.resource ? new URL(rec.resource) : undefined }; }
  async revokeToken(_c, request) { const h = hashToken(request.token); this.oauthStore.deleteAccessToken(h); this.oauthStore.deleteRefreshToken(h); }
  issueTokens(clientId, scopes, resource) { const now = Math.floor(Date.now() / 1000); const at = randomToken(), rt = randomToken(), atExp = now + this.config.accessTokenTtlSeconds, rtExp = now + this.config.refreshTokenTtlSeconds; this.oauthStore.saveTokenPair({ accessTokenHash: hashToken(at), accessToken: { clientId, scopes, expiresAt: atExp, resource: resource?.href }, refreshTokenHash: hashToken(rt), refreshToken: { clientId, scopes, expiresAt: rtExp, resource: resource?.href } }); return { access_token: at, token_type: "bearer", expires_in: this.config.accessTokenTtlSeconds, refresh_token: rt, scope: scopes.join(" ") }; }
  validCode(client, authorizationCode) { const rec = this.codes.get(authorizationCode); if (!rec || rec.clientId !== client.client_id || rec.expiresAtMs < Date.now()) throw new InvalidGrantError("Invalid authorization code"); return rec; }
  close() { this.oauthStore.close(); }
}

// ── JSON Schema → Zod ──
function jsonSchemaToZod(s) {
  if (!s || typeof s !== "object") return z.any();
  if (Array.isArray(s.enum) && s.enum.length) return z.enum(s.enum.map(String));
  const t = s.type, desc = s.description;
  const d = (f) => (desc ? f.describe(desc) : f);
  switch (t) {
    case "string": return d(z.string());
    case "integer": case "number": return d(z.number());
    case "boolean": return d(z.boolean());
    case "array": return d(z.array(jsonSchemaToZod(s.items ?? s.contains ?? {})));
    case "object": { const req = new Set(s.required ?? []); const shape = {}; for (const [k, v] of Object.entries(s.properties ?? {})) { const zv = jsonSchemaToZod(v); shape[k] = req.has(k) ? zv : zv.optional(); } return d(z.object(shape).passthrough()); }
    default: return z.any();
  }
}

// ── 会话注册 ──
const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
class McpSessionRegistry { constructor() { this.t = new Map(); } get(id) { return this.t.get(id); } register(id, tr) { tr.last = Date.now(); this.t.set(id, tr); } remove(id) { this.t.delete(id); } closeIdle() { for (const [id, tr] of this.t) { if (Date.now() - (tr.last ?? Date.now()) > MCP_SESSION_IDLE_TIMEOUT_MS) { try { tr.close(); } catch {} this.t.delete(id); } } return []; } }

export async function createServer() {
  if (!YD_TOKEN) throw new Error("YUANDIAN_API_KEY not set");
  // 1) 连接 4 个上游，聚合工具
  const clients = [];
  const regs = [];
  for (const svc of SERVICES) {
    const transport = new StreamableHTTPClientTransport(new URL(svc.url), {
      requestInit: { headers: { Authorization: `Bearer ${YD_TOKEN}`, Accept: "application/json, text/event-stream" } },
    });
    const c = new Client({ name: `yuandian-${svc.id}`, version: "1.0.0" });
    await c.connect(transport);
    const { tools } = await c.listTools();
    clients.push(c);
    for (const t of tools) {
      regs.push({ name: `${svc.id}__${t.name}`, description: t.description ?? "", inputSchema: jsonSchemaToZod(t.inputSchema), client: c, upstream: t.name });
    }
  }
  const makeServer = () => {
    const s = new McpServer({ name: "yuandian", version: "1.0.0" });
    for (const reg of regs) {
      s.registerTool(reg.name, { description: reg.description, inputSchema: reg.inputSchema }, async (args) => {
        const r = await reg.client.callTool({ name: reg.upstream, arguments: args ?? {} });
        return { content: r.content ?? [], isError: r.isError ?? false };
      });
    }
    return s;
  };

  // 2) Express + OAuth
  const app = createMcpExpressApp({ host: "localhost", ...(ALLOWED_HOSTS.length ? { allowedHosts: ALLOWED_HOSTS } : {}) });
  app.set("trust proxy", 1); // 信任 Cloudflare 一跳；true 会被 express-rate-limit v7 拒绝(ERR_ERL_PERMISSIVE_TRUST_PROXY)
  const oauthProvider = new SingleUserOAuthProvider({ ownerToken: OWNER_TOKEN, scopes: SCOPES, accessTokenTtlSeconds: 60 * 60 * 24, refreshTokenTtlSeconds: 60 * 60 * 24 * 30, stateDir: path.join(os.homedir(), ".ima-web-mcp", ".state-yuandian") }, mcpUrl);
  const bearerAuth = requireBearerAuth({ verifier: oauthProvider, requiredScopes: [SCOPES[0]], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl) });

  // 自定义 /authorize：ChatGPT 复用旧 client_id 时不重新 DCR，这里自动放行（owner 密码才是真门槛）
  const formBody = express.urlencoded({ extended: false });
  const handleAuthorize = async (req, res) => {
    const b = req.body ?? {}, q = req.query ?? {};
    const clientId = q.client_id ?? b.client_id, redirectUri = q.redirect_uri ?? b.redirect_uri;
    if (!clientId || !redirectUri) return res.status(400).json({ error: "invalid_request", error_description: "client_id and redirect_uri are required" });
    oauthProvider.clientsStore.registerClient({ client_id: clientId, redirect_uris: [redirectUri], token_endpoint_auth_method: "none", client_secret: undefined, client_secret_expires_at: undefined, client_name: b.client_name || "auto" });
    const resourceVal = q.resource ?? b.resource;
    const params = { redirectUri, codeChallenge: q.code_challenge ?? b.code_challenge, scopes: [q.scope ?? b.scope ?? SCOPES[0]], resource: resourceVal ? new URL(resourceVal) : resourceServerUrl, state: q.state ?? b.state };
    await oauthProvider.authorize({ client_id: clientId, redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }, params, res);
  };
  app.get("/authorize", handleAuthorize);
  app.post("/authorize", formBody, handleAuthorize);

  app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl: new URL(PUBLIC_BASE), baseUrl: new URL(PUBLIC_BASE), resourceServerUrl, scopesSupported: SCOPES, resourceName: RESOURCE_NAME }));
  app.get("/healthz", (_req, res) => res.json({ ok: true, name: "yuandian" }));

  const transports = new McpSessionRegistry();
  const timer = setInterval(() => { try { transports.closeIdle(); } catch {} }, 5 * 60 * 1000); timer.unref();

  app.all("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
    await new Promise((resolve, reject) => bearerAuth(req, res, (e) => (e ? reject(e) : resolve())));
    if (res.headersSent) return;
    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) return void res.status(401).send({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } });
    let t;
    if (sessionId) { t = transports.get(sessionId); if (!t) return void res.status(404).send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Unknown MCP session" } }); }
    else if (initializeRequest) { t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => transports.register(id, t) }); t.onclose = () => { if (t?.sessionId) transports.remove(t.sessionId); }; await makeServer().connect(t); }
    else return void res.status(400).send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "No valid MCP session" } });
    await t.handleRequest(req, res, req.body);
  });

  const httpServer = app.listen(PORT, () => { console.log(`[yuandian] listening on ${PORT}`); console.log(`[yuandian] public: ${PUBLIC_BASE}/mcp`); console.log(`[yuandian] tools: ${regs.length}`); });
  return { httpServer, clients, oauthProvider };
}

createServer().catch((e) => { console.error("[yuandian] startup failed:", e); process.exit(1); });
