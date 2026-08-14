/** ACP v1 agent 处理器。@module dsh-acp-full/server/v1 */
import { agent } from '@agentclientprotocol/sdk';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { AcpFullConfig } from '../types.ts';
import { DshBridge } from './bridge.ts';
import { ConnectionCore } from './core.ts';
/**
 * 构建 ACP v1 agent app。
 * @param core - 共享连接核心。
 * @param bridge - dsh 桥。
 * @param config - 插件配置。
 * @param attachments - dsh 附件服务。
 * @param logger - 诊断日志。
 * @returns 注册好全部请求/通知处理器的 app。
 */
export declare function createV1App(core: ConnectionCore, bridge: DshBridge, config: AcpFullConfig, attachments: AttachmentStore | undefined, logger: (message: string) => void): ReturnType<typeof agent>;
//# sourceMappingURL=v1.d.ts.map