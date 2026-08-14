/** stdio 传输与协议路由。@module dsh-acp-full/server/stdio */
import type { AgentConnectionLifecycle, AgentProtocolRouter, Stream as WireStream } from '@agentclientprotocol/sdk/experimental/v2';
/**
 * 构造 v1/v2 协议路由器：按客户端 initialize 的 protocolVersion 派发。
 * 调用方按 `protocol` 配置决定注册哪个连接器（`withV1`/`withV2`）；
 * 只注册一个时强制该版本，两个都注册时由路由器协商最高兼容版本。
 * @returns 未注册连接器的路由器。
 */
export declare function createRouter(): AgentProtocolRouter;
/**
 * 从 process.stdin/stdout 建立 v2 wire 流（路由器入口流，支持批量消息）。
 * @returns 可供 router.connect 消费的流。
 */
export declare function stdioWireStream(): WireStream;
/** 连接生命周期（closed 用于清理）。 */
export type { AgentConnectionLifecycle };
//# sourceMappingURL=stdio.d.ts.map