# 无域名公网隧道（兼容/临时验证）

> OpenAI Tunnels 可用时，优先使用 `references/openai-secure-tunnel.md`，不需要域名，也不需要临时公网 URL。本页只保留给没有 Tunnels 权限或需要验证旧公网 bridge 的场景。

在旧公网接入模式中，如果你**没有域名**，可以用 **Cloudflare 快速隧道（TryCloudflare / Quick Tunnel）**拿到临时公网 HTTPS URL。

## 一、试通再管域名：最快路径（推荐先跑这个）

```bash
# 只要桥接在本地 3001 跑着，就直接开快速隧道：
cloudflared tunnel --url http://127.0.0.1:3001
```

它会打印一行：
```
Your quick Tunnel has been created! Visit it at https://<random>.trycloudflare.com
```
把 `https://<random>.trycloudflare.com` 作为 MCP URL 加到 ChatGPT 网页端即可。这个 URL 就是你的公网入口，指向本地 3001 的桥接。

- **优点**：零配置、零绑定、零成本。一条命令，几分钟验证全链路能不能通。
- **缺点**：**URL 每次重启 cloudflared 都变**，网页端要重新建一次连接（重新授权）。适合**先验证**，不适合长期。

## 二、无域名 + 想稳定（可选的几种）

### 方案 A：固定一个便宜/免费的二级域名
即使没有自己的一级域名，很多服务给你免费子域（duckdns 等）——但 Cloudflare 命名隧道需要 zone 绑定，只接一个子域较麻烦。**不推荐**，除非你有域名。

### 方案 B：端口转发到有公网的主机（frp / ngrok）
- **ngrok**：`ngrok http 3001` → 临时公网 URL（免费版 URL 也变，且 http 有限制）。MCP 需要 HTTPS，ngrok 提供。
- **frp**：自己有一台公网 VPS → 用 frp 穿透到 VPS，再在 VPS 上反代。要自己配 HTTPS。
- 本质都是"本地端口 → 公网可达"，跟 trycloudflare 一样是临时/半固定 URL。

### 方案 C：用 DevSpace（根本不用自己搭桥接）
如果目标只是"让 ChatGPT 连本机读文件/跑命令"，直接部署 **DevSpace**（`@waishnav/devspace`）。它自己就带临时隧道（`devspace serve` + `trycloudflare`）或可配域名。**不需要你另写桥接。** 见 `references/github-projects.md`。

## 三、无域名方案的完整操作流

1. 起桥接（本地端口，如 3001）：
   ```bash
   node bridge-stdio.mjs      # 或 bridge-remote-http.mjs
   ```
2. 起快速隧道：
   ```bash
   cloudflared tunnel --url http://127.0.0.1:3001
   # 拿到 https://xxx.trycloudflare.com
   ```
3. **用这个 URL 加 MCP**，注意 owner 密码授权：
   - 网页端 MCP 地址填 `https://xxx.trycloudflare.com/mcp`（注意：**快速隧道默认没有 /mcp 后缀语义，它是整个域名指向 3001**。如果你的桥接把 `/mcp` 当路径，网页端 URL 要填 `https://xxx.trycloudflare.com/mcp`）。
   - 授权页弹「Connect …」→ 输 owner 密码。
   - **每次隧道重启 → URL 变 → 删旧的重加。**
4. 验证：`curl https://xxx.trycloudflare.com/healthz`。

## 四、无域名方案的坑

- **URL 会变**：这是 trycloudflare 的最大限制。长期用必须上固定域名（见 `references/cloudflare-tunnel.md`）。
- **不必纠结 /mcp 前缀**：快速隧道把整个域名转到本地端口。桥接的 `/mcp` 是 MCP 端点，`/healthz`、`/.well-known/oauth-authorization-server` 也在同一端口。网页端填哪个取决于桥接的路由——通常填 `https://xxx.trycloudflare.com/mcp`。
- **https 必须**：Web GPT 只连 HTTPS。trycloudflare/ngrok 都带 TLS，OK。
- **境内网络**：cloudflared 用 QUIC 在境内易断，加 `--protocol http2` 更稳（快速隧道也适用）：
  ```bash
  cloudflared tunnel --protocol http2 --url http://127.0.0.1:3001
  ```

## 五、旧公网方案什么时候需要上域名

- 你明确要继续使用旧公网 URL，并希望**一次授权长期用**（URL 不变）。
- 你有多个 MCP（IMA + 元典）要长期暴露，需要各自稳定的 `xxx.bytelegal.cn`。
- Web GPT 已缓存 client_id，换 URL 会逼它重新注册——所以**稳定 URL 能少折腾**。

如果只是让 ChatGPT Connector 访问本地 MCP，不必为了稳定 URL 专门购买/迁移域名；优先改用 `references/openai-secure-tunnel.md`。只有继续旧公网部署时，才进入 `references/cloudflare-tunnel.md`。
