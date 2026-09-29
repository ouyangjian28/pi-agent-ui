// ⑤B（3c-5）：生产入口——自举里程碑（pi-agent-ui 自己改自己）的启动面。
// 库模式（composition.startServer）之上的进程级包装：CLI 参数解析（零依赖）、审计落 stdout、
// 信号处置（SIGINT/SIGTERM=优雅 dispose；SIGHUP=token 热轮换）。
// 运行：node --experimental-transform-types apps/server/src/main.ts --port 8787 --token-file ~/.pi-agent-ui/tokens.json \
//        --root /abs/repo --scan-dir /abs/repo/runs --static-dir apps/web/dist
// 约束：Node ≥24（仓内 ws-transport 等用参数属性=非纯 erasable，故需 transform-types；
// 零新依赖——CLI/信号/生命周期全是本文件+组合根既有件）。
import { startServer } from "./composition.ts";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

interface CliArgs {
  port?: number;
  host?: string;
  tokenFile?: string;
  roots: string[];
  scanDir?: string;
  staticDir?: string;
  origins: string[];
  piBin?: string;
  trustedProxies: string[];
  sessionDir?: string;
  readOnly?: boolean;
}

function usage(): string {
  return [
    "用法：node --experimental-transform-types apps/server/src/main.ts --port <固定端口> --token-file <path> --root <abs> [--root <abs>…] [--scan-dir <abs>] [--static-dir <abs>] [--origin <url>…] [--host <ip>] [--pi-bin <path>] [--trusted-proxy <cidr>…] [--session-dir <abs>] [--read-only]",
    "  --port          固定端口（staticDir 模式必填：同源 origin 白名单需预知端口）",
    "  --token-file    token 文件（0600 {version:1,tokens:[…]}）",
    "  --root          授权根（可重复；绝对路径且存在）——读面文件域+写面 cwd 授权域+目录选择器选项",
    "  --scan-dir      list-sessions 扫描目录（默认=第一个 root）",
    "  --static-dir    web 构建产物目录（设为同端口静态托管）",
    "  --origin        Origin 白名单（默认=推导 http://127.0.0.1:<port> 与 http://localhost:<port>）",
    "  --host          监听地址（默认 127.0.0.1——loopback-only 是本工具的威胁模型边界）",
    "  --pi-bin        pi 可执行路径（默认=PATH 里的 pi；启用写面+模型清单服务）",
    "  --trusted-proxy 可信代理 CIDR/IP（可重复；反向代理回程——启用后 X-Forwarded-* 才被采信）",
    "  --session-dir   journal 落盘树（默认=第一个 root；须在 roots 内——否则写出 journal 读面不可达）",
    "  --read-only     关闭写面（只读部署逃生门；默认写面开——--root 即授权写入 journal 域）",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { roots: [], origins: [], trustedProxies: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`参数 ${a} 缺值`);
      i++;
      return v;
    };
    switch (a) {
      case "--port": args.port = Number(next()); break;
      case "--host": args.host = next(); break;
      case "--token-file": args.tokenFile = next(); break;
      case "--root": args.roots.push(next()); break;
      case "--scan-dir": args.scanDir = next(); break;
      case "--static-dir": args.staticDir = next(); break;
      case "--origin": args.origins.push(next()); break;
      case "--pi-bin": args.piBin = next(); break;
      case "--trusted-proxy": args.trustedProxies.push(next()); break;
      case "--session-dir": args.sessionDir = next(); break;
      case "--read-only": args.readOnly = true; break;
      case "--help": case "-h": console.log(usage()); process.exit(0); break;
      default: throw new Error(`未知参数 ${a}\n${usage()}`);
    }
  }
  return args;
}

async function assertDir(path: string, label: string): Promise<string> {
  // r1（审清理项）：绝对性检查在 resolve 之前对原始输入做——resolve 的返回值恒为绝对路径，先 resolve 再查=恒真
  if (!isAbsolute(path)) throw new Error(`${label} 须绝对路径：${path}`);
  const abs = resolve(path);
  const st = await stat(abs).catch(() => { throw new Error(`${label} 不存在：${abs}`); });
  if (!st.isDirectory()) throw new Error(`${label} 不是目录：${abs}`);
  return abs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.tokenFile === undefined) throw new Error(`--token-file 必填\n${usage()}`);
  if (args.roots.length === 0) throw new Error(`--root 必填（至少一个）\n${usage()}`);
  args.trustedProxies = args.trustedProxies ?? [];
  if (args.port === undefined || !Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
    throw new Error(`--port 必填且为 1-65535 整数（固定端口=同源 origin 可预知）\n${usage()}`);
  }
  const roots: string[] = [];
  for (const r of args.roots) roots.push(await assertDir(r, "--root"));
  const scanDir = args.scanDir !== undefined ? await assertDir(args.scanDir, "--scan-dir") : roots[0]!;
  const staticDir = args.staticDir !== undefined ? await assertDir(args.staticDir, "--static-dir") : undefined;
  const host = args.host ?? "127.0.0.1";
  const origins = args.origins.length > 0
    ? args.origins
    : [`http://127.0.0.1:${args.port}`, `http://localhost:${args.port}`];
  // 批A（P1-01）：写面接线——journal 树与项目根分离。
  // 写面 file 域口径=resolveWithinRoots 首根命中（网关/statusFor/uiHost/entry/恢复链全链同源）：
  // 故 sessionDir 必须排在 effectiveRoots[0]——逻辑名→journal 落点=首根命中=journal 树（否则落
  // 项目根错位，生产烟测⑥ 抓过）。副作用全为正：scanDir 默认=首根=journal 扫描树（原本错扫项目根）；
  // 授权域仍含全部 roots（读面/cwd 门不变）。
  const sessionDir = args.sessionDir !== undefined ? await assertDir(args.sessionDir, "--session-dir") : roots[0]!;
  const effectiveRoots = [sessionDir, ...roots.filter((r) => r !== sessionDir)];
  const piBin = args.piBin ?? "pi";

  const audit = (line: string): void => { console.log(`${new Date().toISOString()} ${line}`); };
  const server = await startServer({
    tokenFile: args.tokenFile,
    allowedOrigins: origins,
    roots: effectiveRoots,
    scanDir,
    ...(staticDir !== undefined ? { staticDir } : {}),
    ...(args.readOnly !== true ? {
      write: {
        sessionFor: (file: string) => file, // 写面 file 键=网关首根解析后的绝对路径（E2E rig 同口径）；此处直通（RpcWriteHost 层消费绝对路径）
        piBin,
      },
    } : {}),
    ...(args.trustedProxies.length > 0 ? { trustedProxies: args.trustedProxies } : {}),
    port: args.port,
    host,
    registerSighup: true,
    audit,
  });
  audit(`main ready url=http://${host === "127.0.0.1" ? "127.0.0.1" : host}:${server.port}${staticDir !== undefined ? " (静态托管 " + staticDir + ")" : ""} origins=${origins.join(",")} roots=${roots.join(",")}${args.readOnly !== true ? ` write=on sessionDir=${sessionDir} piBin=${piBin}` : " write=off"}${args.trustedProxies.length > 0 ? ` trustedProxies=${args.trustedProxies.join(",")}` : ""}`);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    audit(`main signal=${signal} disposing`);
    void server.dispose().then(() => { audit("main disposed"); process.exit(0); }, (err: unknown) => {
      audit(`main dispose-error err=${String(err)}`);
      process.exit(1);
    });
  };
  process.on("SIGINT", () => { shutdown("SIGINT"); });
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
}

void main().catch((err: unknown) => {
  console.error(`启动失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
