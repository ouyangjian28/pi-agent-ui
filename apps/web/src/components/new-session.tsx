// M-OPS（v1.4）新建会话视图：文件名+模型选择+首 prompt 三输入一步建会。
// 首 prompt 成功（write-ack launched）→onLaunched(file) 由壳切正常 SessionDetail；
// 启动失败（not-ready）→响亮红条（重试=重发同 prompt；换模型=清模型选择重选）。
// 模型选择双通道：下拉（get-models 清单；loading/failed 均降级）+free-text 输入（优先生效——
// 清单失败/新模型未入清单仍可手打 id；modelPattern 本地预校验零帧成本）。
import React, { useEffect, useState, useSyncExternalStore } from "react";
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
  const [userTouchedModel, setUserTouchedModel] = useState(false); // 意图门：任何编辑（含非法输入/清空）即置 true
  const [lastNonCustom, setLastNonCustom] = useState<string | null>(null); // 非 custom→custom 转移瞬间锚（custom 内编辑不覆盖）
  // M-UX D03：自动 file 名（预填可改）——auto-YYYYMMDD-HHmmss-<hex32>.jsonl，
  // 尾缀=16 字节 CSPRNG（128 位；碰撞概率非零且极低，服务端同名=追加语义，前端不假造冲突）。
  const [file, setFile] = useState(() => autoFile());
  useEffect(() => {
    wsClient.requestModels();
    wsClient.requestRoots(); // v1.5（批A）：目录选择器数据源（同 models 补拉口径；幂等）
  }, [wsClient, wsState]);
  const [text, setText] = useState("");
  const [notReady, setNotReady] = useState<NotReadyInfo | null>(null);
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [cwdChoice, setCwdChoice] = useState<string | null>(null); // v1.5：null=未显式选择（用默认项）
  // M-UX 批2 D05：挂载级总截止（页面等待域）——10s 到点 roots 仍非 ok/failed→本地 failed 出口
  //（默认目录常驻可创建；覆盖从未发请求的 idle/无 welcome 场景）。
  // 分域：数据域=WsClient roots 快照（迟到回包照常入账）；页面等待域=本 timer，
  // fire 时核验当前快照 status——已 ok/failed 则零动作（请求成功不被剩余总 timer 打回 failed）。
  const [rootsDeadline, setRootsDeadline] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      setRootsDeadline((prev) => (prev ? prev : true));
    }, 10_000);
    return () => clearTimeout(t);
  }, []);
  // 页面等待域派生（纯读快照）：到点仍 loading/idle→超时出口；ok/failed 终态优先（成功不被打回）。
  const rootsTimedOut = rootsDeadline && (roots.status === "loading" || roots.status === "idle");
  const rootsCauseText = roots.status === "failed" ? (roots.cause ?? "原因未知") : "拉取超时（10s）";

  // D04：草稿优先（custom 态）；空=用已确认选择；均无=默认（不携带 model 域）
  const draftTrim = freeText.trim();
  const inCustom = draftTrim !== "";
  const effectiveModel = inCustom ? draftTrim : modelChoice ?? undefined;

  // v1.5（批A）目录选择器：首项=会话记录树（契约定性「非 cwd 候选」）不入选项；
  // 默认选中=候选首项（即 roots 第二项）；无候选→不渲染选择器、不携 cwd（服务端默认目录兜底）。
  // v1.6（批A-r2）：服务端下发 journalRoot 时改用它过滤（精确排除 journal 控制树 D **及其子树**——
  // 双树布局下 roots=[T(=D/pi),D,项目根…]，slice(1) 会把 D 留在候选里诱导误选；T 在 D 内也被
  // 一并排除——journal/转录两树都是服务内部结构，非 cwd 候选）；
  // 无 journalRoot（旧服务端/rig）=slice(1) 旧语义兼容。
  // P3-R2-03：D="/" 根边缘——jr+"/" 会拼出 "//" 失效；D="/" 时一切绝对路径均在 D 内
  // （前缀="/"）＝全排除，候选空→不携 cwd 降级（不携 cwd 即可，无需拒绝该布局）。
  const jr = roots.journalRoot ?? null;
  const cwdOptions = roots.status !== "ok" || jr === null
    ? roots.status === "ok" ? roots.items.slice(1) : []
    : roots.items.filter((r) => r !== jr && !r.startsWith(jr === "/" ? "/" : jr + "/"));
  const effectiveCwd =
    cwdOptions.length === 0 ? undefined : cwdChoice !== null && cwdOptions.includes(cwdChoice) ? cwdChoice : cwdOptions[0];

  const fileValid = LIMITS.filePattern.test(file);
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
    writeClient
      .sendPrompt(file, text, effectiveModel, effectiveCwd)
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
    setUserTouchedModel(true);
    if (v !== MODEL_DEFAULT && !LIMITS.modelPattern.test(v)) return; // 纵深防御：畸形值零写入
    setFreeText("");
    setModelChoice(v === MODEL_DEFAULT ? null : v);
    setLastNonCustom(v === MODEL_DEFAULT ? null : v);
  };
  // D04 free-text 编辑：意图门含非法输入与清空；非 custom→custom 转移瞬间锚定当前 choice（后续编辑不覆盖）。
  const editFreeText = (v: string): void => {
    setUserTouchedModel(true);
    if (v.trim() !== "" && freeText.trim() === "") setLastNonCustom(modelChoice);
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
      {(roots.status === "loading" || roots.status === "idle") && !rootsTimedOut ? (
        <label>
          项目目录（pi 进程工作目录）
          <select disabled aria-label="项目目录" value="">
            <option value="">项目目录清单加载中…</option>
          </select>
          <small>加载完成后可选择；直接创建则使用服务端默认目录</small>
        </label>
      ) : null}
      {rootsTimedOut ? (
        <p className="cwd-status" role="status">
          项目目录清单拉取超时（10s）——将使用服务端默认目录，可直接创建
        </p>
      ) : null}
      {roots.status === "ok" && cwdOptions.length > 0 ? (
        <label>
          项目目录（pi 进程工作目录）
          <select
            value={effectiveCwd}
            onChange={(e) => setCwdChoice(e.target.value)}
            aria-label="项目目录"
          >
            {cwdOptions.map((root) => (
              <option key={root} value={root}>
                {root}
              </option>
            ))}
          </select>
          <small>会话记录树不参与选择；仅首次创建生效，会话寿命内固定</small>
        </label>
      ) : null}
      {roots.status === "failed" ? (
        <p className="cwd-status" role="status">
          项目目录清单拉取失败（{rootsCauseText.slice(0, 200)}）——将使用服务端默认目录
        </p>
      ) : null}
      {roots.status === "ok" && cwdOptions.length === 0 ? (
        <p className="cwd-status" role="status">
          服务端仅配置了会话记录树——pi 将在默认目录运行
        </p>
      ) : null}
      <label>
        会话文件名
        <input
          type="text"
          value={file}
          onChange={(e) => setFile(e.target.value)}
          placeholder="如 plan-daily.jsonl"
          aria-label="会话文件名"
        />
        <small>{fileValid || file === "" ? "" : "需形如 xxx.jsonl"}</small>
      </label>
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
