// M-OPS（v1.4）新建会话视图：文件名+模型选择+首 prompt 三输入一步建会。
// 首 prompt 成功（write-ack launched）→onLaunched(file) 由壳切正常 SessionDetail；
// 启动失败（not-ready）→响亮红条（重试=重发同 prompt；换模型=清模型选择重选）。
// 模型选择双通道：下拉（get-models 清单；loading/failed 均降级）+free-text 输入（优先生效——
// 清单失败/新模型未入清单仍可手打 id；modelPattern 本地预校验零帧成本）。
import React, { useEffect, useState } from "react";
import { LIMITS } from "@pi-agent-ui/protocol/src/contracts";
import { NotReadyBanner } from "./not-ready-banner";
import type { NotReadyInfo } from "../ws/use-write";
import type { ModelInfoDTO } from "@pi-agent-ui/protocol/src/contracts";
import type { WriteClientSurface } from "../ws/write-client";
import type { ModelsState } from "../ws/ws-client";

/** 新建视图消费的清单面（最小接口：真 WsClient 满足；测试可注入 stub）。 */
export interface ModelsSource {
  readonly requestModels: () => void;
  readonly getSnapshot: () => { readonly models: ModelsState };
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
  wsClient: ModelsSource;
  writeClient: WriteClientSurface;
  /** 服务端会话目录提示（真壳传「服务端配置目录」类文案；演示位可自定义）。 */
  rootsHint: string;
  onLaunched: (file: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  // 模型面：挂载即拉清单（幂等）；下拉+free-text 双通道
  const models = wsClient.getSnapshot().models;
  const [freeText, setFreeText] = useState("");
  useEffect(() => {
    wsClient.requestModels();
  }, [wsClient]);
  const [file, setFile] = useState("");
  const [text, setText] = useState("");
  const [notReady, setNotReady] = useState<NotReadyInfo | null>(null);
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // free-text 优先（精确 id 直达）；空=用下拉值；下拉默认=不携带 model 域
  const selected = freeText.trim() !== "" ? freeText.trim() : null;
  const effectiveModel = selected !== null && selected !== MODEL_DEFAULT ? selected : undefined;

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
      .sendPrompt(file, text, effectiveModel)
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
          模型清单拉取失败（{models.cause ?? "原因未知"}）——可手打模型 id 继续
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
