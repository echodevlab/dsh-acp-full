/** 连接核心：会话注册表、事件接线、权限桥、turn 结算与连接清理。@module dsh-acp-full/server/core */

import type { StopReason } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { SessionSelection } from './config-options.ts'
import { mapSessionEvent, stopReasonFor, type NeutralUpdate } from './mapping.ts'

/** 与版本无关的 client 调用面（v1/v2 AgentContext 均满足）。 */
export interface AcpClientCall {
  request(method: string, params?: unknown): Promise<unknown>
  notify(method: string, params?: unknown): Promise<void>
}

/** 把中立更新发到 client 的传输函数（版本相关，由 v1/v2 层注入）。 */
export type EmitFn = (sessionId: SessionIdType, updates: readonly NeutralUpdate[]) => Promise<void>

export interface SessionRecord {
  sessionId: SessionIdType
  agent: Agent
  handle: AgentHandle
  inflight: Inflight | null
  selection: SessionSelection
  /** agent/request waterfall disposer，closeSession 时释放。 */
  disposeRequestHook: (() => void) | null
  usage: { input: number; output: number }
  /**
   * 当前 drive 的用户消息 id；该消息的 `user/message` 事件回显被抑制
   * （客户端发 prompt 时已自行显示，回显会导致重复）。turn 结束后清除。
   */
  suppressUserMessageId: string | null
}

export interface Inflight {
  resolve: (stopReason: StopReason) => void
  reject: (error: unknown) => void
}

export interface PromptOutcome {
  stopReason: StopReason
  inputTokens: number
  outputTokens: number
}

/**
 * 单个 ACP 连接的核心状态与接线。
 * initialize 时经 {@link activate} 绑定 client 与传输；事件监听按会话归属过滤。
 */
export class ConnectionCore {
  readonly sessions = new Map<SessionIdType, SessionRecord>()
  private activeClient: AcpClientCall | null = null
  private emitFn: EmitFn | null = null
  private disposers: (() => void)[] = []
  private closed = false

  constructor(
    private readonly ctx: Context,
    private readonly logger: (message: string) => void,
  ) {}

  /**
   * 连接初始化时调用一次：绑定 client 与传输并开始事件接线。
   * @param client - 该连接的 client 调用面。
   * @param emit - 版本相关的中立更新传输。
   */
  activate(client: AcpClientCall, emit: EmitFn): void {
    if (this.activeClient) return
    this.activeClient = client
    this.emitFn = emit
    this.disposers.push(this.ctx.on('session/event', (session, event) => void this.onSessionEvent(session, event)))
    this.disposers.push(this.ctx.on('agent/status', ({ agent, status }) => void this.onAgentStatus(agent, status)))
    this.disposers.push(this.ctx.on('agent/error', payload => this.onAgentError(payload.agent, payload.error)))
  }

  /**
   * 注册一个 agent 句柄为受管会话，并在 agent 作用域注册 `agent/request`
   * waterfall 把当前 model/effort 选择注入每次模型请求。
   * @param handle - 创建/恢复得到的 agent 句柄。
   * @param selection - 初始会话选择（mode/model/effort）。
   * @returns 该会话的记录。
   */
  register(handle: AgentHandle, selection: SessionSelection): SessionRecord {
    const record: SessionRecord = {
      sessionId: handle.agent.session.id,
      agent: handle.agent,
      handle,
      inflight: null,
      selection,
      disposeRequestHook: null,
      usage: { input: 0, output: 0 },
      suppressUserMessageId: null,
    }
    // 在 agent 作用域注册 agent/request waterfall，把 selection 的 provider/model/effort 注入请求。
    const dispose = handle.agent.ctx.on(
      'agent/request',
      async (_payload, next): Promise<LlmCallConfig> => {
        const resolved = await next()
        const sel = record.selection
        const { reasoningEffort: _inherited, ...rest } = resolved
        return {
          ...rest,
          provider: sel.model.provider,
          model: sel.model.model,
          ...(sel.effort !== undefined ? { reasoningEffort: sel.effort as LlmCallConfig['reasoningEffort'] } : {}),
        }
      },
    )
    record.disposeRequestHook = dispose
    this.sessions.set(record.sessionId, record)
    return record
  }

  /** 按 id 查会话记录。 */
  get(id: SessionIdType): SessionRecord | undefined {
    return this.sessions.get(id)
  }

  /**
   * 把 agent.options 同步为当前 selection 的模型，使子代理（经
   * resolveChildAgentOptions 读 parent.options）继承切换后的模型而非创建时的初始模型。
   * agent.options 引用不可变但属性可变（AgentOptions 无 readonly 属性），直接赋值即可。
   * @param record - 已更新 selection 的会话记录。
   */
  syncAgentModel(record: SessionRecord): void {
    record.agent.options.provider = record.selection.model.provider
    record.agent.options.model = record.selection.model.model
  }

  /**
   * 重放一个会话的既有事件（resume 后回放历史给 client）。
   * @param record - 目标会话记录。
   * @param events - 已提交的完整事件日志。
   */
  async replay(record: SessionRecord, events: readonly SessionEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type === 'assistant/message') {
        const usage = event.data.usage
        if (usage) {
          record.usage.input += usage.inputTokens
          record.usage.output += usage.outputTokens
        }
      }
      const updates = mapSessionEvent(event)
      if (updates.length === 0) continue
      await this.emit(record.sessionId, updates)
    }
  }

  /**
   * 运行一个 prompt 直到 turn 结算。
   * @param record - 目标会话记录。
   * @param message - 已转换的用户消息。
   * @returns 停止原因与本 turn 的 token 增量。
   */
  async drive(record: SessionRecord, message: UserMessage): Promise<PromptOutcome> {
    if (record.inflight) throw new Error('session already has a prompt in flight')
    const beforeInput = record.usage.input
    const beforeOutput = record.usage.output
    // 抑制当前 prompt 用户消息的回显：客户端发 prompt 时已自行显示，
    // dsh 产生的 user/message 事件再回显会导致重复。turn 结束后清除。
    record.suppressUserMessageId = message.id
    const stopReason = await new Promise<StopReason>((resolve, reject) => {
      record.inflight = { resolve, reject }
      record.agent.followup(message)
    })
    record.suppressUserMessageId = null
    return {
      stopReason,
      inputTokens: record.usage.input - beforeInput,
      outputTokens: record.usage.output - beforeOutput,
    }
  }

  /** 取消当前 inflight prompt（用户取消）。 */
  cancel(record: SessionRecord): void {
    record.agent.cancel({ kind: 'user' })
  }

  /**
   * 关闭一个会话：结算 inflight、dispose agent（会话日志仍持久化）。
   * @param id - 会话 id。
   */
  async closeSession(id: SessionIdType): Promise<void> {
    const record = this.sessions.get(id)
    if (!record) return
    this.sessions.delete(id)
    if (record.inflight) {
      const inflight = record.inflight
      record.inflight = null
      inflight.reject(new Error('session closed'))
    }
    record.disposeRequestHook?.()
    await record.handle.dispose()
  }

  /** 连接关闭清理：断开事件订阅并关掉所有会话。 */
  async quiesce(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const dispose of this.disposers.splice(0)) dispose()
    this.activeClient = null
    this.emitFn = null
    for (const id of this.sessions.keys()) {
      await this.closeSession(id)
    }
  }

  /**
   * 权限瀑布：把 dsh approval 请求桥给 ACP 客户端。
   * 无活跃连接或请求不属于本连接时委托给下一级 answerer。
   * @param req - dsh 审批请求。
   * @param next - 瀑布后继。
   * @returns dsh 审批结果。
   */
  async onApproval(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    if (this.closed || !this.activeClient) return next()
    const record = this.recordFor(req.agent)
    if (!record) return next()
    const client = this.activeClient
    try {
      const response = await client.request('session/request_permission', {
        sessionId: record.sessionId,
        toolCall: {
          toolCallId: req.callId ?? `approval-${Date.now()}`,
          title: req.toolName,
          name: req.toolName,
          kind: 'other',
          status: 'pending',
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
      }) as { outcome?: { outcome?: string; optionId?: string } }
      const outcome = response.outcome?.outcome
      if (outcome === 'cancelled') return 'cancelled'
      if (outcome === 'selected') {
        if (response.outcome?.optionId === 'allow-once') return 'allowed-once'
        if (response.outcome?.optionId === 'reject-once') return 'rejected'
      }
      return 'unavailable'
    } catch (error) {
      this.logger(`permission bridge failed: ${String(error)}`)
      return next()
    }
  }

  private recordFor(agent: Agent): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.agent === agent) return record
    }
    return undefined
  }

  private async onSessionEvent(session: Session, event: SessionEvent): Promise<void> {
    const record = this.sessions.get(session.id)
    if (!record || record.agent.session !== session) return
    if (event.type === 'assistant/message') {
      const usage = event.data.usage
      if (usage) {
        record.usage.input += usage.inputTokens
        record.usage.output += usage.outputTokens
      }
    }
    const updates: NeutralUpdate[] = mapSessionEvent(event)
    // 抑制当前 drive 用户消息的回显（客户端发 prompt 时已自行显示）。
    if (record.suppressUserMessageId !== null) {
      for (let i = updates.length - 1; i >= 0; i--) {
        const u = updates[i]
        if (u?.kind === 'user_message_chunk' && u.messageId === record.suppressUserMessageId) {
          updates.splice(i, 1)
        }
      }
    }
    if (event.type === 'turn/end') {
      const inflight = record.inflight
      if (inflight) {
        record.inflight = null
        inflight.resolve(stopReasonFor(event.data.reason))
      }
      updates.push({ kind: 'state_update', state: 'idle', stopReason: stopReasonFor(event.data.reason) })
    }
    if (updates.length === 0) return
    await this.emit(record.sessionId, updates)
  }

  private async onAgentStatus(agent: Agent, status: 'idle' | 'running'): Promise<void> {
    const record = this.recordFor(agent)
    if (!record) return
    await this.emit(record.sessionId, [{ kind: 'state_update', state: status }])
  }

  private onAgentError(agent: Agent, error: unknown): void {
    const record = this.recordFor(agent)
    if (!record) return
    const inflight = record.inflight
    if (inflight) {
      record.inflight = null
      inflight.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async emit(sessionId: SessionIdType, updates: readonly NeutralUpdate[]): Promise<void> {
    if (!this.emitFn) return
    try {
      await this.emitFn(sessionId, updates)
    } catch (error) {
      this.logger(`session update emission failed: ${String(error)}`)
    }
  }
}
