// A1d token 门：token 一经确定才允许 createAppClients。来源优先级：
// ①URL ?token=（一次性引导链接；读取后立即 history.replaceState 清掉参数防泄漏，其余参数如 server= 保留）
// ②localStorage("pi-agent-ui.token") ③都没有→渲染受控输入面（提交后存 localStorage）。
// 红线：token 不写入 URL 历史；任何错误文案不回显 token 值；不使用 innerHTML。
import React, { useState } from "react";

export const TOKEN_STORAGE_KEY = "pi-agent-ui.token";

export interface UrlTokenRead {
  /** 有效 token：首个非空 token 值；全部为空/不存在时为 null。 */
  readonly token: string | null;
  /** 清除全部 token 键后的 search（其余参数含重复键保留；空串=无参数）。 */
  readonly cleanedSearch: string;
  /** search 中是否出现过 token 键（含空值/重复键）——为真即应 replaceState 清参。 */
  readonly hadTokenParam: boolean;
}

/**
 * 从 search 读 token（纯函数）。N1 修复：「读有效 token」与「删全部 token 参数」分离——
 * 有效 token=首个非空值（`?token=&token=x` 取 x）；cleanedSearch 一律剔除全部 token 键
 *（含空值/重复键，URLSearchParams.delete 语义），其余参数（含重复 x=1&x=2）原序保留。
 */
export function readUrlToken(search: string): UrlTokenRead {
  const params = new URLSearchParams(search);
  const hadTokenParam = params.has("token");
  if (!hadTokenParam) {
    return { token: null, cleanedSearch: search, hadTokenParam: false };
  }
  const token = params.getAll("token").find((v) => v !== "") ?? null;
  params.delete("token"); // 删全部 token 键（含空值与重复键）
  const rest = params.toString();
  return { token, cleanedSearch: rest === "" ? "" : `?${rest}`, hadTokenParam: true };
}

/**
 * 把剔除 token 后的 search 写回地址栏（history.replaceState：不留历史、不回退可达）。
 * N1 修复：保留 hash 与 history.state（旧实现拼 pathname+search 会把二者丢成空/null）。
 */
export function clearUrlToken(cleanedSearch: string): void {
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + cleanedSearch + window.location.hash,
  );
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // 隐私模式等：降级为「每次询问」
  }
}

export function readStoredToken(): string | null {
  try {
    const token = safeStorage()?.getItem(TOKEN_STORAGE_KEY) ?? null;
    return token === null || token === "" ? null : token;
  } catch {
    return null;
  }
}

export function storeToken(token: string): void {
  try {
    safeStorage()?.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // 存储不可用：本次会话照常使用，刷新后重新输入
  }
}

export function clearStoredToken(): void {
  try {
    safeStorage()?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // 同上：忽略
  }
}

/**
 * token 输入面（受控）：两来源都缺省时渲染；提交(trim 后非空)才回调 onSubmitToken。
 * 存储/清 URL/建连接由调用方（RealApp）编排，本组件只管输入。
 */
export function TokenGate({ onSubmitToken }: { onSubmitToken: (token: string) => void }) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  return (
    <div className="app">
      <section className="new-session token-gate" aria-label="令牌输入面">
        <h1>连接 pi 服务</h1>
        <p>
          请输入访问令牌（token）。令牌仅保存在本浏览器 localStorage，不会出现在地址栏； 服务端若轮换令牌，旧令牌会以 4401 拒绝。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed === "") return;
            onSubmitToken(trimmed);
          }}
        >
          <label>
            访问令牌
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              // 令牌不回显、不进历史；password 面只是遮罩，提交仍走受控回调
            />
          </label>
          <button type="submit" disabled={trimmed === ""}>
            连接
          </button>
        </form>
      </section>
    </div>
  );
}
