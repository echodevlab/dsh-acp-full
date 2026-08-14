/** 命令行参数解析：把 dsh launcher 透传的 app args 转成 config 覆盖。@module dsh-acp-full/server/cli */
import type { Context } from '@deepseek-ai/cordis';
import type { AcpFullConfig, ClientAdapter, ProtocolVersion } from '../types.ts';
/** 命令行可覆盖的 config 字段。 */
export interface CliOverrides {
    protocol?: ProtocolVersion;
    client?: ClientAdapter;
    provider?: string;
    model?: string;
    maxTokens?: number;
}
/**
 * 从 `ctx.cmdlineArgs` 读取 launcher 透传的参数并解析 dsh-acp-full 自己的 flag。
 *
 * dsh 把 `--profile acp` 之后的参数原样经 `cmdlineArgs` 服务提供；ACP 服务器没有
 * commander action，这里做轻量手解析：只认 `--flag value` 与 `--flag=value`，
 * 未知 flag 静默忽略（不阻断启动）。
 * @param ctx - 携带可选 `cmdlineArgs` 的上下文。
 * @returns 解析出的覆盖项；无对应 flag 时字段缺省。
 */
export declare function parseCliOverrides(ctx: Context): CliOverrides;
/**
 * 把命令行覆盖合并到 cordis.yml 配置之上；CLI 优先。
 * @param config - cordis.yml 插件配置。
 * @param overrides - 命令行解析结果。
 * @returns 合并后的有效配置。
 */
export declare function mergeConfig(config: AcpFullConfig, overrides: CliOverrides): AcpFullConfig;
//# sourceMappingURL=cli.d.ts.map