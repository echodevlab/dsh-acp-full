/** dsh-acp-full Cordis 插件入口：启动 stdio ACP v1 + v2 服务器。@module dsh-acp-full */
import type { Context } from '@deepseek-ai/cordis';
import type { AcpFullConfig } from './types.ts';
/** 插件名（cordis.yml 引用）。 */
export declare const name = "dsh-acp-full";
/** 必需的服务注入。 */
export declare const inject: string[];
/** cordis.yml 中的插件配置。 */
export interface Config extends AcpFullConfig {
}
/**
 * 应用插件：启动 stdio ACP 服务器。
 *
 * 命令行覆盖（`--protocol`/`--client`/`--provider`/`--model`/`--max-tokens`）经
 * dsh launcher 透传的 `cmdlineArgs` 读入，合并到 cordis.yml 配置之上；CLI 优先。
 * `protocol` 为 `v1` 或 `v2` 时只注册对应连接器，强制该版本；缺省 `auto` 同时
 * 注册 v1/v2，由协议路由器按客户端 initialize 请求协商。
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置（provider/model/maxTokens/protocol/client 覆写）。
 * @returns 插件 disposer。
 */
export declare function apply(ctx: Context, config: AcpFullConfig): () => void;
//# sourceMappingURL=plugin.d.ts.map