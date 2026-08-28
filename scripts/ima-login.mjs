#!/usr/bin/env node
/**
 * IMA 登录抓 cookie —— 替代"死 token"（复制来的快照 cookie）。
 *
 * 流程：
 *   1) 用 Playwright 驱动系统 Chrome（channel:'chrome'，headed 弹窗）
 *   2) 打开 https://ima.qq.com，弹出登录 → 用户用手机扫码
 *   3) 登录成功后拦截 IMA 前端的 API 请求，抓取请求头里的
 *      x-ima-cookie 和 x-ima-bkn
 *   4) 写入 ~/.ima-web-mcp/creds.json（保留已有 OpenAPI client_id/api_key）
 *   5) 打印结果
 *
 * 用法：node ima-login.mjs [timeout秒]      默认 180s
 * 退出码：0=成功；2=超时未抓到；1=其他错误
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const CREDS = process.env.HOME + "/.ima-web-mcp/creds.json";
const LOGIN_URL = "https://ima.qq.com";
const TIMEOUT = parseInt(process.argv[2] ?? "180", 10) * 1000;

function log(msg) { process.stdout.write(`[ima-login] ${msg}\n`); }

function existingCreds() {
  try { return JSON.parse(readFileSync(CREDS, "utf8")); } catch { return {}; }
}

async function main() {
  let captured = null;
  function tryCapture(req) {
    if (captured) return;
    const h = req.headers();
    const cookie = h["x-ima-cookie"];
    const bkn = h["x-ima-bkn"];
    if (cookie && bkn) {
      captured = { cookie: String(cookie), bkn: String(bkn) };
      log(`捕获到凭证 (cookie ${cookie.length} chars, bkn ${bkn.length})`);
    }
  }

  const browser = await chromium.launch({ channel: "chrome", headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("request", tryCapture);
    page.on("response", (res) => { if (!captured) tryCapture({ headers: () => res.request().headers() }); });

    log(`打开 ${LOGIN_URL}，请在弹出的 Chrome 窗口里用手机扫码登录...`);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }).catch(() => {});

    const started = Date.now();
    while (!captured && Date.now() - started < TIMEOUT) {
      await page.waitForTimeout(1000);
      // 登录后偶尔需要一次刷新才触发 IMA 的 API 请求
      if (!captured && Date.now() - started > 5000 && (Date.now() - started) % 8000 < 1000) {
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      }
    }

    if (!captured) {
      log(`超时（${TIMEOUT / 1000}s）未抓到凭证，窗口 5s 后关闭`);
      await page.waitForTimeout(5000);
      return 2;
    }

    const creds = existingCreds();
    creds.cookie = captured.cookie;
    creds.bkn = captured.bkn;
    writeFileSync(CREDS, JSON.stringify(creds, null, 2));
    log(`已写入 ${CREDS}，可在 GPT 里重试 ask`);
    await page.waitForTimeout(2000);
    return 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

process.exitCode = await main().catch((e) => { console.error(`[ima-login] error: ${e.message}`); return 1; });
