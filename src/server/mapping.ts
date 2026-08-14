/** dsh durable session 事件 → 版本中立更新。@module dsh-acp-full/server/mapping */

import type { StopReason, ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock as DshContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap, TurnEndReason } from '@deepseek-ai/dsh-session'

/** 中立内容：text 立即可用；image 由传输层经附件服务异步解析字节；diff 携带文件修改。 */
export type NeutralContent =
  | { type: 'text'; text: string }
  | { type: 'image'; ref: ImageAttachmentRef }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }

export interface NeutralPlanEntry {
  content: string
  priority: 'low' | 'medium' | 'high'
  status: 'pending' | 'in_progress' | 'completed'
}

export interface NeutralCommand {
  name: string
  description: string
}

/** 版本中立的会话更新；v1/v2 传输层各自转换。 */
export type NeutralUpdate =
  | { kind: 'user_message_chunk'; messageId: string; content: NeutralContent }
  | { kind: 'agent_message_chunk'; messageId: string; content: NeutralContent }
  | { kind: 'agent_thought_chunk'; messageId: string; content: NeutralContent }
  | { kind: 'tool_call'; toolCallId: string; title: string; toolKind: ToolKind; status: ToolCallStatus; name: string; rawInput: unknown }
  | { kind: 'tool_call_update'; toolCallId: string; status: ToolCallStatus; toolKind?: ToolKind; content?: NeutralContent[] }
  | { kind: 'plan'; entries: NeutralPlanEntry[] }
  | { kind: 'plan_removed' }
  | { kind: 'current_mode_update'; modeId: string }
  | { kind: 'session_info_update'; title: string }
  | { kind: 'available_commands_update'; commands: NeutralCommand[] }
  | { kind: 'state_update'; state: 'idle' | 'running'; stopReason?: StopReason }

/** assistant 消息的合成 id：把流式 chunk 关联到其 turn/step。 */
export function assistantMessageId(turn: number, step: number): string {
  return `assistant-${turn}-${step}`
}

/** dsh 工具名 → ACP 工具类别（按名字启发式；无匹配时 `other`）。 */
export function toolKindFor(name: string): ToolKind {
  if (/(shell|bash|terminal|exec|run|process)/i.test(name)) return 'execute'
  if (/(todo|plan|think)/i.test(name)) return 'think'
  if (/(read|cat|list|ls|glob)/i.test(name)) return 'read'
  if (/(grep|search|find|rg)/i.test(name)) return 'search'
  if (/(write|edit|patch|replace|create|remove|delete)/i.test(name)) return 'edit'
  if (/(fetch|http|web|url)/i.test(name)) return 'fetch'
  return 'other'
}

/** dsh turn 结束原因 → ACP stop reason（与 dsh 核心 codec 约定一致）。 */
export function stopReasonFor(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed': return 'end_turn'
    case 'interrupted':
    case 'aborted': return 'cancelled'
    default: {
      // Merge-extensible union：插件扩展的 kind（如 agent-loop 的 max-tokens）按字面名映射。
      const kind = (reason as { kind?: string }).kind
      if (kind === 'max-tokens') return 'max_tokens'
      return 'end_turn' // blocked、error 与未来扩展
    }
  }
}

/** dsh 内容块 → 中立内容（reasoning/tool 块与未知块跳过）。 */
export function contentToNeutral(blocks: readonly DshContentBlock[]): NeutralContent[] {
  const result: NeutralContent[] = []
  for (const block of blocks) {
    if (block.type === 'text') result.push({ type: 'text', text: block.text })
    else if (block.type === 'image') result.push({ type: 'image', ref: block.attachment })
  }
  return result
}

/** 中立内容 → 纯文本（v1 rawOutput 等）。 */
export function neutralToText(content: readonly NeutralContent[]): string {
  const parts: string[] = []
  for (const item of content) if (item.type === 'text') parts.push(item.text)
  return parts.join('\n')
}

/** 最大工具结果输出字符数（wire 边界）。 */
const MAX_TOOL_OUTPUT_CHARS = 64 * 1024

/** 把工具输出截断到 wire 边界。 */
export function clipText(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text
  return text.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n[output truncated]'
}

/** 安全解析工具调用参数 JSON；失败时返回原始字符串。 */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** 一个文件 diff 的最小结构（dsh-tool-fs 的 meta.diffs 条目）。 */
interface ResultFileDiff {
  path: string
  oldText: string | null
  newText: string
}

/**
 * 从 tool/result 事件的 meta 字段窄化出文件修改 diff 列表。
 * dsh-tool-fs 的 write/edit 工具把 { diffs: FileDiff[] } 写进 meta，
 * 每条 FileDiff = { path, oldText: string | null, newText: string }。
 * @param meta - tool/result 事件的 meta 字段（不透明 JSON）。
 * @returns 验证通过的 diff 列表；缺失或格式不符时返回空数组。
 */
function diffsFromResultMeta(meta: unknown): ResultFileDiff[] {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return []
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return []
  const result: ResultFileDiff[] = []
  for (const item of diffs) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const { path, oldText, newText } = item as Record<string, unknown>
    if (typeof path !== 'string') return []
    if (oldText !== null && typeof oldText !== 'string') return []
    if (typeof newText !== 'string') return []
    result.push({ path, oldText: oldText as string | null, newText })
  }
  return result
}

/**
 * 一个 durable 会话事件 → 中立更新序列。
 * 不产生更新的边界事件（turn/step 等）返回空数组。
 * @param event - 已提交的会话事件。
 * @returns 该事件产生的全部中立更新。
 */
export function mapSessionEvent(event: SessionEvent): NeutralUpdate[] {
  const { type, data } = event
  const rawType = type as string
  // 插件扩展事件（plan/mode、session/title）不在核心 SessionEventMap 联合内，先按字面结构收窄。
  if (rawType === 'plan/mode') {
    const active = (data as { active?: unknown }).active
    return [{ kind: 'current_mode_update', modeId: active === true ? 'plan' : 'default' }]
  }
  if (rawType === 'session/title') {
    const title = (data as { title?: unknown }).title
    return typeof title === 'string' ? [{ kind: 'session_info_update', title }] : []
  }
  switch (type) {
    case 'user/message': {
      const message = data as SessionEventMap['user/message']
      const content = contentToNeutral(message.content)
      if (content.length === 0) return []
      return content.map(item => ({ kind: 'user_message_chunk' as const, messageId: message.id, content: item }))
    }
    case 'assistant/chunk': {
      const { turn, step, chunk } = data as SessionEventMap['assistant/chunk']
      const messageId = assistantMessageId(turn, step)
      if (chunk.type === 'text-delta') {
        return [{ kind: 'agent_message_chunk', messageId, content: { type: 'text', text: chunk.text } }]
      }
      if (chunk.type === 'reasoning-delta') {
        return [{ kind: 'agent_thought_chunk', messageId, content: { type: 'text', text: chunk.text } }]
      }
      if (chunk.type === 'block-end' && chunk.block.type === 'image') {
        return [{ kind: 'agent_message_chunk', messageId, content: { type: 'image', ref: chunk.block.attachment } }]
      }
      return [] // block-start / tool-call-delta / usage / finish 与未知 chunk
    }
    case 'tool/call': {
      const { callId, name, arguments: raw } = data as SessionEventMap['tool/call']
      return [{
        kind: 'tool_call' as const,
        toolCallId: callId,
        title: name,
        toolKind: toolKindFor(name),
        status: 'in_progress',
        name,
        rawInput: parseArguments(raw),
      }]
    }
    case 'tool/result': {
      const { message, error } = data as SessionEventMap['tool/result']
      const block = message.content[0]
      const failed = error !== undefined || block?.isError === true
      const textContent = block ? contentToNeutral(block.content) : undefined
      // 从 tool/result 事件的 meta 字段提取文件修改 diff（dsh-tool-fs 写入的 { diffs: FileDiff[] }）。
      const diffs = diffsFromResultMeta((data as { meta?: unknown }).meta)
      return [{
        kind: 'tool_call_update' as const,
        toolCallId: block?.toolCallId ?? '',
        status: failed ? 'failed' : 'completed',
        ...(failed ? { toolKind: 'other' as ToolKind } : {}),
        content: textContent !== undefined || diffs.length > 0
          ? [...(textContent ?? []), ...diffs.map(d => ({ type: 'diff' as const, ...d }))]
          : undefined,
      }]
    }
    case 'todo/write': {
      const { todos } = data as SessionEventMap['todo/write']
      if (todos.length === 0) return [{ kind: 'plan_removed' }]
      return [{
        kind: 'plan' as const,
        entries: todos.map(todo => ({ content: todo.content, priority: 'medium' as const, status: todo.status })),
      }]
    }
    case 'request/header': {
      const { header } = data as SessionEventMap['request/header']
      const tools = header.tools
      if (!tools || tools.length === 0) return []
      return [{
        kind: 'available_commands_update' as const,
        commands: tools.map(tool => ({ name: tool.name, description: tool.description })),
      }]
    }
    default: return []
  }
}
