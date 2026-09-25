import { type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProcessHandle, ProcessHostPort, ProcessSpawnHandlers } from "@pi-agent-ui/protocol";
export interface PiProcessHostOpts {
    /** pi 可执行文件（默认 PATH 解析 "pi"；测试/部署可换绝对路径）。 */
    readonly piBin?: string;
    /** spawn 函数注入（单元测试用假 child；默认 node:child_process.spawn）。 */
    readonly spawnFn?: (bin: string, args: string[], opts: {
        stdio: "pipe"[];
        detached: boolean;
    }) => ChildProcessWithoutNullStreams;
    /** 审计/诊断行（默认丢弃）。 */
    readonly onAudit?: (line: string) => void;
}
export declare class PiProcessHost implements ProcessHostPort {
    private readonly opts;
    private static seq;
    private readonly procs;
    constructor(opts?: PiProcessHostOpts);
    private audit;
    spawn(args: readonly string[], h: ProcessSpawnHandlers): ProcessHandle;
    writeStdin(h: ProcessHandle, text: string): Promise<void>;
    stop(h: ProcessHandle, signal: "SIGTERM" | "SIGKILL"): void;
    /** 优雅关闭：stdin EOF（pi RPC 收到 EOF 即退，实测 code=0）。端口外附加面，组装层用；监管器 retire 走信号路径。 */
    closeStdin(h: ProcessHandle): void;
}
//# sourceMappingURL=process-host.d.ts.map