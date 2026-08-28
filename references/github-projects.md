# 涉及的开源项目 / 技术栈

## 核心依赖

### 1. MCP 官方 SDK —— `@modelcontextprotocol/sdk`（npm）
- **作用**：MCP（Model Context Protocol）服务器/客户端的官方实现。提供 `McpServer`（服务端）、`Client`（客户端）、`StreamableHTTPClientTransport`（远程 HTTP）、`StdioClientTransport`（本地子进程）、`createMcpExpressApp`、`mcpAuthRouter`、`requireBearerAuth`、`SingleUserOAuthProvider` 的接口。
- **版本**：用 **1.30.0**（跟 DevSpace 一致），API 形态以此为准。新版可能改名（如 `Client` 曾叫别样）。
- **npm**：`npm i @modelcontextprotocol/sdk`
- **关键**：`registerTool` 的 `inputSchema` 要 Zod；`StreamableHTTPClientTransport(url: URL, { requestInit:{headers} })`；OAuth 需要你自己实现 `clientsStore`+`tokenStore`。

### 2. DevSpace —— `@waishnav/devspace`（GitHub: waishnav/devspace）
- **作用**：自托管 MCP server，让 ChatGPT 网页/手机端连本机读文件、跑 shell。是"GPT 连本机"的成品。
- **为什么重要**：我们的桥接**复刻它的 OAuth 模式**（`SingleUserOAuthProvider` + owner 密码 + `createMcpExpressApp` + `mcpAuthRouter` + `/mcp` session 生命周期）。读它源码（`dist/server.js`、`oauth-provider.js`）能拿到一整套已验证的接线方法。
- **部署**：`npm i -g @waishnav/devspace`；它自带临时隧道（trycloudflare）或可配固定域名。
- **固定地址示例**：`https://gpt.bytelegal.cn/mcp`（Cloudflare 命名隧道 + www 域名）。

### 3. Cloudflared —— `cloudflared`（Cloudflare）
- **作用**：本地到 Cloudflare 的连接器，提供命名隧道（稳定域名）和快速隧道（trycloudflare 临时 URL）。
- **npm/homebrew**：`brew install cloudflared`。
- **关键坑**：境内用 `--protocol http2`（QUIC 会被限流）；路由在「Published application routes」。

## 上游 MCP 数据源（远程或社区）

### 腾讯 IMA（知识库）
- 官方不是开放 MCP，社区有：
  - `highkay/tencent-ima-copilot-mcp`（GitHub）—— 提供 Q&A 接口调用方法、认证(Cookie)参考。
  - `ima-cli`（npm）。
- 接入方式：本地 Python 脚本（`ima-mcp-server.py`）实现 stdio MCP，OpenAPI（ClientID+APIKey）搜索/浏览 + Cookie 模式全文问答。登录靠扫码抓 `x-ima-cookie`/`x-ima-bkn`。

### 元典开放平台（open.chineselaw.com）
- **远程 streamable-http MCP**，4 类：`/mcp/{law|case|company|securities}/stream`。
- 鉴权：`Authorization: Bearer <API_KEY>`。
- 错误：401=key 无效、402=元力余额不足、429=频率限制。
- 接入：薄 OAuth 包装（`bridge-remote-http.mjs`），聚合 4 类成一个端点，工具加 `<svc>__` 前缀防重名。

### 北大法宝（apim-gateway.pkulaw.com / mcp.pkulaw.com）
- 远程 streamable-http MCP，Bearer token（`apim-gateway.pkulaw.com/<svc>`）。
- 平台：`https://mcp.pkulaw.com`（控制台/文档）。
- 有「每日领取积分」：`https://mcp.pkulaw.com/console/points` 页点「领取」（legalwork 用内置窗口自动化）。这个我们后来没接（转向元典）。

## 快速参考：GitHub 相关链接

| 项目 | 链接 | 说明 |
|---|---|---|
| DevSpace | github.com/waishnav/devspace | 自托管 MCP，GPT 连本机 |
| MCP SDK | npmjs.com/package/@modelcontextprotocol/sdk | MCP 官方 SDK |
| tencent-ima-copilot-mcp | github.com/highkay/tencent-ima-copilot-mcp | IMA 社区 MCP（Cookie/Q&A 参考） |
| cloudflared | Cloudflare | 隧道 |
| ima-cli | npmjs.com/package/ima-cli | IMA CLI |
| 元典 | open.chineselaw.com | 远程法律 MCP |
| 北大法宝 | mcp.pkulaw.com / apim-gateway.pkulaw.com | 远程法律 MCP |

## 版本/环境注意

- **Node**：本方案用 ESM（`import`）。脚本在项目目录跑（才能解析本地 node_modules），用绝对 import 或放项目里。
- **Playwright**（仅 IMA 登录用）：`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright`，`channel:"chrome"` 驱动系统浏览器。
- **无原生依赖**：OAuth 存储用 JSON 文件（替代 DevSpace 的 better-sqlite3），省去 native 编译。
