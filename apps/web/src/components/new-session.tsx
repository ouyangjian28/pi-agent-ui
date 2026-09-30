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
  const [freeText, setFreeText] = useState("");
  useEffect(() => {
    wsClient.requestModels();
    wsClient.requestRoots(); // v1.5（批A）：目录选择器数据源（同 models 补拉口径；幂等）
  }, [wsClient, wsState]);
  const [file, setFile] = useState("");
  const [text, setText] = useState("");
  const [notReady, setNotReady] = useState<NotReadyInfo | null>(null);
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [cwdChoice, setCwdChoice] = useState<string | null>(null); // v1.5：null=未显式选择（用默认项）

  // free-text 优先（精确 id 直达）；空=用下拉值；下拉默认=不携带 model 域
  const selected = freeText.trim() !== "" ? freeText.trim() : null;
  const effectiveModel = selected !== null && selected !== MODEL_DEFAULT ? selected : undefined;

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
  const switchModel = (): void => {
    setNotReady(null);
    setFreeText("");
    // 下拉重置由 key 语义承担（重新选择即可）；焦点回 free-text
  };

  return (
    <section className="new-session" aria-label="新建会话">
      <h2>新建会话</h2>
      <p className="roots-hint">新会话将创建在：{rootsHint}</p>
      {roots.status === "loading" || roots.status === "idle" ? (
        <label>
          项目目录（pi 进程工作目录）
          <select disabled aria-label="项目目录" value="">
            <option value="">项目目录清单加载中…</option>
          </select>
          <small>加载完成后可选择；直接创建则使用服务端默认目录</small>
        </label>
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
          项目目录清单拉取失败（{(roots.cause ?? "原因未知").slice(0, 200)}）——将使用服务端默认目录
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
          value={effectiveModel ?? MODEL_DEFAULT}
          onChange={(e) => {
            setFreeText(e.target.value === MODEL_DEFAULT ? "" : e.target.value);
          }}
          disabled={models.status === "loading"}
          aria-label="模型选择"
        >
          <option value={MODEL_DEFAULT}>默认（pi 配置）</option>
          {effectiveModel !== undefined && models.status !== "ok" ? (
            <option value={effectiveModel}>自定义：{effectiveModel}</option>
          ) : null}
          {models.status === "ok" &&
            models.items.map((m: ModelInfoDTO) => (
              <option key={`${m.provider}/${m.id}`} value={m.id}>
                {m.provider} / {m.id}
                {m.context !== undefined ? `（${m.context}）` : ""}
              </option>
            ))}
        </select>
      </label>
      <label>
        模型 id 直达（清单失败时仍可手打）
        <input
          type="text"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
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
        <NotReadyBanner info={notReady} onRetry={retry} onSwitchModel={switchModel} />
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
