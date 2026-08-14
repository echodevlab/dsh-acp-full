# dsh-acp-full

DeepSeek Harness (dsh) 的完整 [Agent Client Protocol](https://agentclientprotocol.com) 服务器插件。单条 stdio 连接上同时提供 **ACP v1** 与 **实验性 ACP v2 draft**，由 SDK 协议路由器按连接协商版本。

本包是 dsh 的独立树外插件（参照 `dsh-TUI` 模式）：以普通 cordis 插件形式挂载在 dsh profile 之上，复用 dsh 的 agent / session / attachment 服务，不修改 dsh 核心。

## 安装

```sh
bun add github:echodevlab/dsh-acp-full#package
```

挂载到 dsh profile bundle（`dsh-base` + 本补丁）：

```yaml
# cordis.yml overlay
plugins:
  dsh-base: {}
  dsh-acp-full:
    use: dsh-acp-full
    config:
      # provider/model/maxTokens 均可省略，省略时由 profile 自行决定。
      provider: deepseek-official
      model: deepseek-chat
```

包内置 `cordis.patch.yml`（由 `dsh.bundle.patch` 引用）用于 bundle-patch 组合；按你的 provider 路由修改。

## 通过 dsh profile 使用

dsh 通过存放在 `~/.dsh/profiles/<名称>/` 的 **profile** 加载 ACP 服务器 bundle。每个 profile 是一个独立目录，包含 `package.json`、`cordis.yml`、`cordis.patch.yml`。按以下两种方式之一创建 profile，取决于你要用已发布包还是本地检出。

### A — 远程发布版（package 分支）

创建名为 `acp` 的 profile，从 `package` 分支安装 `@echodevlab/dsh-acp-full`（CI 预构建产物）。

```sh
mkdir -p ~/.dsh/profiles/acp
cd ~/.dsh/profiles/acp
```

`package.json`：

```json
{
  "name": "dsh-profile-acp",
  "private": true,
  "dependencies": {
    "@echodevlab/dsh-acp-full": "github:echodevlab/dsh-acp-full#package"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@echodevlab/dsh-acp-full"
      ]
    }
  }
}
```

`cordis.yml` 和 `cordis.patch.yml`（均为空数组）：

```yaml
[]
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
```

安装并运行：

```sh
pnpm install
dsh --profile acp
```

### B — 本地开发版（link 检出）

创建名为 `acpdev` 的 profile，链接本地源码目录，编辑代码即时生效。

```sh
mkdir -p ~/.dsh/profiles/acpdev
cd ~/.dsh/profiles/acpdev
```

`package.json`（注意 `link:` 依赖与无 scope 的 bundle 名）：

```json
{
  "name": "dsh-profile-acpdev",
  "private": true,
  "dependencies": {
    "dsh-acp-full": "link:/你的路径/dsh-acp-full"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-acp-full"
      ]
    }
  }
}
```

`cordis.yml`、`cordis.patch.yml`、`pnpm-workspace.yaml` 与发布版相同。

安装并运行：

```sh
pnpm install
dsh --profile acpdev
```

### 两种 profile 的选择

| | `--profile acp` | `--profile acpdev` |
| --- | --- | --- |
| 来源 | package 分支（`@echodevlab/dsh-acp-full`） | 本地检出（`link:...`） |
| 更新 | 需打新 tag 发布 | 即时——复用工作区源码 |
| 适用场景 | 生产、可复现运行 | 开发、调试、测试 |

## 协议面

连接路由器读取客户端的 `initialize` 请求后，把该连接分派给 v1 或 v2 处理器。两个处理器共享同一个连接核心，核心建立在 dsh 的 durable session 事件流之上。

| 能力 | ACP v1 | ACP v2 draft |
| --- | --- | --- |
| initialize / capabilities | 支持 | 支持 |
| session/new、session/prompt、session/cancel | 支持 | 支持 |
| session/list、session/fork、session/resume、session/close | 支持 | 支持 |
| session/load | 支持（恢复会话并重放历史） | —（v2 draft 无此方法） |
| session/set_mode | 支持（`default` / `plan`） | —（v2 draft 无此方法） |
| session/delete | 不支持（dsh 日志仅追加） | 不支持 |
| session/set_config_option | 不支持 | 支持（mode/model/effort/sandbox） |
| providers/list | 支持（dsh LLM 路由） | 支持 |
| providers/set、providers/disable | 不支持（部署持有） | 不支持 |
| auth / logout | 不支持 | 不支持 |
| NES | 不支持 | 不支持 |
| document 通知 | 忽略 | 忽略 |
| 客户端侧 MCP 连接 | 不支持 | 不支持 |

### Prompt 内容

- `text` → dsh 文本块。
- `resource_link` → 渲染为文本引用。
- 内嵌 `resource` → 文本负载内联；图片 blob 经 dsh 附件服务持久化。
- `image`（png/jpeg/webp/gif）→ durable 图片附件。
- `audio` 与未知/证据块 → 明确协议错误（绝不静默丢弃）。

### 实时更新（以 `session/update` 通知流式发送）

| dsh durable 事件 | v1 更新 | v2 更新 |
| --- | --- | --- |
| `user/message` | `user_message_chunk`（当前 prompt 的被抑制） | `user_message_chunk`（当前 prompt 的被抑制） |
| `assistant/chunk` 文本增量 | `agent_message_chunk` | `agent_message_chunk` |
| `assistant/chunk` 推理增量 | `agent_thought_chunk` | `agent_thought_chunk` |
| `tool/call` | `tool_call` | `tool_call_update` |
| `tool/result` | `tool_call_update`（含 `rawOutput`） | `tool_call_content_chunk` + `tool_call_update` |
| `todo/write` | `plan` / `plan_removed` | `plan_update` / `plan_removed` |
| `plan/mode` | `current_mode_update` | —（v2 draft 无 mode 更新） |
| `session/title` | `session_info_update` | `session_info_update` |
| `request/header` | `available_commands_update` | `available_commands_update` |
| `agent/status`、`turn/end` | — | `state_update`（含 idle `stopReason`） |

assistant 流式 chunk 使用合成消息 id `assistant-<turn>-<step>`（dsh 流式 chunk 不携带消息身份）。

当前正在驱动的 prompt 的 `user/message` 事件被抑制：客户端发送 `session/prompt` 时已自行显示用户输入，再回显会导致重复。历史 `user/message` 事件（`session/load` 回放时）仍正常流式发送。

v1 `session/prompt` 响应携带 `stopReason` 与当轮 `usage`（`totalTokens`/`inputTokens`/`outputTokens`）；v2 通过 idle `state_update` 传达停止原因（v2 `PromptResponse` 协议上为空对象）。

### 权限

dsh 的审批问题被桥接为 `session/request_permission`（`allow-once` / `reject-once`）。取消问题、或没有活跃连接时，回落到 dsh 审批瀑布的其余环节。

### Sandbox 模式

文件沙箱模式（`read-only` / `workspace-write` / `danger-full-access`）作为 v2 会话 config option 暴露（`configId: "sandbox"`）。切换时通过 dsh 的 `sandbox-policy` 服务向会话日志追加 `sandbox/mode` 事件，覆写在 `session/load` 与 `session/resume` 时从事件日志解析恢复。未组合 `sandbox-policy` 服务时该选项整体省略。初始覆写可通过 `sandbox` 配置字段设置。

## 数据流

```
ACP 客户端 ──stdio──> 协议路由器 ──> v1 | v2 处理器 ──> ConnectionCore ──> dsh 服务
                        (initialize)       (会话操作)     │
                                                         ├─ AgentRegistry（创建/恢复/fork）
                                                         ├─ SessionStore / session-query（列表/读取）
                                                         ├─ AttachmentStore（图片内容）
                                                         └─ approval/request 瀑布（权限）
dsh durable 事件 (session/event) ──> 映射 ──> 中立更新 ──> 版本转换 ──> 客户端
```

durable 会话事件是唯一权威数据源：实时更新与 `session/resume` 回放都从已提交日志推导。

## 配置

```ts
export interface AcpFullConfig {
  /** 强制使用的 LLM provider 路由 id（可选）。 */
  provider?: string
  /** 强制使用的模型 id（可选）。 */
  model?: string
  /** 每个会话模型请求的最大输出 token（可选）。 */
  maxTokens?: number
  /** 新会话的初始 sandbox 模式覆写（可选；缺省时由 dsh sandbox-policy 部署默认决定）。 */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
}
```

## 开发

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run lint        # oxlint
bun test            # 单测 + 进程内 ACP v1/v2 协议测试
bun run build       # lib/（bun 打包）+ lib/types（tsc 声明）
```

## Known Limitations and Deferred Work（已知限制与后续工作）

- **会话删除不受支持。** dsh 持久化日志仅追加；`session/delete` 被拒绝且不在 capabilities 中声明。
- **v2 没有 mode 通知面。** `plan/mode` 变化以 `current_mode_update` 到达 v1 客户端；v2 客户端只能通过 `plan_update` 观察计划状态。`session/set_mode` 只维护 ACP 侧的 mode，不强制 dsh 的 plan mode（该状态由模型通过自身工具切换）。
- **不发 `usage_update` 通知。** dsh 只报告每步 token 账目、无上下文窗口大小；usage 改由 v1 prompt 响应携带。
- **v2 `terminal_update` 没有 dsh 数据源。** dsh 终端输出经由工具结果到达。
- **`providers/list` 的 `supported` 为空。** dsh provider 路由不暴露 ACP wire 协议名；provider 均报告为 required。
- **客户端侧 MCP、NES、document 面不受 dsh 支持**，按上表拒绝或忽略。v2 的 `session/set_config_option` 支持 mode/model/effort/sandbox。
- `resource_link` 内容渲染为文本而非结构化链接（dsh 没有资源链接块）。
