/** Session config options：model/effort/sandbox 暴露为 ACP config option。@module dsh-acp-full/server/config-options */
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';
/** model config option 的固定 id。 */
export declare const MODEL_CONFIG_ID = "model";
/** effort（思考等级）config option 的固定 id。 */
export declare const EFFORT_CONFIG_ID = "effort";
/** mode（agent preset）config option 的固定 id。 */
export declare const MODE_CONFIG_ID = "mode";
/** sandbox（文件沙箱模式）config option 的固定 id。 */
export declare const SANDBOX_CONFIG_ID = "sandbox";
/** dsh 支持的会话 mode（agent preset id；通过 recompose 动态切换）。 */
export type SessionMode = string;
/** 一个 agent preset 条目（mode config option 用）。 */
export interface PresetEntry {
    id: string;
    name: string;
    description?: string;
}
/** 一个 provider 下的模型条目（config option 构造用）。 */
export interface ProviderModels {
    providerId: string;
    providerName: string;
    models: {
        id: string;
        name: string;
        description?: string;
    }[];
}
/** 当前模型选择（provider + model）。 */
export interface ModelSelection {
    provider: string;
    model: string;
}
/** 一个会话的全部可变选择（mode=preset + model + effort + sandbox）。 */
export interface SessionSelection {
    mode: SessionMode;
    model: ModelSelection;
    effort?: string;
    /** 当前 sandbox 模式；undefined 表示 sandbox 不可用（无 sandbox-policy 服务）。 */
    sandbox?: SandboxMode;
}
/** model config option 的可选值。 */
export interface ModelOptionValue {
    value: string;
    name: string;
    description?: string;
}
/** effort config option 的可选值。 */
export interface EffortOptionValue {
    value: string;
    name: string;
    description?: string;
}
/** 中立 config option 描述（v1/v2 共用，各自映射字段名）。 */
export interface ConfigOptionDescriptor {
    id: string;
    name: string;
    description?: string;
    category: 'mode' | 'model' | 'thought_level' | 'sandbox';
    type: 'select';
    currentValue: string;
    options: {
        value: string;
        name: string;
        description?: string;
    }[];
}
/** 把模型选择格式化为 `provider/model` 复合 value。 */
export declare function formatModelValue(selection: ModelSelection): string;
/** 解析 `provider/model` 复合 value 回 ModelSelection。 */
export declare function parseModelValue(value: string): ModelSelection | null;
/**
 * 构造 model config option 的中立描述。
 * @param providers - provider 分组的模型列表。
 * @param current - 当前模型选择。
 */
export declare function modelConfigDescriptor(providers: readonly ProviderModels[], current: ModelSelection): ConfigOptionDescriptor;
/**
 * 构造 mode（agent preset）config option 的中立描述。
 * @param presets - 可用 preset 列表。
 * @param currentMode - 当前 preset id。
 */
export declare function modeConfigDescriptor(presets: readonly PresetEntry[], currentMode: string): ConfigOptionDescriptor;
/**
 * 构造 effort（思考等级）config option 的中立描述；无 effort 时返回 null。
 * @param efforts - 当前模型支持的思考等级。
 * @param currentEffort - 当前选中的 effort（可选）。
 */
export declare function effortConfigDescriptor(efforts: readonly EffortOptionValue[], currentEffort?: string): ConfigOptionDescriptor | null;
/**
 * 构造 sandbox（文件沙箱模式）config option 的中立描述；sandbox 不可用时返回 null。
 * @param modes - 可选的 sandbox 模式列表。
 * @param currentSandbox - 当前 sandbox 模式（undefined 表示无 sandbox 服务）。
 */
export declare function sandboxConfigDescriptor(modes: readonly SandboxMode[], currentSandbox?: SandboxMode): ConfigOptionDescriptor | null;
/**
 * 构造当前会话的 config option 描述列表（mode + model + effort + sandbox）。
 * mode 切换 dsh 的 agent preset（Standard / PTC / Minimal / …）。
 * @param selection - 当前会话选择。
 * @param presets - 可用 preset 列表。
 * @param providers - provider 分组的模型列表。
 * @param efforts - 当前模型支持的思考等级。
 * @param sandboxModes - 可选的 sandbox 模式列表（空表示 sandbox 不可用）。
 */
export declare function sessionConfigDescriptors(selection: SessionSelection, presets: readonly PresetEntry[], providers: readonly ProviderModels[], efforts: readonly EffortOptionValue[], sandboxModes?: readonly SandboxMode[]): ConfigOptionDescriptor[];
/**
 * 应用一个 set_config_option 请求到会话选择（model/effort/sandbox；mode 经命令切换）。
 * sandbox 的实际切换（追加 `sandbox/mode` 事件）由调用方在确认选择更新后执行。
 * @param current - 当前选择。
 * @param configId - 要设置的 config option id。
 * @param value - 新值。
 * @returns 新的选择，或 `null` 表示该 configId/value 不被识别。
 */
export declare function applyConfigOption(current: SessionSelection, configId: string, value: string | boolean): SessionSelection | null;
/** v1 SessionConfigOption 字段名（用 `id`）。 */
interface V1ConfigOption {
    id: string;
    name: string;
    description?: string;
    category?: string;
    type: 'select';
    currentValue: string;
    options: {
        value: string;
        name: string;
        description?: string;
    }[];
}
/** v2 SessionConfigOption 字段名（用 `configId`）。 */
interface V2ConfigOption {
    configId: string;
    name: string;
    description?: string;
    category?: string;
    type: 'select';
    currentValue: string;
    options: {
        value: string;
        name: string;
        description?: string;
    }[];
}
/** 把中立 descriptor 列表映射为 v1 SessionConfigOption（用 `id`）。 */
export declare function descriptorsToV1(descriptors: readonly ConfigOptionDescriptor[]): V1ConfigOption[];
/** 把中立 descriptor 列表映射为 v2 SessionConfigOption（用 `configId`）。 */
export declare function descriptorsToV2(descriptors: readonly ConfigOptionDescriptor[]): V2ConfigOption[];
export {};
//# sourceMappingURL=config-options.d.ts.map