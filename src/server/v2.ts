/** ACP v2 draft agent 处理器。@module dsh-acp-full/server/v2 */

import { isAbsolute } from 'node:path'
import { PROTOCOL_VERSION, agent } from '@agentclientprotocol/sdk/experimental/v2'
import type { ContentBlock as AcpContentBlock, SessionUpdate } from '@agentclientprotocol/sdk/experimental/v2'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { AcpFullConfig } from '../types.ts'
import { DshBridge } from './bridge.ts'
import { acpPromptToUserMessage, resolveNeutralContent } from './content.ts'
import {
  applyConfigOption, descriptorsToV2, sessionConfigDescriptors,
  type EffortOptionValue, type ModelSelection, type PresetEntry, type ProviderModels, type SessionSelection,
} from './config-options.ts'
import { type AcpClientCall, ConnectionCore } from './core.ts'
import type { NeutralContent, NeutralUpdate } from './mapping.ts'

/** dsh todo 列表在 v2 plan 面上的固定 planId。 */
const TODO_PLAN_ID = 'dsh-todo'

/**
 * 从 bridge 和插件配置解析初始会话选择（mode=preset + model + effort + sandbox）。
 * 持久化恢复时传入 `persisted`：从 `request/header` 事件日志重建的模型与思考等级
 * 优先于配置覆写与默认值，使 session/resume 继承上次的模型选择。
 * @param bridge - dsh 桥（列 preset、模型与 reasoning）。
 * @param config - 插件配置（provider/model/sandbox 覆写决定初始值）。
 * @param persisted - 从持久化日志重建的模型选择（可选）。
 */
async function resolveInitialSelection(
  bridge: DshBridge,
  config: AcpFullConfig,
  persisted?: { model: ModelSelection; effort?: string },
): Promise<{ selection: SessionSelection; presets: PresetEntry[]; providers: ProviderModels[]; efforts: EffortOptionValue[]; sandboxModes: readonly SandboxMode[] }> {
  const [presets, providers] = await Promise.all([bridge.listPresets(), bridge.listAllModels()])
  // 模型优先级：持久化恢复 > 配置覆写 > 第一个 provider 的第一个模型。
  const provider = persisted?.model.provider ?? config.provider ?? providers[0]?.providerId ?? ''
  const model = persisted?.model.model ?? config.model ?? providers[0]?.models[0]?.id ?? ''
  const mode = presets[0]?.id ?? 'standard'
  const sandboxModes = bridge.sandboxModes()
  const sandbox = config.sandbox ?? bridge.defaultSandboxMode()
  const selection: SessionSelection = {
    mode,
    model: { provider, model },
    ...(persisted?.effort !== undefined ? { effort: persisted.effort } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
  }
  const rawEfforts = await bridge.resolveModelReasoning(provider, model)
  const efforts: EffortOptionValue[] = rawEfforts.map(e => ({ value: e.id, name: e.name, ...(e.description !== undefined ? { description: e.description } : {}) }))
  return { selection, presets, providers, efforts, sandboxModes }
}

/** v2 能力声明：与真实实现面对齐。 */
const CAPABILITIES = {
  session: {
    prompt: { image: {}, embeddedContext: {} },
    fork: {},
    additionalDirectories: {},
  },
}

/** 中立更新 → v2 SessionUpdate；无对应面的更新返回 null。 */
async function toV2Update(update: NeutralUpdate, attachments: AttachmentStore | undefined): Promise<SessionUpdate | null> {
  switch (update.kind) {
    case 'user_message_chunk':
      return {
        sessionUpdate: 'user_message_chunk',
        messageId: update.messageId,
        content: await resolveNeutralContent(update.content, attachments),
      }
    case 'agent_message_chunk':
      return {
        sessionUpdate: 'agent_message_chunk',
        messageId: update.messageId,
        content: await resolveNeutralContent(update.content, attachments),
      }
    case 'agent_thought_chunk':
      return {
        sessionUpdate: 'agent_thought_chunk',
        messageId: update.messageId,
        content: await resolveNeutralContent(update.content, attachments),
      }
    case 'tool_call':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: update.toolCallId,
        name: update.name,
        title: update.title,
        kind: update.toolKind,
        status: update.status,
        rawInput: update.rawInput,
      }
    case 'tool_call_update':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: update.toolCallId,
        status: update.status,
        ...(update.toolKind !== undefined ? { kind: update.toolKind } : {}),
      }
    case 'plan':
      return {
        sessionUpdate: 'plan_update',
        plan: { type: 'items', planId: TODO_PLAN_ID, entries: update.entries.map(entry => ({ ...entry })) },
      }
    case 'plan_removed':
      return { sessionUpdate: 'plan_removed', planId: TODO_PLAN_ID }
    case 'current_mode_update':
      return null // v2 draft 没有 mode 通知面；plan/mode 变化经 plan_update 与 state 表达
    case 'session_info_update':
      return { sessionUpdate: 'session_info_update', title: update.title }
    case 'available_commands_update':
      return {
        sessionUpdate: 'available_commands_update',
        availableCommands: update.commands.map(command => ({ name: command.name, description: command.description })),
      }
    case 'state_update':
      return {
        sessionUpdate: 'state_update',
        state: update.state,
        ...(update.stopReason !== undefined ? { stopReason: update.stopReason } : {}),
      }
  }
}

/**
 * 中立内容 → v2 ToolCallContent。text/image 包为 { type:'content', content }；
 * diff 转为 v2 结构化 Diff（changes + git_patch 文本）。
 */
async function resolveToolCallContent(content: NeutralContent, attachments: AttachmentStore | undefined): Promise<Record<string, unknown>> {
  if (content.type === 'diff') {
    const operation = content.oldText === null ? 'add' : 'modify'
    return {
      type: 'diff',
      changes: [{ operation, path: content.path, fileType: 'text' }],
      patch: { format: 'git_patch', text: toGitPatch(content.path, content.oldText, content.newText) },
    }
  }
  return { type: 'content', content: await resolveNeutralContent(content, attachments) }
}

/** 把单个文件的 before/after 生成一段最小 git-patch 文本。 */
function toGitPatch(path: string, oldText: string | null, newText: string): string {
  const header = oldText === null
    ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`
    : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`
  const oldLines = (oldText ?? '').split('\n')
  const newLines = newText.split('\n')
  const hunkHeader = `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`
  const body = oldLines.map(l => `-${l}`).join('\n') + (oldLines.length > 0 ? '\n' : '') + newLines.map(l => `+${l}`).join('\n')
  return header + hunkHeader + body + '\n'
}

/** 把中立更新发给 v2 client；工具结果先发 content chunk 再发状态更新。 */
async function emitV2(
  client: AcpClientCall,
  sessionId: SessionIdType,
  updates: readonly NeutralUpdate[],
  attachments: AttachmentStore | undefined,
): Promise<void> {
  for (const update of updates) {
    if (update.kind === 'tool_call_update' && update.content && update.content.length > 0) {
      for (const content of update.content) {
        await client.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_content_chunk',
            toolCallId: update.toolCallId,
            content: await resolveToolCallContent(content, attachments),
          },
        })
      }
    }
    const wire = await toV2Update(update, attachments)
    if (wire) await client.notify('session/update', { sessionId, update: wire })
  }
}

/**
 * 构建 ACP v2 draft agent app。
 * @param core - 共享连接核心。
 * @param bridge - dsh 桥。
 * @param config - 插件配置。
 * @param attachments - dsh 附件服务。
 * @param logger - 诊断日志。
 * @returns 注册好全部请求/通知处理器的 app。
 */
export function createV2App(
  core: ConnectionCore,
  bridge: DshBridge,
  config: AcpFullConfig,
  attachments: AttachmentStore | undefined,
  logger: (message: string) => void,
): ReturnType<typeof agent> {
  const app = agent()

  app.onRequest('initialize', ({ client }) => {
    core.activate(client, (sessionId, updates) => emitV2(client, sessionId, updates, attachments))
    return {
      protocolVersion: PROTOCOL_VERSION,
      info: { name: 'dsh-acp-full', title: 'DeepSeek Harness ACP Server', version: '0.1.0' },
      capabilities: CAPABILITIES,
    }
  })

  app.onRequest('session/new', async ({ params }) => {
    if (!isAbsolute(params.cwd)) throw new Error(`cwd must be an absolute path: ${params.cwd}`)
    if (params.mcpServers && params.mcpServers.length > 0) {
      logger(`session/new ignored ${params.mcpServers.length} mcpServers (dsh configures MCP servers through its own plugins)`)
    }
    const { selection, presets, providers, efforts, sandboxModes } = await resolveInitialSelection(bridge, config)
    const handle = await bridge.createSession({ cwd: params.cwd, model: selection.model })
    // 配置覆写的 sandbox 模式写入会话日志（无覆写时沿用部署默认）。
    if (config.sandbox !== undefined) {
      try { bridge.setSandboxMode(handle.agent.session, config.sandbox) } catch (error) { logger(`sandbox override failed: ${String(error)}`) }
    }
    const record = core.register(handle, selection)
    return { sessionId: record.sessionId, configOptions: descriptorsToV2(sessionConfigDescriptors(record.selection, presets, providers, efforts, sandboxModes)) }
  })

  app.onRequest('session/prompt', async ({ params }) => {
    const record = core.get(SessionId(params.sessionId))
    if (!record) throw new Error(`unknown session ${params.sessionId}`)
    // v2 与 v1 的 ContentBlock 结构相同，仅 Annotations 等装饰字段类型声明不同。
    const prompt = params.prompt as unknown as AcpContentBlock[]
    const message = await acpPromptToUserMessage(prompt, attachments)
    await core.drive(record, message)
    return {} // v2 的 stop reason 经 state_update (idle) 通知传达
  })

  app.onRequest('session/list', async () => {
    const listed = await bridge.listSessions()
    const sessions = []
    for (const item of listed) {
      if (item.header.cwd === undefined) continue
      sessions.push({
        sessionId: item.header.id,
        cwd: item.header.cwd,
        updatedAt: new Date(item.header.createdAt).toISOString(),
      })
    }
    return { sessions }
  })

  app.onRequest('session/delete', () => {
    throw new Error('session deletion is not supported: dsh persisted logs are append-only')
  })

  app.onRequest('session/fork', async ({ params }) => {
    if (!isAbsolute(params.cwd)) throw new Error(`cwd must be an absolute path: ${params.cwd}`)
    const parent = core.get(SessionId(params.sessionId))
    if (!parent) throw new Error(`session ${params.sessionId} is not live on this connection; fork requires a live parent`)
    const events = await bridge.readSessionEvents(params.sessionId)
    const handle = await bridge.createSession({
      cwd: params.cwd,
      model: parent.selection.model,
      seed: bridge.forkSeed(events),
      parentSession: SessionId(params.sessionId),
    })
    // fork 继承父会话的模型选择；sandbox 模式从新会话事件日志解析（seed 继承父覆写）。
    const sandboxModes = bridge.sandboxModes()
    const inheritedSandbox = bridge.resolveSandboxMode(handle.agent.session)
    const record = core.register(handle, { ...parent.selection, ...(inheritedSandbox !== undefined ? { sandbox: inheritedSandbox } : {}) })
    const [presets, providers, rawEfforts] = await Promise.all([
      bridge.listPresets(),
      bridge.listAllModels(),
      bridge.resolveModelReasoning(record.selection.model.provider, record.selection.model.model),
    ])
    const efforts: EffortOptionValue[] = rawEfforts.map(e => ({ value: e.id, name: e.name, ...(e.description !== undefined ? { description: e.description } : {}) }))
    return { sessionId: record.sessionId, configOptions: descriptorsToV2(sessionConfigDescriptors(record.selection, presets, providers, efforts, sandboxModes)) }
  })

  app.onRequest('session/resume', async ({ params }) => {
    // 先读事件日志以恢复持久化的模型选择（request/header 快照）。
    const events = await bridge.readSessionEvents(params.sessionId)
    const persisted = bridge.resolvePersistedModel(events)
    const { selection, presets, providers, efforts, sandboxModes } = await resolveInitialSelection(bridge, config, persisted)
    const handle = await bridge.resumeSession(params.sessionId, selection.model)
    // resume 后从会话事件日志解析已持久化的 sandbox 覆写。
    const resumedSandbox = bridge.resolveSandboxMode(handle.agent.session)
    const record = core.register(handle, { ...selection, ...(resumedSandbox !== undefined ? { sandbox: resumedSandbox } : {}) })
    // ACP 协议：session/resume MUST NOT replay 对话历史（与 session/load 相反）。
    return { configOptions: descriptorsToV2(sessionConfigDescriptors(record.selection, presets, providers, efforts, sandboxModes)) }
  })

  app.onRequest('session/close', async ({ params }) => {
    await core.closeSession(SessionId(params.sessionId))
  })

  app.onRequest('session/set_config_option', async ({ params }) => {
    const record = core.get(SessionId(params.sessionId))
    if (!record) throw new Error(`unknown session ${params.sessionId}`)
    const next = applyConfigOption(record.selection, params.configId, params.value as string | boolean)
    if (next === null) throw new Error(`unsupported config option ${params.configId} or value ${String(params.value)}`)
    // mode 切换：recompose agent 到新 preset
    if (params.configId === 'mode' && next.mode !== record.selection.mode) {
      await bridge.recomposePreset(record.agent.ctx, next.mode)
    }
    // sandbox 切换：追加 sandbox/mode 事件到会话日志
    if (params.configId === 'sandbox' && next.sandbox !== record.selection.sandbox) {
      try { bridge.setSandboxMode(record.agent.session, next.sandbox!) } catch (error) { logger(`sandbox switch failed: ${String(error)}`) }
    }
    record.selection = next
    // 模型切换后同步 agent.options，使子代理继承当前模型而非创建时的初始模型。
    if (params.configId === 'model') {
      core.syncAgentModel(record)
    }
    const [presets, providers, rawEfforts] = await Promise.all([
      bridge.listPresets(),
      bridge.listAllModels(),
      bridge.resolveModelReasoning(next.model.provider, next.model.model),
    ])
    const efforts: EffortOptionValue[] = rawEfforts.map(e => ({ value: e.id, name: e.name, ...(e.description !== undefined ? { description: e.description } : {}) }))
    return { configOptions: descriptorsToV2(sessionConfigDescriptors(next, presets, providers, efforts, bridge.sandboxModes())) }
  })

  app.onRequest('auth/login', () => {
    throw new Error('authentication is not supported by dsh-acp-full')
  })

  app.onRequest('auth/logout', () => {
    throw new Error('authentication is not supported by dsh-acp-full')
  })

  app.onRequest('providers/list', () => ({ providers: bridge.listProviders() }))

  app.onRequest('providers/set', () => {
    throw new Error('provider selection is owned by the dsh deployment configuration')
  })

  app.onRequest('providers/disable', () => {
    throw new Error('provider selection is owned by the dsh deployment configuration')
  })

  app.onRequest('mcp/message', () => {
    throw new Error('client-side MCP connections are not supported; dsh configures MCP servers through its own plugins')
  })

  app.onRequest('nes/start', () => {
    throw new Error('NES is not supported by dsh')
  })

  app.onRequest('nes/suggest', () => {
    throw new Error('NES is not supported by dsh')
  })

  app.onRequest('nes/close', () => {
    throw new Error('NES is not supported by dsh')
  })

  app.onNotification('session/cancel', ({ params }) => {
    const record = core.get(SessionId(params.sessionId))
    if (record) core.cancel(record)
  })

  app.onNotification('mcp/message', () => {
    logger('ignored mcp/message')
  })

  app.onNotification('document/didOpen', ({ params }) => {
    logger(`ignored document/didOpen for ${params.uri ?? ''}`)
  })

  app.onNotification('document/didChange', ({ params }) => {
    logger(`ignored document/didChange for ${params.uri ?? ''}`)
  })

  app.onNotification('document/didClose', ({ params }) => {
    logger(`ignored document/didClose for ${params.uri ?? ''}`)
  })

  app.onNotification('document/didSave', ({ params }) => {
    logger(`ignored document/didSave for ${params.uri ?? ''}`)
  })

  app.onNotification('document/didFocus', ({ params }) => {
    logger(`ignored document/didFocus for ${params.uri ?? ''}`)
  })

  app.onNotification('nes/accept', () => {
    logger('ignored nes/accept')
  })

  app.onNotification('nes/reject', () => {
    logger('ignored nes/reject')
  })

  return app
}
