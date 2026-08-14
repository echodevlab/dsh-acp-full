/** ACP v1 agent 处理器。@module dsh-acp-full/server/v1 */

import { isAbsolute } from 'node:path'
import { PROTOCOL_VERSION, agent } from '@agentclientprotocol/sdk'
import type { ContentBlock as AcpContentBlock, SessionId as AcpSessionId, SessionUpdate } from '@agentclientprotocol/sdk'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { AcpFullConfig } from '../types.ts'
import { DshBridge } from './bridge.ts'
import { acpPromptToUserMessage, resolveNeutralContent } from './content.ts'
import {
  applyConfigOption, descriptorsToV1,
  sessionConfigDescriptors,
  type EffortOptionValue, type ModelSelection, type PresetEntry, type ProviderModels, type SessionSelection,
} from './config-options.ts'
import { type AcpClientCall, ConnectionCore } from './core.ts'
import { clipText, neutralToText, type NeutralUpdate } from './mapping.ts'

/** 会话 mode 面：v1 标准 modes，从 dsh agent presets 构建。 */
function modesFromPresets(presets: readonly PresetEntry[], currentMode: string): { currentModeId: string; availableModes: { id: string; name: string }[] } {
  return {
    currentModeId: currentMode,
    availableModes: presets.map(p => ({ id: p.id, name: p.name })),
  }
}

/** dsh todo 列表在 ACP plan 面上的固定 planId。 */
const TODO_PLAN_ID = 'dsh-todo'

/**
 * 从 bridge 和插件配置解析初始会话选择（mode/model/effort/sandbox）。
 * 持久化恢复时传入 `persisted`：从 `request/header` 事件日志重建的模型与思考等级
 * 优先于配置覆写与默认值，使 session/load 与 session/resume 继承上次的模型选择。
 * @param bridge - dsh 桥（列模型与 reasoning）。
 * @param config - 插件配置（provider/model/sandbox 覆写决定初始值）。
 * @param persisted - 从持久化日志重建的模型选择（可选）。
 * @returns 初始选择 + 构造 configOptions 所需的 providers/efforts/sandboxModes。
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
  // 初始 mode：第一个 preset id，或 'standard' 兜底（mode 不持久化，preset 由部署决定）。
  const mode = presets[0]?.id ?? 'standard'
  // 初始 sandbox：配置覆写优先，否则部署默认；无 sandbox 服务时 undefined。
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

/**
 * 按 client 适配返回 session setup 的 mode 相关字段。
 * Devin Desktop 不支持 session modes，改用 config options（mode/model/effort/sandbox）；
 * 其他客户端沿用 v1 的 modes 面（仅 mode）。
 * @param selection - 当前会话选择。
 * @param providers - provider 分组的模型列表。
 * @param efforts - 当前模型支持的思考等级。
 * @param sandboxModes - 可选的 sandbox 模式列表。
 * @param config - 插件配置（读取 `client` 适配标志）。
 */
function sessionSetupExtras(
  selection: SessionSelection,
  presets: readonly PresetEntry[],
  providers: readonly ProviderModels[],
  efforts: readonly EffortOptionValue[],
  sandboxModes: readonly SandboxMode[],
  config: AcpFullConfig,
): { modes: ReturnType<typeof modesFromPresets> } | { configOptions: ReturnType<typeof descriptorsToV1> } {
  if (config.client === 'devin') {
    return { configOptions: descriptorsToV1(sessionConfigDescriptors(selection, presets, providers, efforts, sandboxModes)) }
  }
  return { modes: modesFromPresets(presets, selection.mode) }
}

/** v1 能力声明：与真实实现面对齐。 */
const AGENT_CAPABILITIES = {
  loadSession: true,
  promptCapabilities: { image: true, audio: false, embeddedContext: true },
  sessionCapabilities: {
    list: {},
    fork: {},
    resume: {},
    close: {},
    additionalDirectories: {},
  },
}

/** 中立更新 → v1 SessionUpdate；无对应面的更新返回 null。 */
async function toV1Update(update: NeutralUpdate, attachments: AttachmentStore | undefined): Promise<SessionUpdate | null> {
  switch (update.kind) {
    case 'user_message_chunk':
      return {
        sessionUpdate: 'user_message_chunk',
        messageId: update.messageId,
        content: await resolveNeutralContent(update.content, attachments) as AcpContentBlock,
      }
    case 'agent_message_chunk':
      return {
        sessionUpdate: 'agent_message_chunk',
        messageId: update.messageId,
        content: await resolveNeutralContent(update.content, attachments) as AcpContentBlock,
      }
    case 'agent_thought_chunk':
      return {
        sessionUpdate: 'agent_thought_chunk',
        messageId: update.messageId,
        content: await resolveNeutralContent(update.content, attachments) as AcpContentBlock,
      }
    case 'tool_call':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.title,
        kind: update.toolKind,
        status: update.status,
        name: update.name,
        rawInput: update.rawInput,
      }
    case 'tool_call_update': {
      const rawOutput = update.content ? clipText(neutralToText(update.content)) : undefined
      // diff 内容作为 ACP ToolCallContent 上线（Devin 等 client 渲染为 inline diff）。
      const diffContent = update.content?.filter(c => c.type === 'diff') ?? []
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: update.toolCallId,
        status: update.status,
        ...(update.toolKind !== undefined ? { kind: update.toolKind } : {}),
        ...(rawOutput !== undefined ? { rawOutput } : {}),
        ...(diffContent.length > 0 ? {
          content: await Promise.all(diffContent.map(c => resolveNeutralContent(c, attachments))) as unknown as NonNullable<Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>['content']>,
        } : {}),
      }
    }
    case 'plan':
      return { sessionUpdate: 'plan', entries: update.entries.map(entry => ({ ...entry })) }
    case 'plan_removed':
      return { sessionUpdate: 'plan_removed', planId: TODO_PLAN_ID }
    case 'current_mode_update':
      return { sessionUpdate: 'current_mode_update', currentModeId: update.modeId }
    case 'session_info_update':
      return { sessionUpdate: 'session_info_update', title: update.title }
    case 'available_commands_update':
      return {
        sessionUpdate: 'available_commands_update',
        availableCommands: update.commands.map(command => ({ name: command.name, description: command.description })),
      }
    case 'state_update':
      return null // v1 没有 state_update
  }
}

/** 把中立更新逐个发给 v1 client。 */
async function emitV1(
  client: AcpClientCall,
  sessionId: SessionIdType,
  updates: readonly NeutralUpdate[],
  attachments: AttachmentStore | undefined,
): Promise<void> {
  for (const update of updates) {
    const wire = await toV1Update(update, attachments)
    if (!wire) continue
    await client.notify('session/update', { sessionId, update: wire })
  }
}

/**
 * 构建 ACP v1 agent app。
 * @param core - 共享连接核心。
 * @param bridge - dsh 桥。
 * @param config - 插件配置。
 * @param attachments - dsh 附件服务。
 * @param logger - 诊断日志。
 * @returns 注册好全部请求/通知处理器的 app。
 */
export function createV1App(
  core: ConnectionCore,
  bridge: DshBridge,
  config: AcpFullConfig,
  attachments: AttachmentStore | undefined,
  logger: (message: string) => void,
): ReturnType<typeof agent> {
  const app = agent()

  app.onRequest('initialize', ({ client }) => {
    core.activate(client, (sessionId, updates) => emitV1(client, sessionId, updates, attachments))
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: AGENT_CAPABILITIES }
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
    return { sessionId: record.sessionId as AcpSessionId, ...sessionSetupExtras(record.selection, presets, providers, efforts, sandboxModes, config) }
  })

  app.onRequest('session/load', async ({ params }) => {
    if (!isAbsolute(params.cwd)) throw new Error(`cwd must be an absolute path: ${params.cwd}`)
    if (params.mcpServers && params.mcpServers.length > 0) {
      logger(`session/load ignored ${params.mcpServers.length} mcpServers (dsh configures MCP servers through its own plugins)`)
    }
    // 先读事件日志以恢复持久化的模型选择（request/header 快照）。
    const events = await bridge.readSessionEvents(params.sessionId)
    const persisted = bridge.resolvePersistedModel(events)
    const { selection, presets, providers, efforts, sandboxModes } = await resolveInitialSelection(bridge, config, persisted)
    const handle = await bridge.resumeSession(params.sessionId, selection.model)
    // resume 后从会话事件日志解析已持久化的 sandbox 覆写。
    const resumedSandbox = bridge.resolveSandboxMode(handle.agent.session)
    const record = core.register(handle, { ...selection, ...(resumedSandbox !== undefined ? { sandbox: resumedSandbox } : {}) })
    // ACP 协议：session/load MUST replay 整个对话历史（session/update 通知）。
    await core.replay(record, handle.agent.session.events)
    return sessionSetupExtras(record.selection, presets, providers, efforts, sandboxModes, config)
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
    const [presets, rawEfforts] = await Promise.all([
      bridge.listPresets(),
      bridge.resolveModelReasoning(record.selection.model.provider, record.selection.model.model),
    ])
    const efforts: EffortOptionValue[] = rawEfforts.map(e => ({ value: e.id, name: e.name, ...(e.description !== undefined ? { description: e.description } : {}) }))
    const providers = await bridge.listAllModels()
    return { sessionId: record.sessionId as AcpSessionId, ...sessionSetupExtras(record.selection, presets, providers, efforts, sandboxModes, config) }
  })

  app.onRequest('session/list', async () => {
    const listed = await bridge.listSessions()
    const sessions = []
    for (const item of listed) {
      if (item.header.cwd === undefined) continue
      sessions.push({
        sessionId: item.header.id as AcpSessionId,
        cwd: item.header.cwd,
        updatedAt: new Date(item.header.createdAt).toISOString(),
      })
    }
    return { sessions }
  })

  app.onRequest('session/delete', () => {
    throw new Error('session deletion is not supported: dsh persisted logs are append-only')
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
    return sessionSetupExtras(record.selection, presets, providers, efforts, sandboxModes, config)
  })

  app.onRequest('session/close', async ({ params }) => {
    await core.closeSession(SessionId(params.sessionId))
  })

  app.onRequest('session/prompt', async ({ params }) => {
    const record = core.get(SessionId(params.sessionId))
    if (!record) throw new Error(`unknown session ${params.sessionId}`)
    const message = await acpPromptToUserMessage(params.prompt, attachments)
    const outcome = await core.drive(record, message)
    const total = outcome.inputTokens + outcome.outputTokens
    return {
      stopReason: outcome.stopReason,
      ...(total > 0 ? {
        usage: { totalTokens: total, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens },
      } : {}),
    }
  })

  app.onRequest('session/set_mode', async ({ params, client }) => {
    const record = core.get(SessionId(params.sessionId))
    if (!record) throw new Error(`unknown session ${params.sessionId}`)
    // mode 现在是 agent preset id；切换时 recompose。
    if (params.modeId !== record.selection.mode) {
      await bridge.recomposePreset(record.agent.ctx, params.modeId)
    }
    record.selection = { ...record.selection, mode: params.modeId }
    await client.notify('session/update', {
      sessionId: record.sessionId,
      update: { sessionUpdate: 'current_mode_update', currentModeId: params.modeId },
    })
    return {}
  })

  app.onRequest('session/set_config_option', async ({ params }) => {
    if (config.client !== 'devin') {
      throw new Error('session config options are not supported by dsh')
    }
    const record = core.get(SessionId(params.sessionId))
    if (!record) throw new Error(`unknown session ${params.sessionId}`)
    const next = applyConfigOption(record.selection, params.configId, params.value)
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
    return { configOptions: descriptorsToV1(sessionConfigDescriptors(next, presets, providers, efforts, bridge.sandboxModes())) }
  })

  app.onRequest('authenticate', () => {
    throw new Error('authentication is not supported by dsh-acp-full')
  })

  app.onRequest('providers/list', () => ({ providers: bridge.listProviders() }))

  app.onRequest('providers/set', () => {
    throw new Error('provider selection is owned by the dsh deployment configuration')
  })

  app.onRequest('providers/disable', () => {
    throw new Error('provider selection is owned by the dsh deployment configuration')
  })

  app.onRequest('logout', () => {
    throw new Error('authentication is not supported by dsh-acp-full')
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
