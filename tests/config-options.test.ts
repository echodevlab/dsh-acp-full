/** config option 描述与 applyConfigOption 逻辑。@module dsh-acp-full/tests/config-options */

import { describe, expect, test } from 'bun:test'
import {
  SANDBOX_CONFIG_ID,
  applyConfigOption,
  sandboxConfigDescriptor,
  sessionConfigDescriptors,
  type SessionSelection,
} from '../src/server/config-options.ts'

const baseSelection: SessionSelection = {
  mode: 'standard',
  model: { provider: 'deepseek', model: 'deepseek-chat' },
}

describe('sandboxConfigDescriptor', () => {
  test('有 sandbox 模式时构造描述', () => {
    const descriptor = sandboxConfigDescriptor(['read-only', 'workspace-write', 'danger-full-access'], 'read-only')
    expect(descriptor).not.toBeNull()
    expect(descriptor!.id).toBe(SANDBOX_CONFIG_ID)
    expect(descriptor!.category).toBe('sandbox')
    expect(descriptor!.currentValue).toBe('read-only')
    expect(descriptor!.options.map(o => o.value)).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })

  test('无 sandbox 模式时返回 null', () => {
    expect(sandboxConfigDescriptor([], 'read-only')).toBeNull()
  })

  test('currentSandbox 缺省时取第一个模式', () => {
    const descriptor = sandboxConfigDescriptor(['read-only', 'workspace-write'])
    expect(descriptor!.currentValue).toBe('read-only')
  })
})

describe('applyConfigOption (sandbox)', () => {
  test('合法 sandbox 值更新选择', () => {
    const next = applyConfigOption({ ...baseSelection, sandbox: 'read-only' }, SANDBOX_CONFIG_ID, 'workspace-write')
    expect(next).not.toBeNull()
    expect(next!.sandbox).toBe('workspace-write')
  })

  test('非法 sandbox 值返回 null', () => {
    const next = applyConfigOption({ ...baseSelection, sandbox: 'read-only' }, SANDBOX_CONFIG_ID, 'invalid-mode')
    expect(next).toBeNull()
  })

  test('sandbox 切换不影响其他选择', () => {
    const next = applyConfigOption({ ...baseSelection, sandbox: 'read-only', effort: 'high' }, SANDBOX_CONFIG_ID, 'danger-full-access')
    expect(next!.mode).toBe('standard')
    expect(next!.effort).toBe('high')
    expect(next!.sandbox).toBe('danger-full-access')
  })
})

describe('sessionConfigDescriptors (sandbox)', () => {
  test('包含 sandbox config option', () => {
    const descriptors = sessionConfigDescriptors(
      { ...baseSelection, sandbox: 'workspace-write' },
      [{ id: 'standard', name: 'Standard' }],
      [{ providerId: 'deepseek', providerName: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] }],
      [],
      ['read-only', 'workspace-write', 'danger-full-access'],
    )
    const sandbox = descriptors.find(d => d.id === SANDBOX_CONFIG_ID)
    expect(sandbox).toBeDefined()
    expect(sandbox!.currentValue).toBe('workspace-write')
  })

  test('sandboxModes 空时不含 sandbox config option', () => {
    const descriptors = sessionConfigDescriptors(
      baseSelection,
      [{ id: 'standard', name: 'Standard' }],
      [{ providerId: 'deepseek', providerName: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] }],
      [],
      [],
    )
    const sandbox = descriptors.find(d => d.id === SANDBOX_CONFIG_ID)
    expect(sandbox).toBeUndefined()
  })
})
