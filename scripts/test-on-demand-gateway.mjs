#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = mkdtempSync(join(tmpdir(), "gpt-mcp-access-test-"));
const gatewayPort = 32181;
const backendPort = 32182;
const mock = join(root, "mock-backend.mjs");
const starter = join(root, "start-backend.sh");
const gateway = new URL("./on-demand-mcp-gateway.mjs", import.meta.url).pathname;

writeFileSync(mock, `
  import http from "node:http";
  const port = Number(process.env.TEST_BACKEND_PORT);
  http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, {"content-type":"application/json"});
      return res.end('{"ok":true}');
    }
    if (req.url === "/mcp") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        res.writeHead(200, {"content-type":"application/json"});
        res.end(body || "{}");
      });
      return;
    }
    res.writeHead(404); res.end();
  }).listen(port, "127.0.0.1");
`);
writeFileSync(starter, `#!/bin/bash\nexec "${process.execPath}" "${mock}"\n`, { mode: 0o700 });

const child = spawn(process.execPath, [gateway], {
  env: {
    ...process.env,
    MCP_GATEWAY_NAME: "selftest",
    MCP_GATEWAY_LISTEN_PORT: String(gatewayPort),
    MCP_UPSTREAM_PORT: String(backendPort),
    MCP_BACKEND_SCRIPT: starter,
    MCP_IDLE_MS: "1200",
    MCP_STARTUP_MS: "5000",
    MCP_BACKEND_LOG: join(root, "backend.log"),
    TEST_BACKEND_PORT: String(backendPort),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitFor(url, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (predicate(body)) return body;
    } catch {}
    await delay(100);
  }
  throw new Error(`timed out waiting for ${url}`);
}
try {
  const healthUrl = `http://127.0.0.1:${gatewayPort}/healthz`;
  await waitFor(healthUrl, (body) => body.backend === "stopped");

  const payload = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const echoed = await response.json();
  if (echoed.method !== "initialize") throw new Error("gateway did not proxy the MCP request");

  await waitFor(healthUrl, (body) => body.backend === "running");
  await waitFor(healthUrl, (body) => body.backend === "stopped", 6000);
  console.log("PASS: request woke the backend and idle timeout stopped it");
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000),
  ]);
  rmSync(root, { recursive: true, force: true });
}
