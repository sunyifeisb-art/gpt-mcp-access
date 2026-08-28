// 模拟 ChatGPT 复用旧 client（不做 DCR 注册），走 auto-authorize → token → mcp
import { createHash, randomBytes } from "node:crypto";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";

const BASE = "http://127.0.0.1:3001";
const PUBLIC = "https://ima.bytelegal.cn";
const OWNER = process.env.IMA_WEB_OWNER_TOKEN || "test";
const CLIENT_ID = "0d35dd2f-19c5-40ef-aaaa-bbbbccccdddd"; // 未知 client，走自动放行
const mcpUrl = new URL("/mcp", PUBLIC);
const resource = resourceUrlFromServerUrl(mcpUrl);
const code_verifier = randomBytes(32).toString("base64url");
const code_challenge = createHash("sha256").update(code_verifier).digest("base64url");
const MCP_ACCEPT = "application/json, text/event-stream";
const REDIRECT = "http://127.0.0.1/callback";
let TOKEN = "";
const auth = () => `Bearer ${TOKEN}`;

async function readMcp(res) {
  const t = await res.text();
  if (t.includes("data:")) return JSON.parse(t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""));
  return JSON.parse(t);
}

// 1) GET /authorize（未知 client）
const a = new URL(`${BASE}/authorize`);
for (const [k, v] of Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge, code_challenge_method: "S256", scope: "ima", resource })) a.searchParams.set(k, v);
let r = await fetch(a, { redirect: "manual" });
console.log("[authorize GET]", r.status, (await r.text()).includes("Owner password") ? "✓表单" : "！非表单");
if (r.status !== 200) process.exit(1);

// 2) POST /authorize（owner 密码）→ code
const form = new URLSearchParams();
for (const [k, v] of Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge, code_challenge_method: "S256", scope: "ima", resource, owner_token: OWNER })) form.set(k, v);
r = await fetch(`${BASE}/authorize`, { method: "POST", body: form, redirect: "manual" });
const code = new URL(r.headers.get("location")).searchParams.get("code");
console.log("[authorize POST]", r.status, "code?", !!code);
if (!code) process.exit(1);

// 3) token
r = await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier }) });
const tok = await r.json();
console.log("[token]", r.status, "access_token?", !!tok.access_token);
TOKEN = tok.access_token;
if (!TOKEN) { console.error(JSON.stringify(tok)); process.exit(1); }

// 4) /mcp initialize + tools
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" }, resource } };
r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: auth(), accept: MCP_ACCEPT }, body: JSON.stringify(init) });
const sid = r.headers.get("mcp-session-id");
const ij = await readMcp(r);
console.log("[initialize]", r.status, "server:", ij.result?.serverInfo?.name, "sid:", !!sid);
const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: auth(), accept: MCP_ACCEPT, "mcp-session-id": sid }, body: JSON.stringify(list) });
const lj = await readMcp(r);
console.log("[tools/list]", r.status, "count:", lj.result?.tools?.length);
console.log("auto-authorize 全链路通过 ✅（未知 client 也能授权）");
