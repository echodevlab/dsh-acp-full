/** ACP 内容块与 dsh 内容块的双向转换。@module dsh-acp-full/server/content */

import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock as DshContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { NeutralContent } from './mapping.ts'

/**
 * v1/v2 共有的内容块结构。两个包各自生成类型声明（Annotations 等装饰字段不同），
 * 但 wire 结构一致；转换只读取业务字段。
 */
export interface AcpContentInput {
  type: string
  text?: string | null
  data?: string | null
  mimeType?: string | null
  uri?: string | null
  name?: string | null
  title?: string | null
  description?: string | null
  resource?: {
    uri: string
    text?: string | null
    blob?: string | null
    mimeType?: string | null
  }
  [key: string]: unknown
}

/** 客户端内容块超出 dsh 能力时的协议错误。 */
export class UnsupportedContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedContentError'
  }
}

/** dsh 附件服务支持的图片媒体类型。 */
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** base64 文本 → 字节。 */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 字节 → base64 文本。 */
export function encodeBase64(data: Uint8Array): string {
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** resource_link → 单行文本引用（dsh 没有资源链接块）。 */
function renderResourceLink(block: AcpContentInput): string {
  const label = block.title ?? block.name
  const detail = block.description ? ` ${block.description}` : ''
  return label ? `[${label}] ${block.uri ?? ''}${detail}` : `${block.uri ?? ''}${detail}`
}

/**
 * ACP 内容块 → dsh 内容块。
 * text 直转；image 经附件服务持久化；resource_link 渲染为文本；
 * embedded resource 的 text 提取为文本、图片 blob 转 image；
 * audio 与未知块抛 {@link UnsupportedContentError}（拒绝静默丢弃）。
 * @param block - wire 层内容块（v1/v2 结构一致）。
 * @param attachments - dsh 附件服务；图片输入需要它。
 * @returns 对应的 dsh 内容块。
 */
export async function acpBlockToDsh(block: AcpContentInput, attachments: AttachmentStore | undefined): Promise<DshContentBlock> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text ?? '' }
    case 'image': {
      if (!attachments) throw new UnsupportedContentError('image content requires the dsh attachment service')
      const mediaType = block.mimeType ?? ''
      if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
        throw new UnsupportedContentError(`unsupported image media type ${mediaType}`)
      }
      const ref = await attachments.saveImage({
        data: decodeBase64(block.data ?? ''),
        mediaType: mediaType as ImageMediaType,
        ...(block.uri ? { name: block.uri } : {}),
      })
      return { type: 'image', attachment: ref }
    }
    case 'resource_link':
      return { type: 'text', text: renderResourceLink(block) }
    case 'resource': {
      const resource = block.resource
      if (!resource) throw new UnsupportedContentError('embedded resource block carries no resource payload')
      if (resource.text) {
        return { type: 'text', text: `[${resource.uri}] ${resource.text}` }
      }
      if (resource.blob) {
        const mediaType = resource.mimeType
        if (mediaType && SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
          if (!attachments) throw new UnsupportedContentError('image content requires the dsh attachment service')
          const ref = await attachments.saveImage({
            data: decodeBase64(resource.blob),
            mediaType: mediaType as ImageMediaType,
            name: resource.uri,
          })
          return { type: 'image', attachment: ref }
        }
        throw new UnsupportedContentError(`embedded binary resource ${resource.uri} (${mediaType ?? 'unknown type'}) is not supported`)
      }
      throw new UnsupportedContentError(`embedded resource ${resource.uri} carries neither text nor blob`)
    }
    case 'audio':
      throw new UnsupportedContentError('audio content is not supported by dsh')
    default:
      throw new UnsupportedContentError(`unsupported content block type ${block.type}`)
  }
}

/**
 * ACP prompt 内容块列表 → dsh UserMessage。
 * @param blocks - session/prompt 携带的内容块（v1/v2 结构一致）。
 * @param attachments - dsh 附件服务。
 * @returns 标识完整的用户消息。
 */
export async function acpPromptToUserMessage(
  blocks: readonly AcpContentInput[],
  attachments: AttachmentStore | undefined,
): Promise<UserMessage> {
  const content: DshContentBlock[] = []
  for (const block of blocks) content.push(await acpBlockToDsh(block, attachments))
  return createUserMessage({ content, source: { kind: 'user' } })
}

/** dsh 内容块列表 → 纯文本（工具结果输出等）。 */
export function dshBlocksToText(blocks: readonly DshContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) if (block.type === 'text') parts.push(block.text)
  return parts.join('\n')
}

/** dsh 图片引用 → ACP image 内容块（异步读附件字节）。 */
export async function dshImageRefToAcp(ref: ImageAttachmentRef, attachments: AttachmentStore): Promise<AcpContentBlock> {
  const stored = await attachments.readImage(ref)
  return { type: 'image', data: encodeBase64(stored.data), mimeType: stored.ref.mediaType }
}

/**
 * 中立内容 → wire 层 ACP 内容块。
 * text 直转；image 经附件服务；diff 转为 ACP Diff 内容块（path/oldText/newText）。
 * 返回 `unknown` 因为 diff 的返回类型是 ToolCallContent 而非 ContentBlock——
 * 调用方按上下文（prompt 内容 vs 工具内容）自行窄化。
 * @param content - 中立内容。
 * @param attachments - dsh 附件服务（image 解析需要）。
 * @returns 可直接上线的 ACP 内容块。
 */
export async function resolveNeutralContent(content: NeutralContent, attachments: AttachmentStore | undefined): Promise<unknown> {
  if (content.type === 'text') return { type: 'text', text: content.text }
  if (content.type === 'diff') {
    return {
      type: 'diff',
      path: content.path,
      oldText: content.oldText,
      newText: content.newText,
    }
  }
  if (!attachments) throw new Error('dsh attachment service is required to resolve image content')
  return dshImageRefToAcp(content.ref, attachments)
}
