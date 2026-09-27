// ⑤B（3c-5）：静态托管——自举里程碑（pi-agent-ui 自己改自己）的第一块服务端拼图。
// 同端口提供 web 构建产物（vite build → dist），浏览器打开即得 UI，WS 同源 upgrade。
// 设计约束（r1 修订：2026-10-05 GPT 审 74→四阻断修复后口径）：
// - fail-closed：基于「原始 request-target」逐段解码校验（不用 new URL().pathname——它会先消掉
//   ../%2e%2e 点段，使拒绝契约失效）；点文件、空段、点段、段内编码分隔符一律 404；
// - 真实路径边界（B1）：root 与目标均 realpath 后做包含检查——根内 symlink 指向根外=404；
//   最终分量用 O_NOFOLLOW 打开，realpath→open 之间被换成 symlink=打开失败 fail-closed；
//   残余竞态（中间目录在 realpath 后、open 前被换成指向根外的 symlink）不做 fail-closed 承诺——
//   静态根是操作者控制的构建产物目录，能写其父目录者本可直接改写产物内容（威胁模型内不新增面）；
// - 只读 GET/HEAD（405 其余）；SPA 无路由=v1 仅 `/` 回 index.html，深路径不回退；
// - Cache-Control: no-store + Connection: close——no-store=构建产物指纹策略未定前的保守值；
//   close=让 server.close() 不被 keep-alive 拖住（dispose 有界性优先于连接复用；半截请求头
//   连接由 composition 的 closeAllConnections 兜底——ST6 专测该形态）；
// - 静态面无认证（loopback 自举场景；跨网卡暴露须由使用者自行加 TLS/反代——README 已述威胁模型）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, realpathSync, constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const HEADERS_ONLY = new Set(["HEAD"]);

function reply(res: ServerResponse, code: number, body: string, extra: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    Connection: "close",
    ...extra,
  };
  res.writeHead(code, headers);
  res.end(HEADERS_ONLY.has(res.req?.method ?? "GET") ? undefined : body);
}

/**
 * 解析受控路径（r1：输入=原始 request-target，非归一化 pathname）。
 * 返回绝对文件路径（字面解析层）；越界/点文件/点段/畸形解码/段内分隔符=null（调用方一律 404，fail-closed）。
 * 本函数只做字面层校验；symlink 真实边界由 handler 的 realpath 包含门负责（两层分离）。
 */
export function resolveStaticPath(rootDir: string, rawTarget: string): string | null {
  // request-target（origin-form）分手 query：只取首个 ? 之前；裸 # 仅在路径部分拒绝
  // （query 内 # 不拒=有意语义：query 不参与磁盘解析；N1 口径 2026-10-05 GPT r2 拍板收窄）
  const q = rawTarget.indexOf("?");
  const pathOnly = q === -1 ? rawTarget : rawTarget.slice(0, q);
  if (pathOnly.includes("#")) return null;
  if (!pathOnly.startsWith("/")) return null;
  if (pathOnly === "/") {
    const rootSelf = resolve(rootDir);
    return resolve(rootSelf, "index.html");
  }
  // 逐段解码：先按字面 / 分段，再对每段单独 decodeURIComponent——
  // %2f 解码后留在段内（不当分隔符），含 / 的解码段直接拒（B2：防编码逃逸制造新段结构）
  const root = resolve(rootDir);
  const segs: string[] = [];
  for (const rawSeg of pathOnly.slice(1).split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(rawSeg);
    } catch {
      return null; // 畸形百分号序列：不猜测语义
    }
    if (seg === "" || seg === "." || seg === "..") return null; // 空段（含 //）/点段=拒
    if (seg.startsWith(".")) return null; // 点文件=拒
    if (seg.includes("/") || seg.includes("\\") || seg.includes("\0")) return null; // 编码分隔符/NUL=拒
    segs.push(seg);
  }
  if (segs.length === 0) return resolve(root, "index.html");
  const full = resolve(root, ...segs);
  if (full !== root && !full.startsWith(root + sep)) return null; // 兜底前缀门（段已验证后不应触发）
  return full;
}

/** 静态请求处理器：只应答 GET/HEAD；`/`→index.html；存在性=fstat 文件（目录→404）；
 * 真实边界=realpath 包含门（root 与目标各 realpath；B1）。 */
export function createStaticHandler(
  rootDir: string,
  audit: (line: string) => void = () => {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const root = resolve(rootDir);
  // 根自身是 symlink：按解析后真实根为口径（根内普通文件与根目录 symlink 口径一致）
  const realRoot = realpathSync(root);
  return (req, res) => {
    const method = req.method ?? "GET";
    const url: string = req.url ?? "/";
    if (method !== "GET" && method !== "HEAD") {
      audit(`static-reject method=${method}`);
      reply(res, 405, "method not allowed", { Allow: "GET, HEAD" });
      return;
    }
    const target = resolveStaticPath(root, url);
    if (target === null) {
      audit(`static-reject path=${url.split("?")[0] ?? url} rule=raw-target-invalid`);
      reply(res, 404, "not found");
      return;
    }
    void (async () => {
      let fh: FileHandle | null = null;
      try {
        // B1 真实边界：目标 realpath 须落在真实根内（否则=根内 symlink 指向根外→404）
        const real = await realpath(target);
        if (real !== realRoot && !real.startsWith(realRoot + sep)) {
          audit(`static-reject path=${url.split("?")[0] ?? url} rule=symlink-escape`);
          reply(res, 404, "not found");
          return;
        }
        // 最终分量 O_NOFOLLOW：realpath 后被换成 symlink→打开失败 fail-closed（ELOOP→404）
        fh = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const st = await fh.stat();
        if (!st.isFile()) {
          audit(`static-miss path=${url.split("?")[0] ?? url} rule=not-file`);
          reply(res, 404, "not found");
          await fh.close();
          return;
        }
        const type = MIME[extname(real).toLowerCase()] ?? "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": type,
          "Content-Length": String(st.size),
          "Cache-Control": "no-store",
          Connection: "close",
        });
        if (method === "HEAD") {
          res.end();
          await fh.close();
          return;
        }
        // createReadStream 用已开 fd：路径再换链不影响本流（句柄绑定，非路径再解析）
        const stream = createReadStream(real, { fd: fh, start: 0 });
        stream.on("error", () => { try { res.destroy(); } catch { /* 已销毁 */ } });
        stream.pipe(res);
        audit(`static-hit path=${url.split("?")[0] ?? url} bytes=${st.size}`);
      } catch {
        audit(`static-miss path=${url.split("?")[0] ?? url}`);
        reply(res, 404, "not found");
        try { await fh?.close(); } catch { /* 已关 */ }
      }
    })();
  };
}
