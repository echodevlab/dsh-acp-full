/** dsh-acp-full 插件配置类型（仅类型，无运行时代码）。@module dsh-acp-full */
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';
/** 强制的 ACP 协议版本；`auto` 按客户端 initialize 请求协商。 */
export type ProtocolVersion = 'v1' | 'v2' | 'auto';
/** 已知的客户端适配；`devin` 用 session config options 代替 session modes。 */
export type ClientAdapter = 'devin';
export interface AcpFullConfig {
    /** 强制使用的 LLM provider 路由 id（可选；缺省时由 dsh 会话组合自行解析）。 */
    provider?: string;
    /** 强制使用的模型 id（可选）。 */
    model?: string;
    /** 每个会话模型请求的最大输出 token（可选）。 */
    maxTokens?: number;
    /** 强制的 ACP 协议版本（可选；缺省 `auto` 按客户端请求协商）。 */
    protocol?: ProtocolVersion;
    /** 客户端适配（可选；`devin` 用 session config options 暴露 mode，绕过 Devin Desktop 不支持的 session modes）。 */
    client?: ClientAdapter;
    /** 新会话的初始 sandbox 模式覆写（可选；缺省时由 dsh sandbox-policy 部署默认决定）。 */
    sandbox?: SandboxMode;
}
//# sourceMappingURL=types.d.ts.map