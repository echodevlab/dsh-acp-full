/** ACP v1 协议级测试：in-process client 直连 v1 agent app。@module dsh-acp-full/tests/v1-protocol */

import { describe, expect, test } from 'bun:test'
import { PROTOCOL_VERSION, client } from '@agentclientprotocol/sdk'
import { createV1App } from '../src/server/v1.ts'
import { cwd, makeBridge, makeCore, makeState } from './helpers.ts'

/** 建一条 v1 连接（client app ↔ 我们的 agent app）。 */
function connect() {
  const state = makeState()
  const app = createV1App(makeCore(state), makeBridge(state), {}, undefined, () => {})
  const conn = client().connect(app)
  return { state, conn }
}

async function initialize(conn: ReturnType<typeof connect>['conn']) {
  return conn.agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
}

describe('ACP v1 协议', () => {
  test('initialize 返回 v1 能力', async () => {
    const { conn } = connect()
    const response = await initialize(conn)
    expect(response.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(response.agentCapabilities?.loadSession).toBe(true)
    expect(response.agentCapabilities?.promptCapabilities?.image).toBe(true)
    expect(response.agentCapabilities?.promptCapabilities?.audio).toBe(false)
    expect(response.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true)
    expect(response.agentCapabilities?.sessionCapabilities?.list).toBeTruthy()
    expect(response.agentCapabilities?.sessionCapabilities?.fork).toBeTruthy()
    expect(response.agentCapabilities?.sessionCapabilities?.resume).toBeTruthy()
    expect(response.agentCapabilities?.sessionCapabilities?.close).toBeTruthy()
  })

  test('session/new 创建会话并返回 modes', async () => {
    const { conn } = connect()
    await initialize(conn)
    const response = await conn.agent.request('session/new', { cwd, mcpServers: [] })
    expect(response.sessionId).toBe('acp-test-1')
    expect(response.modes?.currentModeId).toBe('standard')
    expect(response.modes?.availableModes.map(mode => mode.id)).toEqual(['standard', 'code'])
  })

  test('session/new 相对 cwd 被拒绝', async () => {
    const { conn } = connect()
    await initialize(conn)
    await expect(conn.agent.request('session/new', { cwd: 'relative/path' })).rejects.toThrow()
  })

  test('session/prompt 返回 stopReason 与 usage', async () => {
    const { conn, state } = connect()
    await initialize(conn)
    const created = await conn.agent.request('session/new', { cwd, mcpServers: [] })
    const response = await conn.agent.request('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })
    expect(response.stopReason).toBe('end_turn')
    expect(response.usage?.totalTokens).toBe(5)
    expect(response.usage?.inputTokens).toBe(3)
    expect(state.prompts).toBe(1)
  })

  test('未知会话的 prompt 被拒绝', async () => {
    const { conn } = connect()
    await initialize(conn)
    await expect(conn.agent.request('session/prompt', {
      sessionId: 'missing',
      prompt: [{ type: 'text', text: 'hi' }],
    })).rejects.toThrow()
  })

  test('session/cancel 通知取消当前会话', async () => {
    const { conn, state } = connect()
    await initialize(conn)
    const created = await conn.agent.request('session/new', { cwd, mcpServers: [] })
    await conn.agent.notify('session/cancel', { sessionId: created.sessionId })
    await Bun.sleep(50) // notify 是 fire-and-forget，等通知派发
    expect(state.cancelled).toEqual([created.sessionId])
  })

  test('session/delete 被拒绝（dsh 仅追加）', async () => {
    const { conn } = connect()
    await initialize(conn)
    await expect(conn.agent.request('session/delete', { sessionId: 's1' })).rejects.toThrow()
  })

  test('session/list 返回持久化会话', async () => {
    const { conn } = connect()
    await initialize(conn)
    const response = await conn.agent.request('session/list', {})
    expect(response.sessions.length).toBe(1)
    expect(response.sessions[0]?.sessionId).toBe('s1')
    expect(response.sessions[0]?.cwd).toBe(cwd)
  })

  test('session/load 恢复会话并重放历史（ACP 协议）', async () => {
    const { conn, state } = connect()
    await initialize(conn)
    const response = await conn.agent.request('session/load', { sessionId: 's9', cwd, mcpServers: [] })
    expect(response.modes?.currentModeId).toBe('standard')
    expect(state.resumed).toEqual(['s9'])
    // ACP 协议：session/load MUST replay 整个对话历史。
    expect(state.replays).toBe(1)
  })

  test('session/resume 恢复会话但不重放历史（ACP 协议）', async () => {
    const { conn, state } = connect()
    await initialize(conn)
    const response = await conn.agent.request('session/resume', { sessionId: 's9', cwd })
    expect(response.modes?.currentModeId).toBe('standard')
    expect(state.resumed).toEqual(['s9'])
    // ACP 协议：session/resume MUST NOT replay 对话历史。
    expect(state.replays).toBe(0)
  })

  test('session/load 从持久化日志恢复模型选择', async () => {
    const { conn, state } = connect()
    state.persistedModel = { model: { provider: 'deepseek', model: 'deepseek-reasoner' }, effort: 'high' }
    await initialize(conn)
    await conn.agent.request('session/load', { sessionId: 's9', cwd, mcpServers: [] })
    expect(state.resumed).toEqual(['s9'])
  })

  test('session/resume 从持久化日志恢复模型选择', async () => {
    const { conn, state } = connect()
    state.persistedModel = { model: { provider: 'deepseek', model: 'deepseek-reasoner' }, effort: 'high' }
    await initialize(conn)
    await conn.agent.request('session/resume', { sessionId: 's9', cwd })
    expect(state.resumed).toEqual(['s9'])
  })

  test('providers/list 返回 dsh provider 路由', async () => {
    const { conn } = connect()
    await initialize(conn)
    const response = await conn.agent.request('providers/list', {})
    expect(response.providers).toEqual([{
      providerId: 'deepseek',
      name: 'DeepSeek',
      supported: [],
      required: true,
    }])
  })

  test('session/set_mode 切换 agent preset', async () => {
    const { conn } = connect()
    await initialize(conn)
    const created = await conn.agent.request('session/new', { cwd, mcpServers: [] })
    const response = await conn.agent.request('session/set_mode', { sessionId: created.sessionId, modeId: 'code' })
    expect(response).toEqual({})
  })

  test('session/set_config_option 被拒绝（不支持）', async () => {
    const { conn } = connect()
    await initialize(conn)
    await expect(conn.agent.request('session/set_config_option', { sessionId: 's1', option: { configId: 'x', value: true } })).rejects.toThrow()
  })

  test('不支持的请求面被拒绝', async () => {
    const { conn } = connect()
    await initialize(conn)
    await expect(conn.agent.request('authenticate', {})).rejects.toThrow()
    await expect(conn.agent.request('providers/set', {})).rejects.toThrow()
    await expect(conn.agent.request('logout', {})).rejects.toThrow()
    await expect(conn.agent.request('nes/start', {})).rejects.toThrow()
  })
})
