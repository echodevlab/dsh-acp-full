# dsh-acp-full

Full-featured [Agent Client Protocol](https://agentclientprotocol.com) server plugin for DeepSeek Harness (dsh). Serves **ACP v1** and the **experimental ACP v2 draft** over one stdio connection, negotiated per connection by the SDK protocol router.

This package is an out-of-tree companion to dsh (modeled after `dsh-TUI`): it mounts as an ordinary cordis plugin on top of a dsh profile and reuses dsh's agent, session, and attachment services without modifying dsh core.

## Install

```sh
bun add github:echodevlab/dsh-acp-full#package
```

Then mount it in a dsh profile bundle (`dsh-base` + this patch):

```yaml
# cordis.yml overlay
plugins:
  dsh-base: {}
  dsh-acp-full:
    use: dsh-acp-full
    config:
      # provider/model/maxTokens are optional; omit to let the profile decide.
      provider: deepseek-official
      model: deepseek-chat
```

The package ships `cordis.patch.yml` (referenced by `dsh.bundle.patch`) for bundle-patch composition; edit it to match your provider routes.

## Usage with dsh profiles

dsh loads ACP server bundles through **profiles** stored in `~/.dsh/profiles/<name>/`. Each profile is a self-contained directory with `package.json`, `cordis.yml`, and `cordis.patch.yml`. Create one of the following two profiles depending on whether you want the published package or a local checkout.

### A — Released version (package branch)

Creates a profile named `acp` that installs `@echodevlab/dsh-acp-full` from the `package` branch (pre-built artifacts committed by CI).

```sh
mkdir -p ~/.dsh/profiles/acp
cd ~/.dsh/profiles/acp
```

`package.json`:

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

`cordis.yml` and `cordis.patch.yml` (both empty arrays):

```yaml
[]
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
```

Install and run:

```sh
pnpm install
dsh --profile acp
```

### B — Local development version (linked checkout)

Creates a profile named `acpdev` that links your local source tree, so edits take effect immediately.

```sh
mkdir -p ~/.dsh/profiles/acpdev
cd ~/.dsh/profiles/acpdev
```

`package.json` (note the `link:` dependency and the unscoped bundle name):

```json
{
  "name": "dsh-profile-acpdev",
  "private": true,
  "dependencies": {
    "dsh-acp-full": "link:/path/to/dsh-acp-full"
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

`cordis.yml`, `cordis.patch.yml`, and `pnpm-workspace.yaml` are identical to the released profile above.

Install and run:

```sh
pnpm install
dsh --profile acpdev
```

### Choosing between the two

| | `--profile acp` | `--profile acpdev` |
| --- | --- | --- |
| Source | package branch (`@echodevlab/dsh-acp-full`) | Local checkout (`link:...`) |
| Updates | Requires a new tagged release | Instant — reuses your working tree |
| Use case | Production, reproducible runs | Development, debugging, testing |

## Protocol surface

The connection router reads the client's `initialize` request and dispatches to the v1 or v2 handler for that connection. Both handlers share one connection core over dsh's durable session event feed.

| Capability | ACP v1 | ACP v2 draft |
| --- | --- | --- |
| initialize / capabilities | yes | yes |
| session/new, session/prompt, session/cancel | yes | yes |
| session/list, session/fork, session/resume, session/close | yes | yes |
| session/load | yes (resume session and replay history) | — (not in v2 draft) |
| session/set_mode | yes (`default` / `plan`) | — (not in v2 draft) |
| session/delete | no (dsh logs are append-only) | no |
| session/set_config_option | no | yes (mode/model/effort/sandbox) |
| providers/list | yes (dsh LLM routes) | yes |
| providers/set, providers/disable | no (deployment-owned) | no |
| auth / logout | no | no |
| NES | no | no |
| document notifications | ignored | ignored |
| MCP client connections | no | no |

### Prompt content

- `text` → dsh text blocks.
- `resource_link` → rendered as a textual reference.
- embedded `resource` → text payload inlined; image blobs stored through dsh's attachment service.
- `image` (png/jpeg/webp/gif) → durable dsh image attachments.
- `audio` and unknown/evidence blocks → explicit protocol error (never silently dropped).

### Live updates (streamed as `session/update` notifications)

| dsh durable event | v1 update | v2 update |
| --- | --- | --- |
| `user/message` | `user_message_chunk` (suppressed for the current prompt) | `user_message_chunk` (suppressed for the current prompt) |
| `assistant/chunk` text delta | `agent_message_chunk` | `agent_message_chunk` |
| `assistant/chunk` reasoning delta | `agent_thought_chunk` | `agent_thought_chunk` |
| `tool/call` | `tool_call` | `tool_call_update` |
| `tool/result` | `tool_call_update` (+ `rawOutput`) | `tool_call_content_chunk` + `tool_call_update` |
| `todo/write` | `plan` / `plan_removed` | `plan_update` / `plan_removed` |
| `plan/mode` | `current_mode_update` | — (v2 draft has no mode update) |
| `session/title` | `session_info_update` | `session_info_update` |
| `request/header` | `available_commands_update` | `available_commands_update` |
| `agent/status`, `turn/end` | — | `state_update` (incl. idle `stopReason`) |

Assistant chunk correlation uses the synthetic message id `assistant-<turn>-<step>` (dsh stream chunks carry no message identity).

The `user/message` event for the prompt currently being driven is suppressed: the client already displayed the user's input when it sent `session/prompt`, so echoing it back would duplicate the message. Historical `user/message` events (replayed on `session/load`) are still streamed.

v1 `session/prompt` responses carry `stopReason` and per-turn `usage` (`totalTokens`/`inputTokens`/`outputTokens`); v2 conveys the stop reason through the idle `state_update` (v2 `PromptResponse` is empty by protocol).

### Permissions

dsh approval questions are bridged to the client as `session/request_permission` (`allow-once` / `reject-once`). Cancelling the question, or having no live connection, falls back to the rest of dsh's approval waterfall.

### Sandbox mode

The file-effect sandbox mode (`read-only` / `workspace-write` / `danger-full-access`) is exposed as a v2 session config option (`configId: "sandbox"`). Switching it appends a `sandbox/mode` event to the session log through dsh's `sandbox-policy` service, so the override is restored from the event log on `session/load` and `session/resume`. When the `sandbox-policy` service is not composed, the option is omitted entirely. An initial override can be set via the `sandbox` config field.

## Data flow

```
ACP client ──stdio──> protocol router ──> v1 | v2 handler ──> ConnectionCore ──> dsh services
                        (initialize)         (session ops)      │
                                                               ├─ AgentRegistry (create/resume/fork)
                                                               ├─ SessionStore / session-query (list/read)
                                                               ├─ AttachmentStore (image content)
                                                               └─ approval/request waterfall (permissions)
dsh durable events (session/event) ──> mapping ──> neutral updates ──> version conversion ──> client
```

Durable session events are the single authoritative feed: live updates and `session/resume` replay both derive from the committed log.

## Configuration

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

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run lint        # oxlint
bun test            # unit + in-process ACP v1/v2 protocol tests
bun run build       # lib/ (bun) + lib/types (tsc)
```

## Known Limitations and Deferred Work

- **Session deletion is unsupported.** dsh persisted logs are append-only; `session/delete` is rejected and not advertised in capabilities.
- **v2 has no mode notification surface.** `plan/mode` changes reach v1 clients as `current_mode_update`; v2 clients observe plan state through `plan_update` only. `session/set_mode` maintains the ACP-facing mode and does not force dsh's plan mode (the model toggles that through its own tools).
- **No `usage_update` notification.** dsh reports per-step token accounting but no context-window size; v1 prompt responses carry usage instead.
- **`terminal_update` (v2) has no dsh source.** dsh terminal output arrives through tool results.
- **`supported` in `providers/list` is empty.** dsh provider routes do not expose ACP wire-protocol names; providers are reported as required.
- **Client-side MCP, NES, and document surfaces are not supported** by dsh; they are rejected or ignored as documented above. v2 `session/set_config_option` supports mode/model/effort/sandbox.
- `resource_link` content is rendered as text rather than preserved as a structured link (dsh has no resource-link block).
