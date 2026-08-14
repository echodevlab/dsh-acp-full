/** 事件 → 中立更新映射与 stop reason 转换。@module dsh-acp-full/tests/mapping */

import { describe, expect, test } from 'bun:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assistantMessageId, mapSessionEvent, stopReasonFor, toolKindFor } from '../src/server/mapping.ts'

/** 最小事件构造。 */
function event(type: string, data: unknown): SessionEvent {
  return { type, data, seq: 1, time: Date.now() } as SessionEvent
}

describe('mapSessionEvent', () => {
  test('user/message 文本 → user_message_chunk', () => {
    const updates = mapSessionEvent(event('user/message', {
      id: 'm1',
      content: [{ type: 'text', text: 'hello' }],
    }))
    expect(updates).toEqual([{ kind: 'user_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hello' } }])
  })

  test('assistant/chunk text-delta → agent_message_chunk（合成 id）', () => {
    const updates = mapSessionEvent(event('assistant/chunk', {
      turn: 2,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'hi' },
    }))
    expect(updates).toEqual([{ kind: 'agent_message_chunk', messageId: assistantMessageId(2, 1), content: { type: 'text', text: 'hi' } }])
  })

  test('assistant/chunk reasoning-delta → agent_thought_chunk', () => {
    const updates = mapSessionEvent(event('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' },
    }))
    expect(updates).toEqual([{ kind: 'agent_thought_chunk', messageId: assistantMessageId(1, 1), content: { type: 'text', text: 'thinking' } }])
  })

  test('tool/call → tool_call（in_progress，参数安全解析）', () => {
    const updates = mapSessionEvent(event('tool/call', {
      turn: 1,
      step: 1,
      callId: 'c1',
      name: 'shell',
      arguments: '{"cmd":"ls"}',
    }))
    expect(updates).toEqual([{
      kind: 'tool_call',
      toolCallId: 'c1',
      title: 'shell',
      toolKind: 'execute',
      status: 'in_progress',
      name: 'shell',
      rawInput: { cmd: 'ls' },
    }])
  })

  test('tool/call 非法 JSON 参数 → 原始字符串', () => {
    const updates = mapSessionEvent(event('tool/call', {
      turn: 1, step: 1, callId: 'c2', name: 'todo', arguments: 'not-json',
    }))
    expect(updates[0]?.rawInput).toBe('not-json')
  })

  test('tool/result 成功 → tool_call_update completed', () => {
    const updates = mapSessionEvent(event('tool/result', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
    }))
    expect(updates).toEqual([{
      kind: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'text', text: 'ok' }],
    }])
  })

  test('tool/result 带 meta.diffs → tool_call_update 含 diff content', () => {
    const updates = mapSessionEvent(event('tool/result', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
      meta: { diffs: [{ path: 'a.txt', oldText: 'old', newText: 'new' }] },
    }))
    expect(updates).toEqual([{
      kind: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'diff', path: 'a.txt', oldText: 'old', newText: 'new' },
      ],
    }])
  })

  test('tool/result 带 meta.diffs（新文件 oldText=null）→ diff content', () => {
    const updates = mapSessionEvent(event('tool/result', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'created' }] }] },
      meta: { diffs: [{ path: 'new.txt', oldText: null, newText: 'fresh\n' }] },
    }))
    expect(updates[0]?.content).toEqual([
      { type: 'text', text: 'created' },
      { type: 'diff', path: 'new.txt', oldText: null, newText: 'fresh\n' },
    ])
  })

  test('tool/result 带 error → tool_call_update failed', () => {
    const updates = mapSessionEvent(event('tool/result', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'boom' }], isError: true }] },
      error: { name: 'ToolError', code: 'FAILED' },
    }))
    expect(updates).toEqual([{
      kind: 'tool_call_update',
      toolCallId: 'c1',
      status: 'failed',
      toolKind: 'other',
      content: [{ type: 'text', text: 'boom' }],
    }])
  })

  test('todo/write → plan', () => {
    const updates = mapSessionEvent(event('todo/write', {
      todos: [
        { content: 'first', status: 'completed' },
        { content: 'second', status: 'in_progress' },
      ],
    }))
    expect(updates).toEqual([{
      kind: 'plan',
      entries: [
        { content: 'first', priority: 'medium', status: 'completed' },
        { content: 'second', priority: 'medium', status: 'in_progress' },
      ],
    }])
  })

  test('todo/write 空 → plan_removed', () => {
    expect(mapSessionEvent(event('todo/write', { todos: [] }))).toEqual([{ kind: 'plan_removed' }])
  })

  test('plan/mode → current_mode_update', () => {
    expect(mapSessionEvent(event('plan/mode', { active: true }))).toEqual([{ kind: 'current_mode_update', modeId: 'plan' }])
    expect(mapSessionEvent(event('plan/mode', { active: false }))).toEqual([{ kind: 'current_mode_update', modeId: 'default' }])
  })

  test('session/title → session_info_update', () => {
    expect(mapSessionEvent(event('session/title', { title: 'My task' }))).toEqual([{ kind: 'session_info_update', title: 'My task' }])
  })

  test('request/header → available_commands_update', () => {
    const updates = mapSessionEvent(event('request/header', {
      header: {
        config: { provider: 'deepseek', model: 'chat' },
        tools: [{ name: 'todo', description: 'track tasks', parameters: {} }],
      },
      reason: 'initial',
    }))
    expect(updates).toEqual([{
      kind: 'available_commands_update',
      commands: [{ name: 'todo', description: 'track tasks' }],
    }])
  })

  test('边界事件不产生更新', () => {
    expect(mapSessionEvent(event('turn/start', { turn: 1 }))).toEqual([])
    expect(mapSessionEvent(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))).toEqual([])
    expect(mapSessionEvent(event('step/start', { turn: 1, step: 1 }))).toEqual([])
  })
})

describe('stopReasonFor', () => {
  test('turn 原因映射', () => {
    expect(stopReasonFor({ kind: 'completed' })).toBe('end_turn')
    expect(stopReasonFor({ kind: 'interrupted' })).toBe('cancelled')
    expect(stopReasonFor({ kind: 'aborted', reason: { kind: 'user' } } as never)).toBe('cancelled')
    expect(stopReasonFor({ kind: 'blocked' })).toBe('end_turn')
    expect(stopReasonFor({ kind: 'error' } as never)).toBe('end_turn')
    // 插件扩展的 max-tokens kind
    expect(stopReasonFor({ kind: 'max-tokens' } as never)).toBe('max_tokens')
  })
})

describe('toolKindFor', () => {
  test('名字启发式', () => {
    expect(toolKindFor('shell')).toBe('execute')
    expect(toolKindFor('read_file')).toBe('read')
    expect(toolKindFor('grep')).toBe('search')
    expect(toolKindFor('write_file')).toBe('edit')
    expect(toolKindFor('fetch_url')).toBe('fetch')
    expect(toolKindFor('todo_write')).toBe('think')
    expect(toolKindFor('mystery_tool')).toBe('other')
  })
})
