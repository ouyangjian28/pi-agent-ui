// 会话列表扫描（TECH §6 会话互见：查看≠接管；列表=只读扫描会话文件）
// session-format v3 JSONL：首行 header（type:"session"/version:3/id/timestamp），后续 entry 行（type:"message" 等）。
// r8-03：header 按【类型】识别（非位置）——坏 header 不吞下一条正常 entry；身份损坏=sessionId:null 显式呈现，由上层降级/跳过。
// r8-04：宿主会话身份=header.id（真实文件名=${fileTimestamp}_${sessionId}.jsonl ≠ 身份）；file 字段=文件定位键，两者分开。
// 坏行跳过（不炸列表）；目录不存在=空列表；目录级 fs.watch=变化门铃（可能新增/删除/替换）→调用方重扫确认，不保证=新会话。
import { watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
/** 扫描目录下 *.jsonl 会话文件，按最后活动时间倒序。 */
export async function listSessions(dir, opts = {}) {
    const titleMax = opts.titleMaxChars ?? 80;
    const limit = opts.limit ?? 200;
    let files;
    try {
        files = await readdir(dir);
    }
    catch {
        return []; // 目录不存在/不可读=空列表（不炸）
    }
    const summaries = [];
    for (const f of files) {
        if (!f.endsWith(".jsonl"))
            continue;
        const path = join(dir, f);
        try {
            const [info, text] = await Promise.all([stat(path), readFile(path, "utf8")]);
            const { sessionId, title, lastMs, entryCount } = summarize(text, titleMax);
            summaries.push({ sessionId, file: f, title, lastActiveMs: lastMs, entryCount, sizeBytes: info.size });
        }
        catch {
            continue; // 单文件坏（权限/中途删除）=跳过，不影响其余
        }
    }
    summaries.sort((a, b) => (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0));
    return summaries.slice(0, limit);
}
function summarize(text, titleMax) {
    let sessionId = null;
    let title = "";
    let lastMs = null;
    let entryCount = 0;
    let headerResolved = false; // header 已识别（成功解析或判定损坏/缺失）
    for (const line of text.split("\n")) {
        if (!line.trim())
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            // 坏行跳过（撕裂尾=半行 JSON）；若是首行（header 位）→身份损坏显式化，不吞后续行（r8-03）
            headerResolved = true;
            continue;
        }
        if (!headerResolved) {
            headerResolved = true;
            const r = obj;
            if (typeof obj === "object" && obj !== null && r.type === "session") {
                sessionId = typeof r.id === "string" && r.id ? r.id : null; // 身份=header.id（r8-04）
                const ts = extractTimestamp(obj);
                if (ts !== null)
                    lastMs = ts; // 纯 header 文件也有活动时刻
                continue;
            }
            // 首行可解析但非 session header：header 缺失/截断——按正文 entry 计，不吞（r8-03）
        }
        if (typeof obj !== "object" || obj === null)
            continue; // 非对象行不计 entry（口径见 SessionSummary）
        entryCount += 1;
        const ts = extractTimestamp(obj);
        if (ts !== null)
            lastMs = ts;
        if (!title)
            title = extractUserText(obj, titleMax);
    }
    return { sessionId, title: title || "(无标题)", lastMs, entryCount };
}
function extractTimestamp(obj) {
    if (typeof obj !== "object" || obj === null)
        return null;
    const ts = obj.timestamp ?? obj.ts;
    if (typeof ts === "number")
        return ts;
    if (typeof ts === "string") {
        const p = Date.parse(ts);
        return Number.isFinite(p) ? p : null;
    }
    return null;
}
function extractUserText(obj, titleMax) {
    if (typeof obj !== "object" || obj === null)
        return "";
    const r = obj;
    if (r.type !== "message" && r.role !== "user")
        return "";
    const role = r.role ?? (typeof r.message === "object" && r.message !== null ? r.message.role : undefined);
    if (role !== "user")
        return "";
    const content = r.content ?? (typeof r.message === "object" && r.message !== null ? r.message.content : undefined);
    let text = "";
    if (typeof content === "string")
        text = content;
    else if (Array.isArray(content)) {
        for (const c of content) {
            if (typeof c === "object" && c !== null && c.type === "text") {
                text = String(c.text ?? "");
                break;
            }
        }
    }
    text = text.trim().replace(/\s+/g, " ");
    return text.length > titleMax ? text.slice(0, titleMax) + "…" : text;
}
/** 目录级 watch：变化门铃（rename 事件可能来自新增/删除/替换）→回调通知；调用方须重扫确认，不得假定=新会话（r8 建议）。 */
export function watchSessions(dir, onChange) {
    try {
        return watch(dir, (event, filename) => {
            if (typeof filename === "string" && filename.endsWith(".jsonl") && event === "rename")
                onChange(filename);
        });
    }
    catch {
        return null; // 目录不存在=不 watch（调用方可先建目录）
    }
}
//# sourceMappingURL=session-list.js.map