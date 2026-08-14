/** ACP v2 draft agent 处理器。@module dsh-acp-full/server/v2 */
import { agent } from '@agentclientprotocol/sdk/experimental/v2';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { AcpFullConfig } from '../types.ts';
import { DshBridge } from './bridge.ts';
import { ConnectionCore } from './core.ts';
/**
 * 构建 ACP v2 draft agent app。
 * @param core - 共享连接核心。
 * @param bridge - dsh 桥。
 * @param config - 插件配置。
 * @param attachments - dsh 附件服务。
 * @param logger - 诊断日志。
 * @returns 注册好全部请求/通知处理器的 app。
 */
export declare function createV2App(core: ConnectionCore, bridge: DshBridge, config: AcpFullConfig, attachments: AttachmentStore | undefined, logger: (message: string) => void): ReturnType<typeof agent>;
//# sourceMappingURL=v2.d.ts.map