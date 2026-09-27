// ⑤B（3c-5）：静态托管——自举里程碑（pi-agent-ui 自己改自己）的第一块服务端拼图。
// 同端口提供 web 构建产物（vite build → dist），浏览器打开即得 UI，WS 同源 upgrade。
// 设计约束：
// - fail-closed：目录外解析（穿越/编码逃逸）与点文件一律 404，绝不回退到目录外；
// - 只读 GET/HEAD（405 其余）；SPA 无路由=v1 仅 `/` 回 index.html，深路径不回退（避免把 404 面扩大成应用面）；
// - Cache-Control: no-store + Connection: close——no-store=构建产物指纹策略未定前的保守值；
//   close=让 server.close() 不被 keep-alive 拖住（dispose 有界性优先于连接复用）；
// - 静态面无认证（loopback 自举场景；跨网卡暴露须由使用者自行加 TLS/反代——README 已述威胁模型）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

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

/** 解析受控路径：返回绝对文件路径；越界/点文件/畸形解码=null（调用方一律 404/400，fail-closed）。 */
export function resolveStaticPath(rootDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // 畸形百分号序列：不猜测语义
  }
  if (decoded.includes("\0")) return null;
  const root = resolve(rootDir);
  const full = resolve(join(root, decoded));
  if (full !== root && !full.startsWith(root + sep)) return null; // 穿越门（含 ..、绝对段拼接逃逸）
  const rel = full === root ? "" : full.slice(root.length + sep.length);
  for (const seg of rel.split(sep)) {
    if (seg === "" || seg === "." || seg === ".." || seg.startsWith(".")) return null; // 点文件=404
  }
  return full;
}

/** 静态请求处理器：只应答 GET/HEAD；`/`（含尾斜杠归一）→ index.html；存在性=stat 文件（目录→404）。 */
export function createStaticHandler(
  rootDir: string,
  audit: (line: string) => void = () => {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const root = resolve(rootDir);
  return (req, res) => {
    const method = req.method ?? "GET";
    const url: string = req.url ?? "/";
    if (method !== "GET" && method !== "HEAD") {
      audit(`static-reject method=${method}`);
      reply(res, 405, "method not allowed", { Allow: "GET, HEAD" });
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(url, "http://static.local").pathname;
    } catch {
      reply(res, 400, "bad request");
      return;
    }
    const target = resolveStaticPath(root, pathname === "/" ? "/index.html" : pathname);
    if (target === null) {
      audit(`static-reject path=${pathname} rule=outside-or-dotfile`);
      reply(res, 404, "not found");
      return;
    }
    void (async () => {
      try {
        const st = await stat(target);
        if (!st.isFile()) {
          audit(`static-miss path=${pathname} rule=not-file`);
          reply(res, 404, "not found");
          return;
        }
        const type = MIME[extname(target).toLowerCase()] ?? "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": type,
          "Content-Length": String(st.size),
          "Cache-Control": "no-store",
          Connection: "close",
        });
        if (method === "HEAD") {
          res.end();
          return;
        }
        const stream = createReadStream(target);
        stream.on("error", () => { try { res.destroy(); } catch { /* 已销毁 */ } });
        stream.pipe(res);
        audit(`static-hit path=${pathname} bytes=${st.size}`);
      } catch {
        audit(`static-miss path=${pathname}`);
        reply(res, 404, "not found");
      }
    })();
  };
}
