/** dsh durable session 事件 → 版本中立更新。@module dsh-acp-full/server/mapping */
import type { StopReason, ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock as DshContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
/** 中立内容：text 立即可用；image 由传输层经附件服务异步解析字节；diff 携带文件修改。 */
export type NeutralContent = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    ref: ImageAttachmentRef;
} | {
    type: 'diff';
    path: string;
    oldText: string | null;
    newText: string;
};
export interface NeutralPlanEntry {
    content: string;
    priority: 'low' | 'medium' | 'high';
    status: 'pending' | 'in_progress' | 'completed';
}
export interface NeutralCommand {
    name: string;
    description: string;
}
/** 版本中立的会话更新；v1/v2 传输层各自转换。 */
export type NeutralUpdate = {
    kind: 'user_message_chunk';
    messageId: string;
    content: NeutralContent;
} | {
    kind: 'agent_message_chunk';
    messageId: string;
    content: NeutralContent;
} | {
    kind: 'agent_thought_chunk';
    messageId: string;
    content: NeutralContent;
} | {
    kind: 'tool_call';
    toolCallId: string;
    title: string;
    toolKind: ToolKind;
    status: ToolCallStatus;
    name: string;
    rawInput: unknown;
} | {
    kind: 'tool_call_update';
    toolCallId: string;
    status: ToolCallStatus;
    toolKind?: ToolKind;
    content?: NeutralContent[];
} | {
    kind: 'plan';
    entries: NeutralPlanEntry[];
} | {
    kind: 'plan_removed';
} | {
    kind: 'current_mode_update';
    modeId: string;
} | {
    kind: 'session_info_update';
    title: string;
} | {
    kind: 'available_commands_update';
    commands: NeutralCommand[];
} | {
    kind: 'state_update';
    state: 'idle' | 'running';
    stopReason?: StopReason;
};
/** assistant 消息的合成 id：把流式 chunk 关联到其 turn/step。 */
export declare function assistantMessageId(turn: number, step: number): string;
/** dsh 工具名 → ACP 工具类别（按名字启发式；无匹配时 `other`）。 */
export declare function toolKindFor(name: string): ToolKind;
/** dsh turn 结束原因 → ACP stop reason（与 dsh 核心 codec 约定一致）。 */
export declare function stopReasonFor(reason: TurnEndReason): StopReason;
/** dsh 内容块 → 中立内容（reasoning/tool 块与未知块跳过）。 */
export declare function contentToNeutral(blocks: readonly DshContentBlock[]): NeutralContent[];
/** 中立内容 → 纯文本（v1 rawOutput 等）。 */
export declare function neutralToText(content: readonly NeutralContent[]): string;
/** 把工具输出截断到 wire 边界。 */
export declare function clipText(text: string): string;
/**
 * 一个 durable 会话事件 → 中立更新序列。
 * 不产生更新的边界事件（turn/step 等）返回空数组。
 * @param event - 已提交的会话事件。
 * @returns 该事件产生的全部中立更新。
 */
export declare function mapSessionEvent(event: SessionEvent): NeutralUpdate[];
//# sourceMappingURL=mapping.d.ts.map