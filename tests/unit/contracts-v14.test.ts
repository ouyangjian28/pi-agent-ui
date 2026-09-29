import { describe, expect, it } from "vitest";
import { validateClientFrame, validateWriteFrame } from "../../packages/protocol/src/contracts";

/** M-OPS 契约批（v1.4）：prompt.model 可选域+get-models 帧（docs/m-ops-design.md §3）。纯校验面；
 * spawn 尾追/sidecar/网关 models-list 分派=后端实现批（此处只锁形状）。 */

describe("M-OPS 契约 v1.4：validateWriteFrame prompt.model", () => {
  const base = { t: "prompt", requestId: "r1", file: "a.jsonl", text: "hi" };

  it("V1 model 合法（provider/id 含 / 与 : 后缀）→过且组装进帧", () => {
    const r = validateWriteFrame({ ...base, model: "openai-codex/gpt-6-astra:medium" });
    expect(r).toMatchObject({ ok: true, frame: { t: "prompt", model: "openai-codex/gpt-6-astra:medium" } });
  });

  it("V2 model 非法（空串/超长/glob 星号）→4404", () => {
    expect(validateWriteFrame({ ...base, model: "" })).toMatchObject({ ok: false, code: 4404 });
    expect(validateWriteFrame({ ...base, model: "x".repeat(129) })).toMatchObject({ ok: false, code: 4404 });
    expect(validateWriteFrame({ ...base, model: "openai-*" })).toMatchObject({ ok: false, code: 4404 });
  });

  it("V3 model+generation 共存→两可选域剥除后四字段等值过+两 extras 组装", () => {
    const r = validateWriteFrame({ ...base, model: "litellm/glm-5.3", generation: 3 });
    expect(r).toMatchObject({ ok: true, frame: { t: "prompt", model: "litellm/glm-5.3", generation: 3 } });
  });

  it("V4 model 缺省→v1 严格原形不变（无 model 键）", () => {
    const r = validateWriteFrame({ ...base });
    expect(r).toMatchObject({ ok: true, frame: { t: "prompt", requestId: "r1", file: "a.jsonl", text: "hi" } });
    if (r.ok) expect("model" in r.frame).toBe(false);
  });
});

describe("M-OPS 契约 v1.4：validateClientFrame get-models", () => {
  it("V5 两字段恰具→过", () => {
    expect(validateClientFrame({ t: "get-models", requestId: "r9" })).toMatchObject({ ok: true, frame: { t: "get-models", requestId: "r9" } });
  });

  it("V6 多余字段→4404（集合等值）", () => {
    expect(validateClientFrame({ t: "get-models", requestId: "r9", file: "a.jsonl" })).toMatchObject({ ok: false, code: 4404 });
  });

  it("V7 requestId 非法→4404", () => {
    expect(validateClientFrame({ t: "get-models", requestId: "坏 id!" })).toMatchObject({ ok: false, code: 4404 });
  });
});
