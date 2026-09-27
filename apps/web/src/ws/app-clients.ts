// A1d 组合根：真模式三件套装配。现状惯例=每面一连接（列表/订阅/写三面各持独立 WS 连接，
// 互不侵入）——本模块只做「用同一 url+token 建三面连接并统一释放」，不重连、不重发、不共享 socket。
import { SubscribeClient } from "./subscribe-client";
import { WriteClient } from "./write-client";
import { WsClient } from "./ws-client";
import type { WebSocketFactory } from "./ws-client";

/** WS URL 推导所需的最小 location 面（纯函数入参，测试友好）。 */
export interface WsUrlLocationLike {
  readonly protocol: string;
  readonly host: string;
}

/**
 * WS URL 推导（纯函数，独立可测）：
 * - 默认同源：ws(s)://location.host（https 页面→wss，http→ws）；服务端在同端口静态托管+任意路径 upgrade。
 * - dev 覆盖：?server=ws(s)://…（可带路径）——仅当 dev 为真（缺省=import.meta.env.DEV）时生效；
 *   生产模式下任何 ?server= 一律忽略、回退同源。
 *   注意：这不是通用参数校验，而是【凭据目的地绑定】（GPT 审 B1）——hello 帧携带访问令牌，
 *   绝不允许页面 URL 在生产环境把凭据接收方改指向任意主机（已存令牌会被自动外带）。
 * - 覆盖值仅接受 ws:/wss: scheme 且无 fragment（WebSocket 构造器语义不含 #；
 *   畸形值/带 fragment/其余 scheme 一律忽略回退默认，不把任意字符串送进 WebSocket）。
 */
export interface ResolveWsUrlOptions {
  /** 注入桩：缺省=import.meta.env.DEV；测试生产语义显式传 { dev: false }。 */
  readonly dev?: boolean;
}

export function resolveWsUrl(location: WsUrlLocationLike, search: string, options?: ResolveWsUrlOptions): string {
  const dev = options?.dev ?? import.meta.env.DEV;
  const override = dev ? new URLSearchParams(search).get("server") : null;
  if (override !== null && override !== "") {
    let parsed: URL | null = null;
    try {
      parsed = new URL(override);
    } catch {
      parsed = null; // 畸形值：回退默认
    }
    // N2：带 fragment 的 ws(s) URL 按畸形处理（不进 WebSocket 构造器）。判据用原始字符串包含 "#"：
    // URL.hash 只能区分非空 fragment，尾随空 "#"（hash===""）会被漏拒（GPT r2 补证）。
    if (
      parsed !== null &&
      (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
      !override.includes("#")
    ) {
      return parsed.toString();
    }
  }
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`;
}

/**
 * 凭据目的地绑定判据（GPT 审 B1）：hello 是否允许携带（已存/手输）令牌的唯一判据。
 * 同源 = 协议映射一致（https 页面只认 wss://——顺带杜绝 https 页面被 ?server= 降级为明文 ws://）
 * 且 host:port 全等（不同端口即跨源）。任一不同=未受信目的地：组合根一律不拨线
 *（选项 A 拒绝面：三件套不建、hello 永不发出），已存令牌绝不出本源。
 */
export function isSameOriginWsTarget(location: WsUrlLocationLike, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // 不可解析一律视为未受信
  }
  const expectedProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  return parsed.protocol === expectedProtocol && parsed.host === location.host;
}

/** 真模式三件套：列表/订阅/写三面客户端 + 统一释放。 */
export interface AppClients {
  readonly wsClient: WsClient;
  readonly subscribeClient: SubscribeClient;
  readonly writeClient: WriteClient;
  /** 统一 close 三面连接（幂等；各客户端 close 屏障保证迟到回调零副作用）。 */
  dispose(): void;
}

export interface CreateAppClientsOptions {
  readonly url: string;
  /** hello 携带的令牌；只发往同源目的地（跨源由组合根在调用前拒绝，选项 A 不拨线）。 */
  readonly token: string;
  /** 测试注入假 socket；缺省=浏览器全局 WebSocket（各客户端 defaultFactory）。 */
  readonly createSocket?: WebSocketFactory | undefined;
}

/**
 * 建三面独立连接并各自 connect()。token 一经 token 门确定才可调用本函数
 * （组合根保证时序）；createSocket 缺省时由各客户端读 globalThis.WebSocket。
 */
export function createAppClients(options: CreateAppClientsOptions): AppClients {
  const { url, token, createSocket } = options;
  const wsClient = new WsClient(url, token, createSocket);
  const subscribeClient = new SubscribeClient(url, token, createSocket);
  const writeClient = new WriteClient(url, token, createSocket);
  wsClient.connect();
  subscribeClient.connect();
  writeClient.connect();
  let disposed = false;
  return {
    wsClient,
    subscribeClient,
    writeClient,
    dispose() {
      if (disposed) return;
      disposed = true;
      wsClient.close();
      subscribeClient.close();
      writeClient.close();
    },
  };
}
