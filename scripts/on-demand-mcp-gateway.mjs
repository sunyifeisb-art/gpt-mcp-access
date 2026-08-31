#!/usr/bin/env node
/**
 * Keep a tiny loopback HTTP gateway alive while starting the real MCP backend
 * only when /mcp is requested. The managed backend is stopped after an idle
 * timeout once there are no active requests/SSE streams.
 *
 * Required environment variables:
 *   MCP_GATEWAY_NAME
 *   MCP_GATEWAY_LISTEN_PORT
 *   MCP_UPSTREAM_PORT
 *   MCP_BACKEND_SCRIPT
 *
 * Optional:
 *   MCP_GATEWAY_LISTEN_HOST=127.0.0.1
 *   MCP_UPSTREAM_HOST=127.0.0.1
 *   MCP_UPSTREAM_HEALTH_PATH=/healthz
 *   MCP_UPSTREAM_BEARER_TOKEN=...
 *   MCP_IDLE_MS=300000
 *   MCP_STARTUP_MS=45000
 *   MCP_BACKEND_LOG=/tmp/<name>-backend.log
 *
 * Optional OAuth-state bootstrap (all fields must be set together):
 *   MCP_OAUTH_STATE_FILE
 *   MCP_OAUTH_CLIENT_ID
 *   MCP_OAUTH_SCOPE
 *   MCP_OAUTH_RESOURCE
 *   MCP_UPSTREAM_BEARER_TOKEN
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

const name = required("MCP_GATEWAY_NAME");
const listenHost = process.env.MCP_GATEWAY_LISTEN_HOST || "127.0.0.1";
const listenPort = portValue("MCP_GATEWAY_LISTEN_PORT");
const upstreamHost = process.env.MCP_UPSTREAM_HOST || "127.0.0.1";
const upstreamPort = portValue("MCP_UPSTREAM_PORT");
const upstreamHealthPath = process.env.MCP_UPSTREAM_HEALTH_PATH || "/healthz";
const backendScript = required("MCP_BACKEND_SCRIPT");
const upstreamToken = process.env.MCP_UPSTREAM_BEARER_TOKEN?.trim() || "";
const idleMs = positiveNumber("MCP_IDLE_MS", 5 * 60 * 1000);
const startupMs = positiveNumber("MCP_STARTUP_MS", 45 * 1000);
const backendLog = process.env.MCP_BACKEND_LOG || `/tmp/${name}-backend.log`;

let child = null;
let starting = null;
let stopping = null;
let activeRequests = 0;
let lastActivityAt = 0;

installOptionalCredential();

function required(key) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function portValue(key) {
  const value = Number(required(key));
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${key} must be a valid TCP port`);
  }
  return value;
}

function positiveNumber(key, fallback) {
  const value = Number(process.env[key] || fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return value;
}

function installOptionalCredential() {
  const stateFile = process.env.MCP_OAUTH_STATE_FILE?.trim();
  const clientId = process.env.MCP_OAUTH_CLIENT_ID?.trim();
  const scope = process.env.MCP_OAUTH_SCOPE?.trim();
  const resource = process.env.MCP_OAUTH_RESOURCE?.trim();
  const values = [stateFile, clientId, scope, resource, upstreamToken];

  if (values.every(Boolean)) {
    const data = JSON.parse(readFileSync(stateFile, "utf8"));
    data.clients ??= {};
    data.access ??= {};
    data.refresh ??= {};
    data.clients[clientId] = {
      client_id: clientId,
      client_name: `OpenAI on-demand gateway (${name})`,
      redirect_uris: ["http://127.0.0.1"],
      token_endpoint_auth_method: "none",
    };
    const tokenHash = createHash("sha256").update(upstreamToken).digest("base64url");
    data.access[tokenHash] = {
      clientId,
      scopes: [scope],
      expiresAt: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 60 * 60,
      resource,
    };
    const temporary = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, stateFile);
    chmodSync(stateFile, 0o600);
    return;
  }

  if (values.some(Boolean) && [stateFile, clientId, scope, resource].some(Boolean)) {
    throw new Error(
      "OAuth-state bootstrap requires MCP_OAUTH_STATE_FILE, MCP_OAUTH_CLIENT_ID, " +
      "MCP_OAUTH_SCOPE, MCP_OAUTH_RESOURCE, and MCP_UPSTREAM_BEARER_TOKEN together",
    );
  }
}

async function backendHealthy() {
  try {
    const response = await fetch(
      `http://${upstreamHost}:${upstreamPort}${upstreamHealthPath}`,
      { signal: AbortSignal.timeout(1000) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureBackend() {
  if (await backendHealthy()) return;
  if (starting) return starting;
  if (stopping) await stopping;

  starting = (async () => {
    const logFd = openSync(backendLog, "a", 0o600);
    try {
      child = spawn("/bin/bash", [backendScript], {
        detached: true,
        env: process.env,
        stdio: ["ignore", logFd, logFd],
      });
    } finally {
      closeSync(logFd);
    }

    child.once("exit", (code, signal) => {
      console.log(`${name} backend exited code=${code ?? ""} signal=${signal ?? ""}`);
      child = null;
    });

    const deadline = Date.now() + startupMs;
    while (Date.now() < deadline) {
      if (await backendHealthy()) {
        lastActivityAt = Date.now();
        console.log(`${name} backend started pid=${child?.pid ?? "unknown"}`);
        return;
      }
      if (!child) throw new Error(`${name} backend exited during startup`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await stopBackend("startup timeout");
    throw new Error(`${name} backend did not become healthy within ${startupMs}ms`);
  })().finally(() => {
    starting = null;
  });
  return starting;
}

async function stopBackend(reason) {
  if (stopping) return stopping;
  if (!child?.pid) return;
  const target = child;
  stopping = (async () => {
    console.log(`stopping ${name} backend pid=${target.pid}: ${reason}`);
    try { process.kill(-target.pid, "SIGTERM"); } catch {}
    const exited = new Promise((resolve) => target.once("exit", resolve));
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (child?.pid === target.pid) {
      try { process.kill(-target.pid, "SIGKILL"); } catch {}
      child = null;
    }
  })().finally(() => {
    stopping = null;
  });
  return stopping;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${listenHost}:${listenPort}`);

  if (url.pathname === "/healthz" || url.pathname === "/readyz") {
    sendJson(response, 200, {
      ok: true,
      name: `${name}-on-demand-gateway`,
      backend: child ? "running" : "stopped",
      activeRequests,
      idleSeconds: Math.floor(idleMs / 1000),
    });
    return;
  }

  // Hiding metadata makes a no-auth local target explicit. If your target truly
  // implements OAuth/DCR, route those endpoints deliberately instead.
  if (url.pathname.startsWith("/.well-known/") || url.pathname === "/") {
    response.writeHead(404);
    response.end();
    return;
  }
  if (url.pathname !== "/mcp") {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  activeRequests += 1;
  lastActivityAt = Date.now();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    activeRequests = Math.max(0, activeRequests - 1);
    lastActivityAt = Date.now();
  };
  response.once("close", finish);
  response.once("finish", finish);

  try {
    await ensureBackend();
  } catch (error) {
    finish();
    sendJson(response, 502, { error: "backend_start_failed", message: error.message });
    return;
  }

  const headers = { ...request.headers };
  headers.host = `${upstreamHost}:${upstreamPort}`;
  if (upstreamToken) headers.authorization = `Bearer ${upstreamToken}`;

  const upstream = http.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    finish();
    if (!response.headersSent) {
      sendJson(response, 502, { error: "upstream_unavailable", message: error.message });
    } else {
      response.end();
    }
  });
  request.pipe(upstream);
});

const idleTimer = setInterval(async () => {
  if (!child || starting || stopping || activeRequests > 0 || lastActivityAt === 0) return;
  if (Date.now() - lastActivityAt >= idleMs) {
    await stopBackend(`${Math.floor(idleMs / 1000)}s idle`);
  }
}, Math.min(5000, Math.max(250, Math.floor(idleMs / 4))));
idleTimer.unref();

server.listen(listenPort, listenHost, () => {
  console.log(`${name} on-demand gateway listening on http://${listenHost}:${listenPort}/mcp`);
});

async function shutdown() {
  clearInterval(idleTimer);
  server.close();
  await stopBackend("gateway shutdown");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
