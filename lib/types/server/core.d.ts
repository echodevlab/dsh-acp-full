/** 连接核心：会话注册表、事件接线、权限桥、turn 结算与连接清理。@module dsh-acp-full/server/core */
import type { StopReason } from '@agentclientprotocol/sdk';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent, SessionId as SessionIdType } from '@deepseek-ai/dsh-session';
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import type { SessionSelection } from './config-options.ts';
import { type NeutralUpdate } from './mapping.ts';
/** 与版本无关的 client 调用面（v1/v2 AgentContext 均满足）。 */
export interface AcpClientCall {
    request(method: string, params?: unknown): Promise<unknown>;
    notify(method: string, params?: unknown): Promise<void>;
}
/** 把中立更新发到 client 的传输函数（版本相关，由 v1/v2 层注入）。 */
export type EmitFn = (sessionId: SessionIdType, updates: readonly NeutralUpdate[]) => Promise<void>;
export interface SessionRecord {
    sessionId: SessionIdType;
    agent: Agent;
    handle: AgentHandle;
    inflight: Inflight | null;
    selection: SessionSelection;
    /** agent/request waterfall disposer，closeSession 时释放。 */
    disposeRequestHook: (() => void) | null;
    usage: {
        input: number;
        output: number;
    };
    /**
     * 当前 drive 的用户消息 id；该消息的 `user/message` 事件回显被抑制
     * （客户端发 prompt 时已自行显示，回显会导致重复）。turn 结束后清除。
     */
    suppressUserMessageId: string | null;
}
export interface Inflight {
    resolve: (stopReason: StopReason) => void;
    reject: (error: unknown) => void;
}
export interface PromptOutcome {
    stopReason: StopReason;
    inputTokens: number;
    outputTokens: number;
}
/**
 * 单个 ACP 连接的核心状态与接线。
 * initialize 时经 {@link activate} 绑定 client 与传输；事件监听按会话归属过滤。
 */
export declare class ConnectionCore {
    private readonly ctx;
    private readonly logger;
    readonly sessions: Map<SessionIdType, SessionRecord>;
    private activeClient;
    private emitFn;
    private disposers;
    private closed;
    constructor(ctx: Context, logger: (message: string) => void);
    /**
     * 连接初始化时调用一次：绑定 client 与传输并开始事件接线。
     * @param client - 该连接的 client 调用面。
     * @param emit - 版本相关的中立更新传输。
     */
    activate(client: AcpClientCall, emit: EmitFn): void;
    /**
     * 注册一个 agent 句柄为受管会话，并在 agent 作用域注册 `agent/request`
     * waterfall 把当前 model/effort 选择注入每次模型请求。
     * @param handle - 创建/恢复得到的 agent 句柄。
     * @param selection - 初始会话选择（mode/model/effort）。
     * @returns 该会话的记录。
     */
    register(handle: AgentHandle, selection: SessionSelection): SessionRecord;
    /** 按 id 查会话记录。 */
    get(id: SessionIdType): SessionRecord | undefined;
    /**
     * 把 agent.options 同步为当前 selection 的模型，使子代理（经
     * resolveChildAgentOptions 读 parent.options）继承切换后的模型而非创建时的初始模型。
     * agent.options 引用不可变但属性可变（AgentOptions 无 readonly 属性），直接赋值即可。
     * @param record - 已更新 selection 的会话记录。
     */
    syncAgentModel(record: SessionRecord): void;
    /**
     * 重放一个会话的既有事件（resume 后回放历史给 client）。
     * @param record - 目标会话记录。
     * @param events - 已提交的完整事件日志。
     */
    replay(record: SessionRecord, events: readonly SessionEvent[]): Promise<void>;
    /**
     * 运行一个 prompt 直到 turn 结算。
     * @param record - 目标会话记录。
     * @param message - 已转换的用户消息。
     * @returns 停止原因与本 turn 的 token 增量。
     */
    drive(record: SessionRecord, message: UserMessage): Promise<PromptOutcome>;
    /** 取消当前 inflight prompt（用户取消）。 */
    cancel(record: SessionRecord): void;
    /**
     * 关闭一个会话：结算 inflight、dispose agent（会话日志仍持久化）。
     * @param id - 会话 id。
     */
    closeSession(id: SessionIdType): Promise<void>;
    /** 连接关闭清理：断开事件订阅并关掉所有会话。 */
    quiesce(): Promise<void>;
    /**
     * 权限瀑布：把 dsh approval 请求桥给 ACP 客户端。
     * 无活跃连接或请求不属于本连接时委托给下一级 answerer。
     * @param req - dsh 审批请求。
     * @param next - 瀑布后继。
     * @returns dsh 审批结果。
     */
    onApproval(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>;
    private recordFor;
    private onSessionEvent;
    private onAgentStatus;
    private onAgentError;
    private emit;
}
//# sourceMappingURL=core.d.ts.map