import { useEffect, useRef } from "react";
import type { ConversationState } from "./conversation-state";
/** React StrictMode 的 setup→cleanup→setup 是同一 owner 的探测，不是真离场。
 * 延迟一个微任务并按挂载代次复核；真卸载仍 dispose，不复活终局 owner/不放行迟到回执。 */
export function useConversationLifetime(owner: ConversationState): void {
  const epoch = useRef(0);
  useEffect(() => {
    const lease = ++epoch.current;
    return () => queueMicrotask(() => {
      if (epoch.current === lease) owner.dispose();
    });
  }, [owner]);
}
