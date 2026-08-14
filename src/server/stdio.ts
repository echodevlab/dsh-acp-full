/** stdio 传输与协议路由。@module dsh-acp-full/server/stdio */

import { agentProtocolRouter, ndJsonStream } from '@agentclientprotocol/sdk/experimental/v2'
import type { AgentConnectionLifecycle, AgentProtocolRouter, Stream as WireStream } from '@agentclientprotocol/sdk/experimental/v2'

/**
 * 构造 v1/v2 协议路由器：按客户端 initialize 的 protocolVersion 派发。
 * 调用方按 `protocol` 配置决定注册哪个连接器（`withV1`/`withV2`）；
 * 只注册一个时强制该版本，两个都注册时由路由器协商最高兼容版本。
 * @returns 未注册连接器的路由器。
 */
export function createRouter(): AgentProtocolRouter {
  return agentProtocolRouter()
}

/**
 * 从 process.stdin/stdout 建立 v2 wire 流（路由器入口流，支持批量消息）。
 * @returns 可供 router.connect 消费的流。
 */
export function stdioWireStream(): WireStream {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stderr.write('[dsh-acp-full] stdin stream started\n')
      process.stdin.on('data', (chunk: string | Uint8Array) => {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
      })
      process.stdin.on('end', () => {
        process.stderr.write('[dsh-acp-full] stdin end -> closing stream\n')
        controller.close()
      })
      process.stdin.on('error', error => {
        process.stderr.write(`[dsh-acp-full] stdin error: ${String(error)}\n`)
        controller.error(error)
      })
    },
    cancel() {
      process.stderr.write('[dsh-acp-full] stdin stream cancelled\n')
      process.stdin.pause()
    },
  })
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, error => error ? reject(error) : resolve())
      })
    },
  })
  return ndJsonStream(output, input)
}

/** 连接生命周期（closed 用于清理）。 */
export type { AgentConnectionLifecycle }
