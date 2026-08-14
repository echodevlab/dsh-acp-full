/** 协议测试共享 fake：无 dsh 运行时，直接驱动 v1/v2 handler 面。@module dsh-acp-full/tests/helpers */

import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { DshBridge } from '../src/server/bridge.ts'
import { ConnectionCore } from '../src/server/core.ts'

/** 跨平台绝对路径（dsh 校验绝对 cwd）。 */
export const cwd = process.platform === 'win32' ? 'C:/' : '/tmp'

export interface FakeState {
  cancelled: string[]
  resumed: string[]
  closed: string[]
  prompts: number
  /** replay 调用次数（验证 session/load 回放、session/resume 不回放）。 */
  replays: number
  /** 持久化模型选择（模拟 request/header 事件日志重建结果）。 */
  persistedModel?: { model: { provider: string; model: string }; effort?: string }
}

export function makeState(): FakeState {
  return { cancelled: [], resumed: [], closed: [], prompts: 0, replays: 0 }
}

/** 最小 agent 句柄。 */
export function makeHandle(sessionId: string): AgentHandle {
  return {
    agent: {
      session: { id: SessionId(sessionId), events: [] },
      followup() {},
      cancel() {},
      whenIdle: async () => {},
    },
    dispose: async () => {},
  } as unknown as AgentHandle
}

/** 记录调用的假 bridge。 */
export function makeBridge(state: FakeState): DshBridge {
  return {
    createSession: async () => makeHandle('acp-test-1'),
    resumeSession: async (id: string) => {
      state.resumed.push(id)
      return makeHandle(id)
    },
    readSessionEvents: async () => [],
    resolvePersistedModel: () => state.persistedModel,
    forkSeed: (events: readonly unknown[]) => events,
    listSessions: async () => [{
      header: { version: 0, id: SessionId('s1'), createdAt: 0, cwd },
      live: true,
      persisted: false,
    }],
    listProviders: () => [{ providerId: 'deepseek', name: 'DeepSeek', supported: [], required: true }],
    listAllModels: async () => [{ providerId: 'deepseek', providerName: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
    resolveModelReasoning: async () => [],
    listPresets: async () => [{ id: 'standard', name: 'Standard mode' }, { id: 'code', name: 'PTC mode' }],
    recomposePreset: async () => {},
    sandboxModes: () => ['read-only', 'workspace-write', 'danger-full-access'],
    defaultSandboxMode: () => 'read-only',
    resolveSandboxMode: () => undefined,
    setSandboxMode: () => {},
  } as unknown as DshBridge
}

/** 记录调用的假 core：register 存入 map，drive 返回固定结算。 */
export function makeCore(state: FakeState): ConnectionCore {
  const fake = {
    sessions: new Map<SessionIdType, unknown>(),
    activate() {},
    register(handle: AgentHandle, selection: unknown) {
      const record = {
        sessionId: handle.agent.session.id,
        agent: handle.agent,
        handle,
        inflight: null,
        selection,
        disposeRequestHook: null,
        usage: { input: 0, output: 0 },
        suppressUserMessageId: null,
      }
      fake.sessions.set(record.sessionId, record)
      return record
    },
    get(id: SessionIdType) {
      return fake.sessions.get(id)
    },
    replay() {
      state.replays++
    },
    async drive() {
      state.prompts++
      return { stopReason: 'end_turn', inputTokens: 3, outputTokens: 2 }
    },
    cancel(record: { sessionId: SessionIdType }) {
      state.cancelled.push(record.sessionId)
    },
    async closeSession(id: SessionIdType) {
      state.closed.push(id)
      fake.sessions.delete(id)
    },
    async quiesce() {},
    onApproval: async (_req: unknown, next: () => Promise<unknown>) => next(),
  } as unknown as ConnectionCore
  return fake
}

/** 构造一个带 provider/model 的 request/header 事件（模拟持久化日志）。 */
export function requestHeaderEvent(provider: string, model: string, effort?: string): SessionEvent {
  return {
    type: 'request/header',
    seq: 0,
    time: 1,
    data: {
      header: {
        config: {
          provider,
          model,
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        },
      },
      reason: 'initial',
    },
  } as unknown as SessionEvent
}
