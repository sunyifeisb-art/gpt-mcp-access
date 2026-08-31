# MCP 按需拉起与 5 分钟空闲关闭

## 1. 目标

有些 MCP（例如本机知识库桥接、浏览器自动化或较重 Python 服务）不应永久占用内存，但 ChatGPT 又必须随时能够连接。

正确拆分：

```text
常驻：tunnel-client + 轻量 gateway
按需：真实 MCP backend
```

不能把 tunnel-client 也关掉；ChatGPT 的连接器发现和任何工具调用都要求 tunnel-client 在线。

## 2. 请求生命周期

1. ChatGPT 请求到达 OpenAI control plane。
2. 常驻 tunnel-client 把请求送到 `127.0.0.1:<gateway>/mcp`。
3. gateway 检查真实 backend 的 `/healthz`。
4. backend 未运行时，gateway 执行 `MCP_BACKEND_SCRIPT`，并等待健康检查成功。
5. gateway 转发原始 Streamable HTTP 请求和 MCP session header。
6. 每个普通请求或 SSE 流都增加活跃计数。
7. 活跃计数为 0 且最后活动超过 `MCP_IDLE_MS=300000` 时，gateway 终止 backend 整个进程组。
8. 下次请求再次拉起。

## 3. 文件与端口分层

推荐每个服务使用三组不同端口：

| 层 | 示例 | 是否常驻 |
|---|---:|---|
| tunnel-client health/UI | 3461 | 是 |
| on-demand gateway | 3101 | 是 |
| real MCP backend | 3001 | 否 |

多个 MCP 依次使用 3462/3102/3002 等，日志、profile、LaunchAgent 也必须分别命名。

## 4. 配置模板

复制并替换绝对路径：

- `examples/scripts/backend.example.sh`
- `examples/scripts/on-demand-gateway.example.sh`
- `examples/scripts/openai-tunnel.example.sh`
- `examples/tunnel-client/http-on-demand.yaml`
- `examples/launchd/*.plist`

backend 启动脚本最后必须 `exec` 真正服务，避免 shell 留在中间导致子进程无法完整回收。

## 5. 内部认证

若 backend 需要 bearer token：

```bash
export MCP_UPSTREAM_BEARER_TOKEN="$(security find-generic-password -s SERVICE -w)"
```

gateway 会只在 loopback 转发时注入：

```text
Authorization: Bearer <local token>
```

ChatGPT 连接器仍选 No Authentication。这个模式的边界是“OpenAI Tunnel 已经决定谁能访问该 tunnel，本机 gateway 再替内部 backend 注入本地凭证”。

如果旧 OAuth bridge 把 access token 持久化在 JSON，可选配置：

```text
MCP_OAUTH_STATE_FILE
MCP_OAUTH_CLIENT_ID
MCP_OAUTH_SCOPE
MCP_OAUTH_RESOURCE
MCP_UPSTREAM_BEARER_TOKEN
```

必须五项一起提供。敏感值不能写进仓库。

## 6. macOS 守护

常驻的两个 LaunchAgent：

- gateway：`KeepAlive=true`；
- tunnel-client wrapper：`KeepAlive=true`，启动前等待 gateway `/healthz`。

真实 backend 不建立 KeepAlive LaunchAgent，它由 gateway 管理。

安装前：

```bash
plutil -lint examples/launchd/com.example.mcp-on-demand-gateway.plist
plutil -lint examples/launchd/com.example.openai-tunnel.plist
```

复制到 `~/Library/LaunchAgents/` 后，用 `launchctl bootstrap`/`kickstart` 管理。不要同时用 LaunchAgent 和手工 `nohup` 启动同一服务。

## 7. 验证

模板自测：

```bash
node scripts/test-on-demand-gateway.mjs
```

实际 MCP 验证：

1. gateway `/healthz` 初始 `backend: stopped`；
2. MCP `initialize` 成功，状态变 `running`；
3. `tools/list` 成功；
4. 至少调用一个只读工具；
5. 等 300 秒，backend 端口消失、gateway/tunnel 仍在线；
6. 再调用一次，backend 自动出现并完成新会话初始化。

## 8. 会话重建易错点

backend 被关闭后，它的内存 MCP session 也会消失。ChatGPT 可能仍携带旧 `mcp-session-id` 发来第一条请求，此时 backend 可能返回 400/404，然后客户端重新 `initialize`。

这是“关闭真实后端但保留轻网关”结构的会话边界，不等于 tunnel 断开。处理选择：

- 可以接受一次自动重初始化：保持 5 分钟策略；
- 首次调用错误对用户可见：适当延长 idle；
- 必须完全无感：gateway 需要升级为稳定 MCP session 终结点并自行重建后端会话，复杂度更高。

## 9. 健康状态怎么解释

```json
{
  "ok": true,
  "backend": "stopped",
  "activeRequests": 0,
  "idleSeconds": 300
}
```

这里 `stopped` 是预期空闲态。真正断线应表现为：

- gateway `/healthz` 不通；或
- tunnel-client `/healthz`/`/readyz` 异常；或
- 请求到达但 backend 启动失败，gateway 返回 `backend_start_failed`。
