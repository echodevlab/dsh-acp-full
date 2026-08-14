/** ACP v2 draft 协议级测试：in-process client 直连 v2 agent app。@module dsh-acp-full/tests/v2-protocol */

import { describe, expect, test } from 'bun:test'
import { PROTOCOL_VERSION, client } from '@agentclientprotocol/sdk/experimental/v2'
import { createV2App } from '../src/server/v2.ts'
import { cwd, makeBridge, makeCore, makeState } from './helpers.ts'

/** 建一条 v2 连接（client app ↔ 我们的 agent app）。 */
function connect() {
  const state = makeState()
  const app = createV2App(makeCore(state), makeBridge(state), {}, undefined, () => {})
  const conn = client().connect(app)
  return { state, conn }
}

async function initialize(conn: ReturnType<typeof connect>['conn']) {
  return conn.agent.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    info: { name: 'test-client', title: 'Test Client', version: '0.0.0' },
  })
}

describe('ACP v2 协议', () => {
  test('initialize 返回 v2 能力与实现信息', async () => {
    const { conn } = connect()
    const response = await initialize(conn)
    expect(response.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(response.info.name).toBe('dsh-acp-full')
    expect(response.capabilities?.session?.prompt?.image).toBeTruthy()
    expect(response.capabilities?.session?.prompt?.embeddedContext).toBeTruthy()
    expect(response.capabilities?.session?.fork).toBeTruthy()
  })

  test('session/new 创建会话', async () => {
    const { conn } = connect()
    await initialize(conn)
    const response = await conn.agent.request('session/new', { cwd, mcpServers: [] })
    expect(response.sessionId).toBe('acp-test-1')
  })

  test('session/new 相对 cwd 被拒绝', async () => {
    const { conn } = connect()
    await initialize(conn)
    await expect(conn.agent.request('session/new', { cwd: 'relative/path' })).rejects.toThrow()
  })

  test('session/prompt 空响应（stop reason 走 state_update）', async () => {
    const { conn, state } = connect()
    await initialize(conn)
    const created = await conn.agent.request('session/new', { cwd, mcpServers: [] })
    const response = await conn.agent.request('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })
    expect(response).toEqual({})
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

  test('session/resume 恢复会话但不重放历史（ACP 协议）', async () => {
    const { conn, state } = connect()
    await initialize(conn)
    const response = await conn.agent.request('session/resume', { sessionId: 's9', cwd })
    expect(response.configOptions).toHaveLength(3)
    expect(response.configOptions[0].configId).toBe('mode')
    expect(response.configOptions[1].configId).toBe('model')
    expect(response.configOptions[2].configId).toBe('sandbox')
    expect(response.configOptions[0].currentValue).toBe('standard')
    expect(response.configOptions[2].currentValue).toBe('read-only')
    expect(state.resumed).toEqual(['s9'])
    // ACP 协议：session/resume MUST NOT replay 对话历史。
    expect(state.replays).toBe(0)
  })

  test('session/resume 从持久化日志恢复模型选择', async () => {
    const { conn, state } = connect()
    state.persistedModel = { model: { provider: 'deepseek', model: 'deepseek-reasoner' }, effort: 'high' }
    await initialize(conn)
    const response = await conn.agent.request('session/resume', { sessionId: 's9', cwd })
    expect(state.resumed).toEqual(['s9'])
    // 持久化的 model 选择应反映在 config option 的 currentValue 中。
    const modelOption = response.configOptions.find((o: { configId: string }) => o.configId === 'model')
    expect(modelOption.currentValue).toBe('deepseek/deepseek-reasoner')
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

  test('session/set_config_option 切换 sandbox 模式', async () => {
    const { conn } = connect()
    await initialize(conn)
    const created = await conn.agent.request('session/new', { cwd, mcpServers: [] })
    const response = await conn.agent.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: 'sandbox',
      value: 'workspace-write',
      type: 'id',
    })
    const sandboxOption = response.configOptions.find((o: { configId: string }) => o.configId === 'sandbox')
    expect(sandboxOption.currentValue).toBe('workspace-write')
  })

  test('session/set_config_option 拒绝非法 sandbox 值', async () => {
    const { conn } = connect()
    await initialize(conn)
    const created = await conn.agent.request('session/new', { cwd, mcpServers: [] })
    await expect(conn.agent.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: 'sandbox',
      value: 'invalid-mode',
      type: 'id',
    })).rejects.toThrow()
  })

  test('不支持的请求面被拒绝', async () => {
    const { conn } = connect()
    await initialize(conn)
    await expect(conn.agent.request('auth/login', {})).rejects.toThrow()
    await expect(conn.agent.request('providers/set', {})).rejects.toThrow()
    await expect(conn.agent.request('session/set_config_option', { sessionId: 's1', option: { configId: 'x', value: true } })).rejects.toThrow()
    await expect(conn.agent.request('mcp/message', {})).rejects.toThrow()
    await expect(conn.agent.request('nes/start', {})).rejects.toThrow()
  })
})
