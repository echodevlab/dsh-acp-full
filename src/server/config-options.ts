/** Session config options：model/effort/sandbox 暴露为 ACP config option。@module dsh-acp-full/server/config-options */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SANDBOX_MODES } from '@deepseek-ai/dsh-sandbox-policy'

/** model config option 的固定 id。 */
export const MODEL_CONFIG_ID = 'model'
/** effort（思考等级）config option 的固定 id。 */
export const EFFORT_CONFIG_ID = 'effort'
/** mode（agent preset）config option 的固定 id。 */
export const MODE_CONFIG_ID = 'mode'
/** sandbox（文件沙箱模式）config option 的固定 id。 */
export const SANDBOX_CONFIG_ID = 'sandbox'

/** 全部合法 sandbox 模式的集合（applyConfigOption 校验用）。 */
const SANDBOX_MODES_SET: ReadonlySet<SandboxMode> = new Set(SANDBOX_MODES)

/** dsh 支持的会话 mode（agent preset id；通过 recompose 动态切换）。 */
export type SessionMode = string

/** 一个 agent preset 条目（mode config option 用）。 */
export interface PresetEntry {
  id: string
  name: string
  description?: string
}

/** 一个 provider 下的模型条目（config option 构造用）。 */
export interface ProviderModels {
  providerId: string
  providerName: string
  models: { id: string; name: string; description?: string }[]
}

/** 当前模型选择（provider + model）。 */
export interface ModelSelection {
  provider: string
  model: string
}

/** 一个会话的全部可变选择（mode=preset + model + effort + sandbox）。 */
export interface SessionSelection {
  mode: SessionMode
  model: ModelSelection
  effort?: string
  /** 当前 sandbox 模式；undefined 表示 sandbox 不可用（无 sandbox-policy 服务）。 */
  sandbox?: SandboxMode
}

/** model config option 的可选值。 */
export interface ModelOptionValue {
  value: string
  name: string
  description?: string
}

/** effort config option 的可选值。 */
export interface EffortOptionValue {
  value: string
  name: string
  description?: string
}

/** 中立 config option 描述（v1/v2 共用，各自映射字段名）。 */
export interface ConfigOptionDescriptor {
  id: string
  name: string
  description?: string
  category: 'mode' | 'model' | 'thought_level' | 'sandbox'
  type: 'select'
  currentValue: string
  options: { value: string; name: string; description?: string }[]
}

/** 把模型选择格式化为 `provider/model` 复合 value。 */
export function formatModelValue(selection: ModelSelection): string {
  return `${selection.provider}/${selection.model}`
}

/** 解析 `provider/model` 复合 value 回 ModelSelection。 */
export function parseModelValue(value: string): ModelSelection | null {
  const sep = value.indexOf('/')
  if (sep <= 0) return null
  return { provider: value.slice(0, sep), model: value.slice(sep + 1) }
}

/** 构造 model config option 的可选值列表（`provider/model` 复合格式）。 */
function modelOptionValues(providers: readonly ProviderModels[]): ModelOptionValue[] {
  return providers.flatMap(provider =>
    provider.models.map(model => ({
      value: `${provider.providerId}/${model.id}`,
      name: `${provider.providerName}/${model.name}`,
      ...(model.description !== undefined ? { description: model.description } : {}),
    })),
  )
}

/**
 * 构造 model config option 的中立描述。
 * @param providers - provider 分组的模型列表。
 * @param current - 当前模型选择。
 */
export function modelConfigDescriptor(providers: readonly ProviderModels[], current: ModelSelection): ConfigOptionDescriptor {
  return {
    id: MODEL_CONFIG_ID,
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: formatModelValue(current),
    options: modelOptionValues(providers),
  }
}

/**
 * 构造 mode（agent preset）config option 的中立描述。
 * @param presets - 可用 preset 列表。
 * @param currentMode - 当前 preset id。
 */
export function modeConfigDescriptor(presets: readonly PresetEntry[], currentMode: string): ConfigOptionDescriptor {
  return {
    id: MODE_CONFIG_ID,
    name: 'Mode',
    description: 'Agent preset (Standard / PTC / Minimal / …)',
    category: 'mode',
    type: 'select',
    currentValue: currentMode,
    options: presets.map(p => ({ value: p.id, name: p.name, ...(p.description !== undefined ? { description: p.description } : {}) })),
  }
}

/**
 * 构造 effort（思考等级）config option 的中立描述；无 effort 时返回 null。
 * @param efforts - 当前模型支持的思考等级。
 * @param currentEffort - 当前选中的 effort（可选）。
 */
export function effortConfigDescriptor(efforts: readonly EffortOptionValue[], currentEffort?: string): ConfigOptionDescriptor | null {
  if (efforts.length === 0) return null
  const current = currentEffort !== undefined && efforts.some(e => e.value === currentEffort)
    ? currentEffort
    : efforts[0]!.value
  return {
    id: EFFORT_CONFIG_ID,
    name: 'Effort',
    description: 'Available effort levels for this model',
    category: 'thought_level',
    type: 'select',
    currentValue: current,
    options: efforts.map(e => ({ value: e.value, name: e.name, ...(e.description !== undefined ? { description: e.description } : {}) })),
  }
}

/** sandbox 模式的可读名称。 */
const SANDBOX_MODE_NAMES: Record<SandboxMode, string> = {
  'read-only': 'Read only',
  'workspace-write': 'Workspace write',
  'danger-full-access': 'Full access',
}

/**
 * 构造 sandbox（文件沙箱模式）config option 的中立描述；sandbox 不可用时返回 null。
 * @param modes - 可选的 sandbox 模式列表。
 * @param currentSandbox - 当前 sandbox 模式（undefined 表示无 sandbox 服务）。
 */
export function sandboxConfigDescriptor(modes: readonly SandboxMode[], currentSandbox?: SandboxMode): ConfigOptionDescriptor | null {
  if (modes.length === 0) return null
  const current = currentSandbox ?? modes[0]!
  return {
    id: SANDBOX_CONFIG_ID,
    name: 'Sandbox',
    description: 'File-effect sandbox mode for shell and filesystem operations',
    category: 'sandbox',
    type: 'select',
    currentValue: current,
    options: modes.map(m => ({ value: m, name: SANDBOX_MODE_NAMES[m] ?? m })),
  }
}

/**
 * 构造当前会话的 config option 描述列表（mode + model + effort + sandbox）。
 * mode 切换 dsh 的 agent preset（Standard / PTC / Minimal / …）。
 * @param selection - 当前会话选择。
 * @param presets - 可用 preset 列表。
 * @param providers - provider 分组的模型列表。
 * @param efforts - 当前模型支持的思考等级。
 * @param sandboxModes - 可选的 sandbox 模式列表（空表示 sandbox 不可用）。
 */
export function sessionConfigDescriptors(
  selection: SessionSelection,
  presets: readonly PresetEntry[],
  providers: readonly ProviderModels[],
  efforts: readonly EffortOptionValue[],
  sandboxModes: readonly SandboxMode[] = [],
): ConfigOptionDescriptor[] {
  const effort = effortConfigDescriptor(efforts, selection.effort)
  const sandbox = sandboxConfigDescriptor(sandboxModes, selection.sandbox)
  return [
    modeConfigDescriptor(presets, selection.mode),
    modelConfigDescriptor(providers, selection.model),
    ...(effort ? [effort] : []),
    ...(sandbox ? [sandbox] : []),
  ]
}

/**
 * 应用一个 set_config_option 请求到会话选择（model/effort/sandbox；mode 经命令切换）。
 * sandbox 的实际切换（追加 `sandbox/mode` 事件）由调用方在确认选择更新后执行。
 * @param current - 当前选择。
 * @param configId - 要设置的 config option id。
 * @param value - 新值。
 * @returns 新的选择，或 `null` 表示该 configId/value 不被识别。
 */
export function applyConfigOption(
  current: SessionSelection,
  configId: string,
  value: string | boolean,
): SessionSelection | null {
  if (typeof value !== 'string') return null
  switch (configId) {
    case MODE_CONFIG_ID:
      return { ...current, mode: value }
    case MODEL_CONFIG_ID: {
      const parsed = parseModelValue(value)
      if (parsed === null) return null
      // 切换模型时清除 effort（新模型可能不支持旧 effort）
      return { ...current, model: parsed, effort: undefined }
    }
    case EFFORT_CONFIG_ID:
      return { ...current, effort: value }
    case SANDBOX_CONFIG_ID: {
      if (!SANDBOX_MODES_SET.has(value as SandboxMode)) return null
      return { ...current, sandbox: value as SandboxMode }
    }
    default:
      return null
  }
}

/** v1 SessionConfigOption 字段名（用 `id`）。 */
interface V1ConfigOption {
  id: string
  name: string
  description?: string
  category?: string
  type: 'select'
  currentValue: string
  options: { value: string; name: string; description?: string }[]
}

/** v2 SessionConfigOption 字段名（用 `configId`）。 */
interface V2ConfigOption {
  configId: string
  name: string
  description?: string
  category?: string
  type: 'select'
  currentValue: string
  options: { value: string; name: string; description?: string }[]
}

/** 把中立 descriptor 列表映射为 v1 SessionConfigOption（用 `id`）。 */
export function descriptorsToV1(descriptors: readonly ConfigOptionDescriptor[]): V1ConfigOption[] {
  return descriptors.map(d => ({
    id: d.id,
    name: d.name,
    ...(d.description !== undefined ? { description: d.description } : {}),
    category: d.category,
    type: 'select',
    currentValue: d.currentValue,
    options: d.options.map(o => ({ value: o.value, name: o.name, ...(o.description !== undefined ? { description: o.description } : {}) })),
  }))
}

/** 把中立 descriptor 列表映射为 v2 SessionConfigOption（用 `configId`）。 */
export function descriptorsToV2(descriptors: readonly ConfigOptionDescriptor[]): V2ConfigOption[] {
  return descriptors.map(d => ({
    configId: d.id,
    name: d.name,
    ...(d.description !== undefined ? { description: d.description } : {}),
    category: d.category,
    type: 'select',
    currentValue: d.currentValue,
    options: d.options.map(o => ({ value: o.value, name: o.name, ...(o.description !== undefined ? { description: o.description } : {}) })),
  }))
}
