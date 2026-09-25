import { type FSWatcher } from "node:fs";
export interface SessionSummary {
    /** 宿主会话身份=header.id；null=header 损坏/缺 id（身份不可信，上层显式降级，不得冒充）。 */
    readonly sessionId: string | null;
    /** 文件定位键（basename，含 .jsonl 后缀；≠会话身份）。 */
    readonly file: string;
    readonly title: string;
    readonly lastActiveMs: number | null;
    /** 可解析对象行数（header 除外；口径=entry 计数近似值，坏行/撕裂尾/非对象行不计）。 */
    readonly entryCount: number;
    readonly sizeBytes: number;
}
export interface SessionScanOptions {
    /** 标题截断长度（默认 80）。 */
    readonly titleMaxChars?: number;
    /** 列表上限（默认 200）。 */
    readonly limit?: number;
}
/** 扫描目录下 *.jsonl 会话文件，按最后活动时间倒序。 */
export declare function listSessions(dir: string, opts?: SessionScanOptions): Promise<SessionSummary[]>;
/** 目录级 watch：变化门铃（rename 事件可能来自新增/删除/替换）→回调通知；调用方须重扫确认，不得假定=新会话（r8 建议）。 */
export declare function watchSessions(dir: string, onChange: (file: string) => void): FSWatcher | null;
//# sourceMappingURL=session-list.d.ts.map