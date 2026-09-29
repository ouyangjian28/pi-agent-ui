import { spawn } from "node:child_process";

/** M-OPS 模型清单服务（docs/m-ops-design.md §3）：数据源=`pi --list-models` 固定列表格。
 *  解析=表头列偏移定位+`\s{2,}` 切分+列数校验（K3 设计审 P3-3：非脆弱固定列宽）。
 *  进程内缓存 10min；spawn 失败→空表+cause（不抛错——下拉降级 free-text）。 */

/** 清单条目（契约 ModelInfoDTO 服务端源形）。 */
export interface ModelEntry {
  readonly provider: string;
  readonly id: string;
  readonly context?: string;
  readonly thinking?: string;
}

/** 解析结果：ok 或失败原因（cause 透传 models-list 帧）。 */
export type ModelsParseResult = { readonly ok: true; readonly models: readonly ModelEntry[] } | { readonly ok: false; readonly cause: string };

/** 单表解析（纯函数，单测面）。输入=stdout 全文；列=表头行按 `\s{2,}` 定位 provider/model/context/thinking 列序。 */
export function parseModelsTable(stdout: string): ModelsParseResult {
  const lines = stdout.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { ok: false, cause: "空输出" };
  const header = splitColumns(lines[0] as string);
  const pIdx = header.indexOf("provider");
  const mIdx = header.indexOf("model");
  if (pIdx < 0 || mIdx < 0) return { ok: false, cause: "表头缺 provider/model 列" };
  const cIdx = header.indexOf("context");
  const tIdx = header.indexOf("thinking");
  const models: ModelEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitColumns(lines[i] as string);
    if (cols.length < header.length) continue; // 列数不足=废行跳过（非致命）
    const provider = (cols[pIdx] ?? "").trim();
    const id = (cols[mIdx] ?? "").trim();
    if (provider.length === 0 || id.length === 0) continue;
    const context = cIdx >= 0 ? (cols[cIdx] ?? "").trim() : "";
    const thinking = tIdx >= 0 ? (cols[tIdx] ?? "").trim() : "";
    models.push({
      provider,
      id,
      ...(context.length > 0 ? { context } : {}),
      ...(thinking.length > 0 ? { thinking } : {}),
    });
  }
  return { ok: true, models };
}

/** 列切分：两连空格为界（对齐宽表；单空格归入列内——model id 无空格，provider 同）。 */
function splitColumns(line: string): string[] {
  return line.split(/\s{2,}/);
}

/** 清单服务：首次请求触发 spawn+缓存 10min（并发去重——同窗多请求共享一次 spawn）。 */
export class ModelsListingService {
  private cachedAt = 0;
  private cache: ModelsParseResult | null = null;
  private inflight: Promise<ModelsParseResult> | null = null;
  constructor(
    private readonly opts: {
      readonly piBin: string;
      readonly cacheTtlMs?: number;
      readonly now?: () => number;
      readonly spawnImpl?: typeof spawnListModels;
    },
  ) {}

  async list(): Promise<ModelsParseResult> {
    const ttl = this.opts.cacheTtlMs ?? 600_000;
    const now = this.opts.now?.() ?? Date.now();
    if (this.cache !== null && now - this.cachedAt < ttl) return this.cache;
    if (this.inflight !== null) return this.inflight;
    const run = (this.opts.spawnImpl ?? spawnListModels)(this.opts.piBin).then((r) => {
      this.cache = r;
      this.cachedAt = now;
      this.inflight = null;
      return r;
    }, (e: unknown) => {
      const cause = e instanceof Error ? e.message : String(e);
      const r: ModelsParseResult = { ok: false, cause: `pi --list-models 执行失败：${cause}`.slice(0, 200) };
      this.cache = r;
      this.cachedAt = now;
      this.inflight = null;
      return r;
    });
    this.inflight = run;
    return run;
  }
}

/** 真 spawn（测试可替换 spawnImpl）。超时 10s→cause。 */
async function spawnListModels(piBin: string): Promise<ModelsParseResult> {
  return await new Promise<ModelsParseResult>((resolve) => {
    const child = spawn(piBin, ["--list-models"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null;
      child.kill("SIGKILL");
      resolve({ ok: false, cause: "pi --list-models 超时（10s）" });
    }, 10_000);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > 1_048_576) child.kill("SIGKILL"); // 1MiB 读限（防失控输出）
    });
    child.on("error", (e: Error) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ ok: false, cause: `spawn 失败：${e.message}`.slice(0, 200) });
    });
    child.on("close", (code: number | null) => {
      if (timer !== null) clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, cause: `pi --list-models 退出码 ${code ?? "null"}` });
        return;
      }
      resolve(parseModelsTable(out));
    });
  });
}
