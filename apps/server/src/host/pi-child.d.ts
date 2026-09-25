import { type ChildProcessWithoutNullStreams } from "node:child_process";
export interface PiEvent {
    readonly type: string;
    readonly [k: string]: unknown;
}
export interface PiChildHandlers {
    onEvent(e: PiEvent): void;
    onStderr(text: string): void;
    onExit(code: number | null, signal: string | null): void;
}
/** spawn pi（--mode json：stdout=JSONL 事件流；stdin 立即 EOF——否则 readPipedStdin 等 stdin 数据挂死零输出）。 */
export declare function spawnPi(args: readonly string[], h: PiChildHandlers): ChildProcessWithoutNullStreams;
/** 挂常驻排空泵（也用于非本模块 spawn 的子进程：测试/复用）。r8：解析错与业务回调错分离——onEvent 抛错不得伪装成坏 JSON。 */
export declare function attachPumps(child: ChildProcessWithoutNullStreams, h: PiChildHandlers): void;
//# sourceMappingURL=pi-child.d.ts.map