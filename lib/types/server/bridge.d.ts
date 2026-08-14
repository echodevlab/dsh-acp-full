/** dsh 会话/agent 生命周期桥。@module dsh-acp-full/server/bridge */
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session';
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';
import type { AcpFullConfig } from '../types.ts';
import type { ModelSelection } from './config-options.ts';
export interface NewSessionSpec {
    cwd: string;
    /** 已解析的模型选择；注入 agent 创建的 agentOptions，使子代理可继承。 */
    model?: ModelSelection;
    seed?: readonly SessionEvent[];
    parentSession?: SessionIdType;
}
/** 一个 provider 下的模型条目（config option 用）。 */
export interface ProviderModels {
    providerId: string;
    providerName: string;
    models: {
        id: string;
        name: string;
        description?: string;
    }[];
}
/** 会话列表条目（标题需读事件日志，由调用方按需解析）。 */
export interface ListedSession {
    header: SessionHeader;
    live: boolean;
    persisted: boolean;
}
/**
 * 把 ACP 会话操作映射到 dsh 的 AgentRegistry / SessionStore / session-query。
 * 会话删除在 dsh 不受支持（日志仅追加），由协议层拒绝。
 */
export declare class DshBridge {
    private readonly ctx;
    private readonly config;
    constructor(ctx: Context, config: AcpFullConfig);
    /** 把插件配置与已解析的会话模型转成 dsh AgentOptions。 */
    private agentOptions;
    /**
     * 创建全新 live agent 会话（可选 fork seed 与父会话谱系）。
     * @param spec - cwd、seed 事件与可选 parentSession。
     * @returns 拥有会话的 agent 句柄。
     */
    createSession(spec: NewSessionSpec): Promise<AgentHandle>;
    /**
     * 从持久化日志恢复 live agent。
     * @param sessionId - 已持久化会话 id。
     * @param model - 已解析的模型选择；注入 agentOptions 使子代理可继承。
     * @returns 恢复后的 agent 句柄。
     */
    resumeSession(sessionId: string, model?: ModelSelection): Promise<AgentHandle>;
    /**
     * 读一个会话的完整事件日志（live 优先，回退持久化查询）。
     * @param sessionId - 会话 id。
     * @returns 该会话的完整事件序列。
     */
    readSessionEvents(sessionId: string): Promise<readonly SessionEvent[]>;
    /**
     * 列出会话（live + 持久化）。
     * @returns 头部与存在性标记。
     */
    listSessions(): Promise<ListedSession[]>;
    /**
     * 从事件日志读会话标题（最后一个 `session/title`）。
     * @param events - 会话事件日志。
     * @returns 标题或 undefined。
     */
    titleFrom(events: readonly SessionEvent[]): string | undefined;
    /**
     * 从事件日志重建最后一次模型请求的持久化选择（provider/model/effort）。
     * dsh 把每次模型请求的 `LlmCallConfig` 写进 `request/header` 事件；
     * `foldRequestHeader` 取最新快照，由此恢复 resume/load 时应继承的模型与思考等级。
     * @param events - 会话事件日志。
     * @returns 持久化的模型选择，或 undefined（日志无 request/header）。
     */
    resolvePersistedModel(events: readonly SessionEvent[]): {
        model: ModelSelection;
        effort?: string;
    } | undefined;
    /**
     * fork 用的平衡前缀：最后一个 `turn/end`（含）之前的事件。
     * @param events - 父会话事件日志。
     * @returns 可作为子会话 seed 的事件切片。
     */
    forkSeed(events: readonly SessionEvent[]): readonly SessionEvent[];
    /**
     * 列出 dsh LLM provider 路由。
     * @returns ACP provider 条目；dsh 不暴露 wire 协议，故 supported 为空、provider 均为必需。
     */
    listProviders(): {
        providerId: string;
        name: string;
        supported: string[];
        required: boolean;
    }[];
    /**
     * 列出所有 provider 的所有模型，供 model config option 使用。
     * 遍历 `listProviders()` 后对每个 provider 调 `listModels()`；任一失败则该 provider 贡献空列表。
     * @returns provider 分组的模型列表。
     */
    listAllModels(): Promise<ProviderModels[]>;
    /**
     * 解析一个 provider/model 的可选思考等级（reasoning efforts）。
     * @returns effort id 与名称列表；无 reasoning 能力时返回空。
     */
    resolveModelReasoning(provider: string, model: string): Promise<{
        id: string;
        name: string;
        description?: string;
    }[]>;
    /** 一个 agent preset 条目（config option 用）。 */
    listPresets(): Promise<{
        id: string;
        name: string;
        description?: string;
    }[]>;
    /**
     * 动态切换一个 agent 的 preset（mode）。
     * @param agentCtx - agent 作用域上下文。
     * @param presetId - 目标 preset id。
     */
    recomposePreset(agentCtx: Context, presetId: string): Promise<void>;
    /** 全部可选的 sandbox 模式（config option 用）。 */
    sandboxModes(): readonly SandboxMode[];
    /**
     * 读取一个会话当前生效的 sandbox 模式：会话覆写优先，否则部署默认。
     * 无 sandbox-policy 服务时返回 undefined（sandbox 不可用）。
     * @param session - 目标会话。
     * @returns 当前生效的 sandbox 模式，或 undefined。
     */
    resolveSandboxMode(session: Session): SandboxMode | undefined;
    /**
     * 读取部署默认 sandbox 模式（无会话时用）。
     * 无 sandbox-policy 服务时返回 undefined。
     */
    defaultSandboxMode(): SandboxMode | undefined;
    /**
     * 切换一个会话的 sandbox 模式：追加 `sandbox/mode` 事件到会话日志。
     * 无 sandbox-policy 服务时抛错（sandbox 不可用）。
     * @param session - 目标会话。
     * @param mode - 目标 sandbox 模式。
     */
    setSandboxMode(session: Session, mode: SandboxMode): void;
}
//# sourceMappingURL=bridge.d.ts.map