# Codex 内直接使用 ChatGPT Web（Plus）

## 目标

在不改掉现有 `gpt-mcp-access` 通用 MCP 链路的前提下，增加一条独立的 Codex 模型路由：

```text
Codex 原生任务/UI
    ↓ Responses + SSE（loopback）
Codex Web GPT bridge
    ↓ 受控浏览器会话
ChatGPT Web（Plus）
    ↓（Full Harness，可选）
OpenAI Secure MCP Tunnel
    ↓
Codex Native2 broker
    ↓
当前 Codex task 的 shell / 文件 / patch / 图片 / MCP / 审批
```

这条链路解决的是“Codex 里直接把 ChatGPT Web 当模型选”；仓库原先的链路解决的是“ChatGPT Web 调本地/私有 MCP”。两者用途不同，应并存，不应把已有 IMA、元典或其他通用 tunnel 改造成 Codex Native2。

## Plus 账户能力边界

本集成按 ChatGPT Plus 配置：

- `ChatGPT Web — Instant`
- `ChatGPT Web — Medium`
- `ChatGPT Web — High`

不安装、不伪造、也不通过别名绕过：

- `ChatGPT Web — Extra High`
- `ChatGPT Web — Pro`

上游 bridge 会读取当前登录账户暴露的能力；Plus 状态下 `proAvailable` 应为 `false`。如果模型缓存出现 Extra High/Pro，应先刷新账户能力或重新安装模型，而不是强行调用。

## 安装

仓库提供 Plus 专用包装脚本：

```bash
./scripts/install-codex-webgpt-plus.sh
```

它做四件事：

1. 固定到经过检查的 `miuuyy/codex-chatgpt-web` 版本（默认 `5.0.1`）；
2. 下载上游 launcher installer；
3. 要求上游 installer 仍保留 release SHA-256 校验，否则 fail closed；
4. 安装并打开 `Codex Web GPT.app`。

如需测试更新版本，显式覆盖：

```bash
CODEX_WEB_GPT_VERSION=5.0.2 ./scripts/install-codex-webgpt-plus.sh
```

不要默认跟随 `latest`，避免上游 UI/浏览器选择器变化后无审计升级。

## 一次性账户步骤

浏览器登录状态属于高敏凭据，不能由本仓库复制 Safari/Chrome/ChatGPT App Cookie，也不能写进 Git。首次安装需要在 `Codex Web GPT` 中本人完成：

1. 登录同一个 ChatGPT Plus 账号；
2. 运行 Browser smoke test；
3. 点击 `Install models`；
4. 重启 Codex 一次。

完成后，Codex 原生模型选择器应出现 Web GPT 行。日常优先选择 `ChatGPT Web — High`，需要更快时选 Medium/Instant。

## Browser-only 与 Full Harness

### Browser-only

只把 ChatGPT Web 作为 Codex 模型后端。Codex 任务上下文、图片和流式结果仍在原生 Codex UI 中，但 ChatGPT Web 不能回调当前 Codex task 的本地工具。

适合先验证模型路由。

### Full Harness

需要让 Web GPT 在推理过程中继续调用当前 Codex task 的本地能力时，使用上游专用 broker + tunnel：

- connector 名必须为 `Codex Native2`；
- Authentication 设为 `None / No Authentication`；
- tunnel 由本机主动连接 OpenAI control plane；
- 外层 Codex 仍负责真正的沙箱、审批和工具执行。

这里建议建立**单独的 Codex Native2 tunnel/profile**。不要覆盖现有给 IMA、元典或其他 MCP 使用的 tunnel，因为它们的本地目标和生命周期不同。

## 与现有 gpt-mcp-access 的关系

保留：

```text
ChatGPT Connector
  → 现有 OpenAI Tunnel
  → 通用 on-demand gateway / IMA / 元典 / 其他 MCP
```

新增：

```text
Codex Web GPT
  → ChatGPT Web
  → Codex Native2 connector
  → 专用 OpenAI Tunnel
  → 当前 Codex task broker
```

两个 tunnel 可以同时常驻；只要 profile、health port、connector 名和本地目标不冲突即可。

## 验证

运行：

```bash
./scripts/codex-webgpt-status.sh
```

成功状态至少应满足：

1. `Codex Web GPT.app` 已安装；
2. `~/.codex-chatgpt-web/config.json` 存在；
3. Plus 账户 `proAvailable: false`；
4. `~/.codex/config.toml` 存在 bridge route；
5. `~/.codex/models_cache.json` 中出现 `chatgpt-web/light`、`chatgpt-web/medium`、`chatgpt-web/high`（Codex 版本/协议可能只显示其中部分可选行，但不得依赖 Pro 行）；
6. Codex 中实际选中 Web GPT 后能完成一次流式回答；
7. Full Harness 模式下，再验证 `Codex Native2` 工具调用确实落到当前 task，而非通用 MCP tunnel。

## 回滚

优先使用 Codex Web GPT 自身的 Disconnect/Uninstall integration 功能，让它根据 integration journal 恢复原有 Codex route。不要手工删除整份 `~/.codex/config.toml` 或 `models_cache.json`。

现有 `gpt-mcp-access` 通用 tunnel 与本集成独立，回滚 Web GPT 不应删除已有 tunnel、IMA/元典 bridge 或运行时密钥。

## 安全边界

- 不复制、导出或提交 ChatGPT Cookie/browser storage；
- 不提交 tunnel runtime key；
- 不伪造 Plus 不具备的 Extra High/Pro capability；
- loopback bridge 和 broker 只允许本机使用；
- 上游版本升级先检查 browser selector、Codex route、MCP broker 契约，再修改本仓库默认版本。
