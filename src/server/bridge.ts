/** dsh 会话/agent 生命周期桥。@module dsh-acp-full/server/bridge */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId, foldRequestHeader } from '@deepseek-ai/dsh-session'
import type { EpochHeader, Session, SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { AcpFullConfig } from '../types.ts'
import type { ModelSelection } from './config-options.ts'

export interface NewSessionSpec {
  cwd: string
  /** 已解析的模型选择；注入 agent 创建的 agentOptions，使子代理可继承。 */
  model?: ModelSelection
  seed?: readonly SessionEvent[]
  parentSession?: SessionIdType
}

/** 一个 provider 下的模型条目（config option 用）。 */
export interface ProviderModels {
  providerId: string
  providerName: string
  models: { id: string; name: string; description?: string }[]
}

/** 会话列表条目（标题需读事件日志，由调用方按需解析）。 */
export interface ListedSession {
  header: SessionHeader
  live: boolean
  persisted: boolean
}

/**
 * 把 ACP 会话操作映射到 dsh 的 AgentRegistry / SessionStore / session-query。
 * 会话删除在 dsh 不受支持（日志仅追加），由协议层拒绝。
 */
export class DshBridge {
  constructor(
    private readonly ctx: Context,
    private readonly config: AcpFullConfig,
  ) {}

  /** 把插件配置与已解析的会话模型转成 dsh AgentOptions。 */
  private agentOptions(model?: ModelSelection): { provider?: string; model?: string; maxTokens?: number } {
    // 会话级已解析模型优先（已含 config 覆写），缺省回退部署级 config。
    return {
      ...(model !== undefined
        ? { provider: model.provider, model: model.model }
        : {
            ...(this.config.provider !== undefined ? { provider: this.config.provider } : {}),
            ...(this.config.model !== undefined ? { model: this.config.model } : {}),
          }),
      ...(this.config.maxTokens !== undefined ? { maxTokens: this.config.maxTokens } : {}),
    }
  }

  /**
   * 创建全新 live agent 会话（可选 fork seed 与父会话谱系）。
   * @param spec - cwd、seed 事件与可选 parentSession。
   * @returns 拥有会话的 agent 句柄。
   */
  async createSession(spec: NewSessionSpec): Promise<AgentHandle> {
    const sessionId = SessionId(`acp-${randomUUID()}`)
    const options: CreateAgentOptions = {
      sessionId,
      meta: {
        cwd: spec.cwd,
        ...(spec.parentSession !== undefined ? { parentSession: spec.parentSession } : {}),
      },
      ...(spec.seed !== undefined && spec.seed.length > 0 ? { seed: spec.seed } : {}),
      agentOptions: this.agentOptions(spec.model),
    }
    return await this.ctx.agents.create(options)
  }

  /**
   * 从持久化日志恢复 live agent。
   * @param sessionId - 已持久化会话 id。
   * @param model - 已解析的模型选择；注入 agentOptions 使子代理可继承。
   * @returns 恢复后的 agent 句柄。
   */
  async resumeSession(sessionId: string, model?: ModelSelection): Promise<AgentHandle> {
    const options: ResumeAgentOptions = {
      resumeSessionId: SessionId(sessionId),
      agentOptions: this.agentOptions(model),
    }
    return await this.ctx.agents.resume(options)
  }

  /**
   * 读一个会话的完整事件日志（live 优先，回退持久化查询）。
   * @param sessionId - 会话 id。
   * @returns 该会话的完整事件序列。
   */
  async readSessionEvents(sessionId: string): Promise<readonly SessionEvent[]> {
    const live = this.ctx.sessions.get(SessionId(sessionId))
    if (live) return live.events
    const query = this.ctx.get('session-query') as SessionQueryEngine | undefined
    if (query) {
      const log = await query.readSession(SessionId(sessionId))
      return log.events
    }
    throw new Error(`session ${sessionId} not found`)
  }

  /**
   * 列出会话（live + 持久化）。
   * @returns 头部与存在性标记。
   */
  async listSessions(): Promise<ListedSession[]> {
    const query = this.ctx.get('session-query') as SessionQueryEngine | undefined
    if (query) {
      const records = await query.listSessions()
      return records.map(record => ({ header: record.header, live: record.live, persisted: record.persisted }))
    }
    return this.ctx.sessions.list().map(session => ({ header: session.header, live: true, persisted: false }))
  }

  /**
   * 从事件日志读会话标题（最后一个 `session/title`）。
   * @param events - 会话事件日志。
   * @returns 标题或 undefined。
   */
  titleFrom(events: readonly SessionEvent[]): string | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type === 'session/title') {
        const data = event.data as { title?: unknown }
        if (typeof data.title === 'string') return data.title
      }
    }
    return undefined
  }

  /**
   * 从事件日志重建最后一次模型请求的持久化选择（provider/model/effort）。
   * dsh 把每次模型请求的 `LlmCallConfig` 写进 `request/header` 事件；
   * `foldRequestHeader` 取最新快照，由此恢复 resume/load 时应继承的模型与思考等级。
   * @param events - 会话事件日志。
   * @returns 持久化的模型选择，或 undefined（日志无 request/header）。
   */
  resolvePersistedModel(events: readonly SessionEvent[]): { model: ModelSelection; effort?: string } | undefined {
    const header: EpochHeader | undefined = foldRequestHeader(events)
    if (header === undefined) return undefined
    const { provider, model, reasoningEffort } = header.config
    if (typeof provider !== 'string' || typeof model !== 'string') return undefined
    return {
      model: { provider, model },
      ...(reasoningEffort !== undefined ? { effort: reasoningEffort } : {}),
    }
  }

  /**
   * fork 用的平衡前缀：最后一个 `turn/end`（含）之前的事件。
   * @param events - 父会话事件日志。
   * @returns 可作为子会话 seed 的事件切片。
   */
  forkSeed(events: readonly SessionEvent[]): readonly SessionEvent[] {
    let boundary = -1
    for (let i = 0; i < events.length; i++) {
      if (events[i]?.type === 'turn/end') boundary = i
    }
    return events.slice(0, boundary + 1)
  }

  /**
   * 列出 dsh LLM provider 路由。
   * @returns ACP provider 条目；dsh 不暴露 wire 协议，故 supported 为空、provider 均为必需。
   */
  listProviders(): { providerId: string; name: string; supported: string[]; required: boolean }[] {
    const llm = this.ctx.get('llm') as { listProviders?: () => { id: string; name: string }[] } | undefined
    if (!llm?.listProviders) return []
    return llm.listProviders().map(provider => ({
      providerId: provider.id,
      name: provider.name,
      supported: [],
      required: true,
    }))
  }

  /**
   * 列出所有 provider 的所有模型，供 model config option 使用。
   * 遍历 `listProviders()` 后对每个 provider 调 `listModels()`；任一失败则该 provider 贡献空列表。
   * @returns provider 分组的模型列表。
   */
  async listAllModels(): Promise<ProviderModels[]> {
    const llm = this.ctx.get('llm') as {
      listProviders?: () => { id: string; name: string }[]
      listModels?: (provider: string) => Promise<{ id: string; name: string; description?: string }[]>
    } | undefined
    if (!llm?.listProviders || !llm.listModels) return []
    const providers = llm.listProviders()
    const result: ProviderModels[] = []
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.id)
        result.push({ providerId: provider.id, providerName: provider.name, models })
      } catch {
        // provider 不可达时贡献空列表，不阻断其他 provider
      }
    }
    return result
  }

  /**
   * 解析一个 provider/model 的可选思考等级（reasoning efforts）。
   * @returns effort id 与名称列表；无 reasoning 能力时返回空。
   */
  async resolveModelReasoning(provider: string, model: string): Promise<{ id: string; name: string; description?: string }[]> {
    const llm = this.ctx.get('llm') as {
      resolveModelInfo?: (provider: string, model: string) => Promise<{ reasoning?: { efforts: { id: string; name: string; description?: string }[] } }>
    } | undefined
    if (!llm?.resolveModelInfo) return []
    try {
      const info = await llm.resolveModelInfo(provider, model)
      return info.reasoning?.efforts ?? []
    } catch {
      return []
    }
  }

  /** 一个 agent preset 条目（config option 用）。 */
  async listPresets(): Promise<{ id: string; name: string; description?: string }[]> {
    const presets = this.ctx.get('agentPresets') as { list?: () => Promise<{ id: string; name: string; description?: string }[]> } | undefined
    if (!presets?.list) return []
    try {
      return await presets.list()
    } catch {
      return []
    }
  }

  /**
   * 动态切换一个 agent 的 preset（mode）。
   * @param agentCtx - agent 作用域上下文。
   * @param presetId - 目标 preset id。
   */
  async recomposePreset(agentCtx: Context, presetId: string): Promise<void> {
    const presets = this.ctx.get('agentPresets') as { recompose?: (agentCtx: Context, id: string) => Promise<unknown> } | undefined
    if (!presets?.recompose) throw new Error('agent presets service is not available; cannot switch mode')
    await presets.recompose(agentCtx, presetId)
  }

  /** 全部可选的 sandbox 模式（config option 用）。 */
  sandboxModes(): readonly SandboxMode[] {
    return SANDBOX_MODES
  }

  /**
   * 读取一个会话当前生效的 sandbox 模式：会话覆写优先，否则部署默认。
   * 无 sandbox-policy 服务时返回 undefined（sandbox 不可用）。
   * @param session - 目标会话。
   * @returns 当前生效的 sandbox 模式，或 undefined。
   */
  resolveSandboxMode(session: Session): SandboxMode | undefined {
    const policy = this.ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
    if (!policy) return undefined
    return policy.resolve({ session }).mode
  }

  /**
   * 读取部署默认 sandbox 模式（无会话时用）。
   * 无 sandbox-policy 服务时返回 undefined。
   */
  defaultSandboxMode(): SandboxMode | undefined {
    const policy = this.ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
    return policy?.defaultMode
  }

  /**
   * 切换一个会话的 sandbox 模式：追加 `sandbox/mode` 事件到会话日志。
   * 无 sandbox-policy 服务时抛错（sandbox 不可用）。
   * @param session - 目标会话。
   * @param mode - 目标 sandbox 模式。
   */
  setSandboxMode(session: Session, mode: SandboxMode): void {
    const policy = this.ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
    if (!policy) throw new Error('sandbox policy service is not available; cannot switch sandbox mode')
    setSandboxMode(session, mode)
  }
}
