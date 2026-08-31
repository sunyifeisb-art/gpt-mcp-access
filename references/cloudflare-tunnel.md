# Cloudflare 隧道（兼容/备选，不是当前首选）

> 当前首选是 `references/openai-secure-tunnel.md`。本页只用于：账号没有 OpenAI Tunnels、必须保留公网域名入口、或维护历史 Cloudflare 部署。若 ChatGPT Connector 已经选择 OpenAI tunnel，不要再按本页修改域名/Cloudflare 路由。

旧公网方案中，无域名走 `references/no-domain.md`；有域名用 **命名隧道（Named Tunnel）**，URL 稳定。

## 一、命名隧道原理

- 本地跑一个 `cloudflared` 连接器，通过 token 连到 Cloudflare edge。
- Cloudflare edge 收到公网请求 → 转发给本地连接器 → 本地 3001 桥接。
- 一条隧道可以挂**多个 hostname**（如 `gpt.bytelegal.cn`、`ima.bytelegal.cn`），各自转发到不同本地端口。

## 二、启动命令（最关键：境内用 http2，别用默认 QUIC）

```bash
cloudflared tunnel run --protocol http2 --token <TUNNEL_TOKEN>
```
- `--protocol http2`：境内（GFW/Shadowrocket）下 QUIC(UDP 7844) 会被限流丢包 → 反复 `Failed to dial`。**http2(TCP) 立刻稳定。**
- `<TUNNEL_TOKEN>` 在 Cloudflare Zero Trust → Networks → Tunnels → 你的隧道 → 复制。

## 三、给一条 hostname 加路由（最容易点错的环节）

Cloudflare Zero Trust → **Networks → Tunnels → `devspace-gpt`** → **「Published application routes」** 标签
- 别点「Hostname routes」——那是**私网路由**（带 Gateway 横幅），填了白费。
- 新增一条：hostname `xxx.bytelegal.cn`，service `HTTP`，URL `127.0.0.1:3001`。
- 命名隧道**自动热加载**，加完即生效，**不用重启 cloudflared**。
- 但**新 hostname 有分发延迟**：刚加完 `curl` 会 HTTP 000 / 握手失败，等 ~60s 后变 200（Cloudflare 边缘/证书就绪延迟，**不是配置错**）。

## 四、域名侧（zone 绑定）

- 把你的域名迁到 Cloudflare（DNS 改为 CF 的 NS；腾讯云改 NS 在「域名注册→我的域名→修改 DNS 服务器」，**不在** DNS 解析/记录管理里）。
- Cloudflare **不收子域作为 zone**（Code 1099），必须填一级域名（如 `bytelegal.cn`）。
- 其它 A/CNAME 记录（如 Vercel 的）保持**灰云（仅 DNS）**——橙色云会插到前面，境内变慢/被墙。验证 `server: Vercel`、HTTP 200，Cloudflare 只查解析不碰流量。

## 五、隧道挂掉 / 打不开的症状与修复（踩坑记录）

**症状：** 公网 URL 变
- `curl` 返回 **530**、Cloudflare 错误码 **1033**（Argo Tunnel error），或 GET 直接 **000**（连不上）。
- cloudflared 日志报：
  ```
  ERROR Unable to establish connection with Cloudflare edge ... TLS handshake with edge error: EOF (ip=198.18.0.x)
  ERROR Connection terminated error="there are no free edge addresses left to resolve to"
  ```

**根因（十有八九是网络层，不是配置）：** `ip=198.18.x` 是 **Shadowrocket 的 fake-ip**。cloudflared 连 Cloudflare edge 时 DNS 被代理软件劫持成 fake-ip，TLS 握手就 EOF。同隧道其它 hostname 也一起挂（可判断是隧道级）。

**修复顺序：**
1. **重启 cloudflared** 看是否重新注册：
   ```bash
   pkill -f "cloudflared tunnel run"; sleep 2
   nohup cloudflared tunnel run --protocol http2 --token <TOKEN> > /tmp/tunnel.log 2>&1 &
   # 看日志：Registered tunnel connection ... protocol=http2   ← 连上的真凭据
   ```
2. **预防（Shadowrocket 端，用户操作）**：把 `argotunnel.com` / `cfargotunnel.com` / `cloudflare.com` 三条 **DIRECT 规则**放到最前，让 cloudflared 的 edge 连接直连、不走代理。
3. 确认进程用 `--protocol http2`（别被改回 QUIC）。

**⚠️ 判断网络问题，别用 `dig`：** fake-ip 模式下 `dig` 返回 198.18.x 是正常的，**不代表被劫持**。正确做法看 cloudflared 的 `Registered tunnel connection` 是否出现，以及 `curl https://host/healthz`。

## 六、验证隧道通不通

```bash
curl -s https://ima.bytelegal.cn/healthz                          # 期望 200
curl -s https://ima.bytelegal.cn/.well-known/oauth-authorization-server -H "Accept: application/json"
# 能返回 OAuth metadata 说明隧道+桥接都通
```
