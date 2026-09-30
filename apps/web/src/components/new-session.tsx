// 新建会话视图（批3 用户拍板减法）：**用户只见 模型+首条消息**——
// 文件名后台自动生成（autoFile，用户不可见不可改）；工作目录恒服务端默认（不渲染选择器、
// 不拉取等待面——requestRoots 数据域调用保留供壳层 rootsHint，UI 零目录元素）。
// 首 prompt 成功（write-ack launched）→onLaunched(file) 由壳切正常 SessionDetail；
// 启动失败（not-ready）→响亮红条（重试=重发同 prompt；换模型=清模型选择重选）。
// 模型选择双通道：下拉（get-models 清单；loading/failed 均降级）+free-text 输入（优先生效——
// 清单失败/新模型未入清单仍可手打 id；modelPattern 本地预校验零帧成本）。
// 模型记住上次：create 成功发出即写 localStorage（仅 __default__ 或过 modelPattern 的值）；
// 挂载恢复（坏值丢弃防御）。
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LIMITS } from "@pi-agent-ui/protocol/src/contracts";
import { NotReadyBanner } from "./not-ready-banner";
import type { NotReadyInfo } from "../ws/use-write";
import type { ModelInfoDTO } from "@pi-agent-ui/protocol/src/contracts";
import type { WriteClientSurface } from "../ws/write-client";
import type { ModelsState, RootsState } from "../ws/ws-client";

/** 新建视图消费的清单面（最小接口：真 WsClient 满足；测试可注入 stub）。 */
export interface ModelsSource {
  readonly requestModels: () => void;
  /** P2-3/P3-1（DS 审）：响应式订阅——ws 状态到 ready 后补拉（connecting 期挂载的一次拉会被 ready 态门静默丢弃，不补拉则清单永久 idle 停滞）；同时消除直读快照的 tearing 风险。 */
  readonly subscribe: (cb: () => void) => () => void;
  readonly getSnapshot: () => { readonly models: ModelsState; readonly state: unknown };
}

/** v1.5（批A）：新建视图消费的授权根面（get-roots 挂 list 连接；真 WsClient 满足；测试可注入 stub）。 */
export interface RootsSource {
  readonly requestRoots: () => void;
  readonly subscribe: (cb: () => void) => () => void;
  readonly getSnapshot: () => { readonly roots: RootsState };
}

/** 新建视图消费的清单组合面（模型+授权根；单一 getSnapshot 返回完整面——交叉接口会让
 * useSyncExternalStore 只解析到最后一重签名）。 */
export interface NewSessionSource {
  readonly requestModels: () => void;
  readonly requestRoots: () => void;
  readonly subscribe: (cb: () => void) => () => void;
  readonly getSnapshot: () => { readonly models: ModelsState; readonly roots: RootsState; readonly state: unknown };
}

/** 下拉特殊值：不携带 model 域（帧不携键=v1 四字段严格形兼容；pi 用自身默认模型）。 */
const MODEL_DEFAULT = "__default__";

/** M-UX D03：自动 file 名（预填可改）。随机源可注入（测试固定随机源杀例）；默认 CSPRNG 16 字节=hex32（128 位；碰撞概率非零且极低，服务端同名=追加语义，前端不假造冲突不自动换名）。 */
export function autoFile(
  now: () => Date = () => new Date(),
  random: (n: number) => Uint8Array = defaultRandomBytes,
): string {
  const d = now();
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const bytes = random(16);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return `auto-${ts}-${hex}.jsonl`;
}

const LAST_MODEL_KEY = "piagent-last-model";

/** 批3 模型记住上次：读取（仅接受哨兵或过完整 modelPattern 的值——坏值/异源污染丢弃）。 */
export function readLastModel(): string | null {
  try {
    const v = window.localStorage.getItem(LAST_MODEL_KEY);
    if (v === null) return null;
    if (isPersistableModel(v)) return v;
    return null; // 坏值/哨兵样式保留值（__custom__ 等过正则但非用户模型 id）丢弃
  } catch {
    return null; // 无痕模式/禁用存储：静默降级为不记忆
  }
}

/** 批3 模型记忆可持久化口径（P1-03 GPT 批2审）：仅 __default__ 哨兵或「非 __ 前缀且过完整
 * modelPattern」的值——__ 前缀属哨兵样式保留域（未来新哨兵不得经存储面漏入 model 域）。 */
function isPersistableModel(v: string): boolean {
  if (v === MODEL_DEFAULT) return true;
  if (v.startsWith("__")) return false; // 保留样式（如 __custom__）：合法正则也不收
  return LIMITS.modelPattern.test(v);
}

/** 批3 模型记住上次：写入（与读取同过滤口径——非法值零写入）。 */
export function writeLastModel(v: string): void {
  try {
    if (!isPersistableModel(v)) return; // 非法值/哨兵样式保留值零写入
    window.localStorage.setItem(LAST_MODEL_KEY, v);
  } catch {
    // 存储不可用：静默（记忆是增强非依赖）
  }
}

function defaultRandomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}


export function NewSession({
  wsClient,
  writeClient,
  rootsHint,
  onLaunched,
  onCancel,
}: {
  wsClient: NewSessionSource;
  writeClient: WriteClientSurface;
  /** 服务端会话目录提示（真壳传「服务端配置目录」类文案；演示位可自定义）。 */
  rootsHint: string;
  onLaunched: (file: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  // 模型面（P3-1 响应式订阅）：挂载即拉+ws 状态到 ready 时补拉（幂等，ok 后不重发）
  const snap = useSyncExternalStore(wsClient.subscribe, wsClient.getSnapshot);
  const models = snap.models;
  const roots = snap.roots;
  const wsState = snap.state;
  // M-UX D04（v4 定案）模型选择域分离：activeSelection(modelChoice) 与草稿(freeText) 分立。
  // null=默认（帧不携 model 域）；值=过 LIMITS.modelPattern 完整正则的 id（清单拼合值或合法自定义）。
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const [freeText, setFreeText] = useState(""); // 直达草稿（非空=custom 态，优先生效；清空=只清草稿不动 choice）
  // 批3 模型记住上次：挂载恢复（仅过 modelPattern 的合法值或哨兵；坏值丢弃防御）。
  useEffect(() => {
    const saved = readLastModel();
    if (saved === MODEL_DEFAULT) return; // 上次用默认→恢复默认（modelChoice 已是 null）
    if (saved !== null) setModelChoice(saved);
  }, []);

  useEffect(() => {
    wsClient.requestModels();
    wsClient.requestRoots(); // v1.5（批A）：目录选择器数据源（同 models 补拉口径；幂等）
  }, [wsClient, wsState]);
  const [text, setText] = useState("");
  const [notReady, setNotReady] = useState<NotReadyInfo | null>(null);
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // 批3：文件名后台自动（用户不可见）——挂载一次性生成，创建全程稳定。
  const fileRef = useRef<string>(autoFile());
  const file = fileRef.current;

  // D04：草稿优先（custom 态）；空=用已确认选择；均无=默认（不携带 model 域）
  const draftTrim = freeText.trim();
  const inCustom = draftTrim !== "";
  const effectiveModel = inCustom ? draftTrim : modelChoice ?? undefined;

  const fileValid = LIMITS.filePattern.test(file); // autoFile 恒合法（防御：万一非法创建门拦）
  const textValid = text.trim().length > 0;
  const modelValid = effectiveModel === undefined || LIMITS.modelPattern.test(effectiveModel);
  const writeReady = writeClient.getSnapshot().connState === "ready";

  const create = (): void => {
    setLocalError(null);
    if (!fileValid) {
      setLocalError("文件名非法：需形如 xxx.jsonl（字母数字点横杠下划线，≤114 字符）");
      return;
    }
    if (!modelValid) {
      setLocalError("模型标识非法（只收精确 id，非 glob）");
      return;
    }
    setSending(true);
    setNotReady(null);
    writeLastModel(inCustom ? draftTrim : modelChoice === null ? MODEL_DEFAULT : modelChoice); // 批3：记住本次实际用的模型
    writeClient
      .sendPrompt(file, text, effectiveModel, undefined) // 批3：恒服务端默认目录（用户拍板砍选择器）
      .then((outcome) => {
        setSending(false);
        if (outcome.kind === "not-ready") {
          setNotReady({ cause: outcome.cause ?? null, detail: outcome.detail ?? null });
          return;
        }
        if (outcome.kind === "launched") {
          onLaunched(file);
          return;
        }
        setLocalError(`未能启动会话（${outcome.kind}）；请稍后重试`);
      })
      .catch(() => {
        setSending(false);
        setLocalError("发送失败：写连接未就绪或请求被拒，请重试");
      });
  };

  const retry = (): void => {
    setNotReady(null);
    create();
  };
  // D04 select 写入门（持久化过滤）：只接受 __default__ 哨兵或过完整 modelPattern 的值；
  // 显式 select=放弃草稿并确认选择（非 custom 态→更新锚）。
  const selectModel = (v: string): void => {
    if (v !== MODEL_DEFAULT && !LIMITS.modelPattern.test(v)) return; // 纵深防御：畸形值零写入
    setFreeText("");
    setModelChoice(v === MODEL_DEFAULT ? null : v);
  };
  // D04 free-text 编辑：意图门含非法输入与清空；非 custom→custom 转移瞬间锚定当前 choice（后续编辑不覆盖）。
  const editFreeText = (v: string): void => {
    setFreeText(v);
  };
  const switchModel = (): void => {
    setNotReady(null);
    setFreeText(""); // 只清草稿：已确认选择保留（D04 非 custom 态清空=不动 activeSelection）
  };

  return (
    <section className="new-session" aria-label="新建会话">
      <h2>新建会话</h2>
      <p className="roots-hint">新会话将创建在：{rootsHint}</p>
      <label>
        模型（可手打 id；留空=pi 默认）
        <select
          value={inCustom ? draftTrim : (modelChoice ?? MODEL_DEFAULT)}
          onChange={(e) => selectModel(e.target.value)}
          disabled={models.status === "loading"}
          aria-label="模型选择"
        >
          <option value={MODEL_DEFAULT}>默认（pi 配置）</option>
          {inCustom ? (
            <option value={draftTrim}>自定义：{draftTrim}</option>
          ) : null}
          {modelChoice !== null && !inCustom && (models.status !== "ok" || !models.items.some((m: ModelInfoDTO) => `${m.provider}/${m.id}` === modelChoice)) ? (
            <option value={modelChoice}>自定义：{modelChoice}</option>
          ) : null}
          {models.status === "ok" &&
            models.items.map((m: ModelInfoDTO) => {
              const full = `${m.provider}/${m.id}`;
              // D04：清单项校验=完整 modelPattern 正则（非仅长度）；不过→禁选+标不可用
              const usable = LIMITS.modelPattern.test(full);
              return (
                <option key={full} value={full} disabled={!usable}>
                  {m.provider} / {m.id}
                  {m.context !== undefined ? `（${m.context}）` : ""}
                  {usable ? "" : "（不可用）"}
                </option>
              );
            })}
        </select>
      </label>
      <label>
        模型 id 直达（清单失败时仍可手打）
        <input
          type="text"
          value={freeText}
          onChange={(e) => editFreeText(e.target.value)}
          placeholder="如 openai-codex/gpt-5.3"
          aria-label="模型 id 直达"
        />
        <small>{modelValid || freeText.trim() === "" ? "" : "模型标识非法"}</small>
      </label>
      {models.status === "failed" ? (
        <p className="models-failed" role="status">
          模型清单拉取失败（{(models.cause ?? "原因未知").slice(0, 200)}）——可手打模型 id 继续
        </p>
      ) : null}
      <label>
        首条消息
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="对 pi 说的第一句话"
          aria-label="首条消息"
          rows={3}
        />
      </label>
      {localError !== null ? (
        <p className="banner" role="alert">
          {localError}
        </p>
      ) : null}
      {notReady !== null ? (
        <>
          <NotReadyBanner info={notReady} onRetry={retry} onSwitchModel={switchModel} />
          {effectiveModel === undefined ? (
            <p className="models-note" role="note">
              重试将不指定模型；本会话此前绑定的模型设置不会被重置，以服务端实际为准
            </p>
          ) : null}
        </>
      ) : null}
      <div className="new-session-actions">
        <button type="button" onClick={create} disabled={!fileValid || !textValid || !modelValid || !writeReady || sending}>
          {sending ? "创建中…" : "创建会话"}
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </section>
  );
}
