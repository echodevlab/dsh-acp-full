/** ACP 内容块与 dsh 内容块的双向转换。@module dsh-acp-full/server/content */
import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk';
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock as DshContentBlock, UserMessage } from '@deepseek-ai/dsh-llm';
import type { NeutralContent } from './mapping.ts';
/**
 * v1/v2 共有的内容块结构。两个包各自生成类型声明（Annotations 等装饰字段不同），
 * 但 wire 结构一致；转换只读取业务字段。
 */
export interface AcpContentInput {
    type: string;
    text?: string | null;
    data?: string | null;
    mimeType?: string | null;
    uri?: string | null;
    name?: string | null;
    title?: string | null;
    description?: string | null;
    resource?: {
        uri: string;
        text?: string | null;
        blob?: string | null;
        mimeType?: string | null;
    };
    [key: string]: unknown;
}
/** 客户端内容块超出 dsh 能力时的协议错误。 */
export declare class UnsupportedContentError extends Error {
    constructor(message: string);
}
/** base64 文本 → 字节。 */
export declare function decodeBase64(data: string): Uint8Array;
/** 字节 → base64 文本。 */
export declare function encodeBase64(data: Uint8Array): string;
/**
 * ACP 内容块 → dsh 内容块。
 * text 直转；image 经附件服务持久化；resource_link 渲染为文本；
 * embedded resource 的 text 提取为文本、图片 blob 转 image；
 * audio 与未知块抛 {@link UnsupportedContentError}（拒绝静默丢弃）。
 * @param block - wire 层内容块（v1/v2 结构一致）。
 * @param attachments - dsh 附件服务；图片输入需要它。
 * @returns 对应的 dsh 内容块。
 */
export declare function acpBlockToDsh(block: AcpContentInput, attachments: AttachmentStore | undefined): Promise<DshContentBlock>;
/**
 * ACP prompt 内容块列表 → dsh UserMessage。
 * @param blocks - session/prompt 携带的内容块（v1/v2 结构一致）。
 * @param attachments - dsh 附件服务。
 * @returns 标识完整的用户消息。
 */
export declare function acpPromptToUserMessage(blocks: readonly AcpContentInput[], attachments: AttachmentStore | undefined): Promise<UserMessage>;
/** dsh 内容块列表 → 纯文本（工具结果输出等）。 */
export declare function dshBlocksToText(blocks: readonly DshContentBlock[]): string;
/** dsh 图片引用 → ACP image 内容块（异步读附件字节）。 */
export declare function dshImageRefToAcp(ref: ImageAttachmentRef, attachments: AttachmentStore): Promise<AcpContentBlock>;
/**
 * 中立内容 → wire 层 ACP 内容块。
 * text 直转；image 经附件服务；diff 转为 ACP Diff 内容块（path/oldText/newText）。
 * 返回 `unknown` 因为 diff 的返回类型是 ToolCallContent 而非 ContentBlock——
 * 调用方按上下文（prompt 内容 vs 工具内容）自行窄化。
 * @param content - 中立内容。
 * @param attachments - dsh 附件服务（image 解析需要）。
 * @returns 可直接上线的 ACP 内容块。
 */
export declare function resolveNeutralContent(content: NeutralContent, attachments: AttachmentStore | undefined): Promise<unknown>;
//# sourceMappingURL=content.d.ts.map