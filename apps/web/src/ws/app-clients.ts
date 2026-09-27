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
 * - dev 覆盖：?server=ws://host:port（或 wss://…，可带路径）；仅接受 ws:/wss: scheme，
 *   畸形值/其余 scheme 一律忽略回退默认（受控降级，不把任意字符串送进 WebSocket）。
 */
export function resolveWsUrl(location: WsUrlLocationLike, search: string): string {
  const override = new URLSearchParams(search).get("server");
  if (override !== null && override !== "") {
    let parsed: URL | null = null;
    try {
      parsed = new URL(override);
    } catch {
      parsed = null; // 畸形值：回退默认
    }
    if (parsed !== null && (parsed.protocol === "ws:" || parsed.protocol === "wss:")) {
      return parsed.toString();
    }
  }
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`;
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
