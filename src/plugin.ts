/** dsh-acp-full Cordis 插件入口：启动 stdio ACP v1 + v2 服务器。@module dsh-acp-full */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AcpFullConfig } from './types.ts'
import { mergeConfig, parseCliOverrides } from './server/cli.ts'
import { DshBridge } from './server/bridge.ts'
import { ConnectionCore } from './server/core.ts'
import { createRouter, stdioWireStream } from './server/stdio.ts'
import { createV1App } from './server/v1.ts'
import { createV2App } from './server/v2.ts'

/** 插件名（cordis.yml 引用）。 */
export const name = 'dsh-acp-full'

/** 必需的服务注入。 */
export const inject = ['agents', 'sessions']

/** cordis.yml 中的插件配置。 */
export interface Config extends AcpFullConfig {}

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
export function apply(ctx: Context, config: AcpFullConfig): () => void {
  const effective = mergeConfig(config, parseCliOverrides(ctx))
  const logger = (message: string): void => ctx.logger('dsh-acp-full').info(message)
  const bridge = new DshBridge(ctx, effective)
  const core = new ConnectionCore(ctx, logger)
  const attachments = ctx.get('attachments') as AttachmentStore | undefined

  const v1 = createV1App(core, bridge, effective, attachments, logger)
  const v2 = createV2App(core, bridge, effective, attachments, logger)

  const router = createRouter()
  if (effective.protocol !== 'v2') router.withV1(v1)
  if (effective.protocol !== 'v1') router.withV2(v2)
  const stream = stdioWireStream()
  const lifecycle = router.connect(stream)

  if (lifecycle && typeof lifecycle === 'object' && lifecycle.closed) {
    void lifecycle.closed.then(async () => {
      logger('ACP connection closed; shutting down sessions')
      await core.quiesce()
      // stdio 服务器语义：客户端断开即服务结束。dsh 的其他插件（timer 等）
      // 会保持事件循环，这里显式退出，让宿主（IDE/编辑器）感知进程结束。
      process.exit(0)
    })
  }

  const disposeApproval = ctx.on('approval/request', (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => core.onApproval(req, next))

  return () => {
    disposeApproval()
    void core.quiesce()
  }
}
