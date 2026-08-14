/** dsh-acp-full：DeepSeek Harness 的完整 ACP v1 + v2 draft 服务器插件。@module dsh-acp-full */
export { name, inject, apply } from './plugin.ts';
export type { Config } from './plugin.ts';
export type { AcpFullConfig, ProtocolVersion, ClientAdapter } from './types.ts';
export { parseCliOverrides, mergeConfig } from './server/cli.ts';
export type { CliOverrides } from './server/cli.ts';
export { MODE_CONFIG_ID, MODEL_CONFIG_ID, EFFORT_CONFIG_ID, modeConfigDescriptor, modelConfigDescriptor, effortConfigDescriptor, sessionConfigDescriptors, applyConfigOption, descriptorsToV1, descriptorsToV2, formatModelValue, parseModelValue } from './server/config-options.ts';
export type { SessionMode, ModelSelection, SessionSelection, ProviderModels, PresetEntry, EffortOptionValue, ModelOptionValue, ConfigOptionDescriptor } from './server/config-options.ts';
export { UnsupportedContentError } from './server/content.ts';
export { mapSessionEvent, stopReasonFor, assistantMessageId, toolKindFor } from './server/mapping.ts';
export type { NeutralContent, NeutralUpdate, NeutralPlanEntry, NeutralCommand } from './server/mapping.ts';
export { ConnectionCore } from './server/core.ts';
export type { AcpClientCall, EmitFn, SessionRecord, Inflight, PromptOutcome } from './server/core.ts';
export { DshBridge } from './server/bridge.ts';
export type { NewSessionSpec, ListedSession } from './server/bridge.ts';
//# sourceMappingURL=index.d.ts.map