/** 内容转换与不支持内容拒绝。@module dsh-acp-full/tests/content */

import { describe, expect, test } from 'bun:test'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { acpBlockToDsh, acpPromptToUserMessage, decodeBase64, encodeBase64, UnsupportedContentError } from '../src/server/content.ts'

/** 记录保存调用的最小附件服务。 */
function makeAttachments(): AttachmentStore {
  return {
    saveImage: async input => ({
      attachmentId: 'att-1',
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 1,
      height: 1,
      ...(input.name ? { name: input.name } : {}),
    }),
    readImage: async ref => ({ ref, data: new Uint8Array([1, 2, 3]) }),
  } as unknown as AttachmentStore
}

describe('acpBlockToDsh', () => {
  test('text 直转', async () => {
    expect(await acpBlockToDsh({ type: 'text', text: 'hi' }, undefined)).toEqual({ type: 'text', text: 'hi' })
  })

  test('resource_link 渲染为文本引用', async () => {
    const block = await acpBlockToDsh({
      type: 'resource_link',
      name: 'docs',
      uri: 'file:///a.md',
      description: 'the docs',
    }, undefined)
    expect(block).toEqual({ type: 'text', text: '[docs] file:///a.md the docs' })
  })

  test('embedded resource text → 文本', async () => {
    const block = await acpBlockToDsh({
      type: 'resource',
      resource: { uri: 'file:///a.md', text: 'content here' },
    }, undefined)
    expect(block).toEqual({ type: 'text', text: '[file:///a.md] content here' })
  })

  test('image → dsh image block（经附件服务）', async () => {
    const attachments = makeAttachments()
    const block = await acpBlockToDsh({
      type: 'image',
      data: encodeBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      mimeType: 'image/png',
    }, attachments)
    expect(block.type).toBe('image')
    if (block.type === 'image') {
      expect(block.attachment.attachmentId).toBe('att-1')
      expect(block.attachment.mediaType).toBe('image/png')
    }
  })

  test('image 缺附件服务 → 明确错误', async () => {
    await expect(acpBlockToDsh({ type: 'image', data: 'AAAA', mimeType: 'image/png' }, undefined))
      .rejects.toBeInstanceOf(UnsupportedContentError)
  })

  test('image 不支持媒体类型 → 明确错误', async () => {
    await expect(acpBlockToDsh({ type: 'image', data: 'AAAA', mimeType: 'image/svg+xml' }, makeAttachments()))
      .rejects.toBeInstanceOf(UnsupportedContentError)
  })

  test('audio → 明确错误', async () => {
    await expect(acpBlockToDsh({ type: 'audio', data: 'AAAA', mimeType: 'audio/mpeg' }, undefined))
      .rejects.toBeInstanceOf(UnsupportedContentError)
  })

  test('未知块 → 明确错误', async () => {
    await expect(acpBlockToDsh({ type: 'evidence' }, undefined)).rejects.toBeInstanceOf(UnsupportedContentError)
  })
})

describe('acpPromptToUserMessage', () => {
  test('多块拼接为完整用户消息', async () => {
    const message = await acpPromptToUserMessage([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ], undefined)
    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])
    expect(message.id.length).toBeGreaterThan(0)
  })

  test('任一不支持块整体拒绝', async () => {
    await expect(acpPromptToUserMessage([
      { type: 'text', text: 'ok' },
      { type: 'audio', data: 'AAAA', mimeType: 'audio/mpeg' },
    ], undefined)).rejects.toBeInstanceOf(UnsupportedContentError)
  })
})

describe('base64', () => {
  test('roundtrip', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255])
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes)
  })
})
