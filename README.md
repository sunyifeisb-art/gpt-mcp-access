# gpt-mcp-access

把任意 MCP（本地 stdio 或远程 HTTP）暴露给 **ChatGPT 网页端（Web GPT）** 连接的完整方案与可复用模板。

> 沉淀自真实踩坑：把腾讯 IMA（本地 stdio MCP）和元典（远程 HTTP MCP）接入 ChatGPT 网页端全过程的架构、认证、隧道、以及与 `@modelcontextprotocol/sdk` / DevSpace / Cloudflare 打交道踩过的每一个坑。

## 这是什么

ChatGPT 网页端**只能连「远程 HTTP MCP」**（HTTPS 地址 + OAuth 授权），不能 spawn 本地进程。所以任何本地 MCP 想给网页端用，都必须变成"远程 HTTP + OAuth"。本仓库给出：

- **完整方法论**：stdio MCP 怎么桥接、远程 HTTP MCP 怎么薄包装、OAuth 单 owner 密码怎么做。
- **隧道两种方案**：有域名（Cloudflare 命名隧道，稳定 URL）/ 无域名（trycloudflare 快速隧道）。
- **真实错误库**：`502 / 530 / 1033 / invalid_client / IMA_AUTH_EXPIRED / trust proxy` 等逐一对应的根因与修复。
- **可复用模板**：`scripts/` 里的桥接、OAuth 持久化、IMA 扫码登录、启动脚本。

## 目录

```
SKILL.md            主文档（先读这个）
references/
  architecture.md   架构 + 桥接代码要点（stdio vs 远程 HTTP）
  no-domain.md      无域名方案（trycloudflare / ngrok / DevSpace）
  cloudflare-tunnel.md 域名 + 命名隧道 + 网络层坑
  oauth-auth.md     Owner 密码 OAuth + 持久化 + ChatGPT client 缓存
  pitfalls-errors.md 错误排查速查表
  github-projects.md 涉及的开源项目
scripts/
  bridge-stdio.mjs      stdio→远程 OAuth 桥接（IMA 用）
  bridge-remote-http.mjs 远程 HTTP MCP OAuth 包装（元典用）
  state-store.mjs       OAuth client/token JSON 持久化
  ima-login.mjs         Playwright 扫码登录抓 cookie（IMA）
  ima-web-serve.sh      幂等 start/status/health/stop
  test-autoauth.mjs     未知 client 全链路授权测试
```

## 安装为 Skill（Claude Code）

```bash
cp -r gpt-mcp-access ~/.claude/skills/
# 或单独参考：按 SKILL.md 的结构在 ~/.claude/skills/ 下建同名目录
```

## 快速开始（3 分钟思路版）

1. 判断源 MCP 类型：本地 stdio（`ps` 有子进程）还是远程 HTTP（`curl` 上游能回 MCP 信息）。
2. 复制对应脚本模板，填好 env（owner 密码、API key、cookie 等，都走环境变量/本地文件，**勿提交仓库**）。
3. 起隧道：`cloudflared tunnel --url http://127.0.0.1:<port>`（无域名，临时 URL）或命名隧道（有域名，稳定 URL）。
4. ChatGPT 网页端添加 MCP URL + 输 owner 密码授权。

详见 `SKILL.md`。

## 安全

- **不含任何真实密钥**：所有脚本通过环境变量 / 本地文件读取凭证，仓库内只有 `${...}` 占位与说明。
- Owner 密码、API Key、Cookie 都是机密，永远放本地配置，**不要提交**。

## 技术栈 / 致谢

- [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) —— MCP 官方 SDK
- [@waishnav/devspace](https://github.com/waishnav/devspace) —— OAuth 模式参考（GPT 连本机的成品）
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) —— 隧道
- 腾讯 IMA / 元典 open.chineselaw.com —— 上游法律/知识库 MCP

## License

MIT
