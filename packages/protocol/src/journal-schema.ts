// 3b2a-R5（GPT 3b2a 审读）：journal 行 schema 校验唯一权威（纯逻辑，protocol 层共享）。
// 背景：读侧投影（history-projection）与恢复（recover）必须共用同一套判定——
// 「JSON 可解析≠合法 JournalLine」：缺字段/错类型/未知行型/嵌套结构非法一律判坏，
// 不得凭 TS 强转信任盘面。抽出前恢复侧已有此实现（s4e R2+s4f F2），投影侧另造宽松解析器
// 被 3b2a 审读击穿（P1/P1b：坏嵌套抛 TypeError/非法字段流入事件）——现统一于此。
// 校验语义与既有恢复侧逐字一致（迁移而非新设计）；s4g 裁量②口径保留：
// generation/commandId=安全整数且≥1；ordinal=安全整数且≥0。

export type UnknownRecord = Record<string, unknown>;

/** 意图 kind 白名单（enqueue.payload.kind）。 */
export const INTENT_KINDS: readonly string[] = [
  "prompt",
  "steer",
  "followUp",
  "abort",
  "takeover",
  "reclaim",
  "switchSession",
  "queueOp",
];

/**
 * 行型 schema 校验：返回 null=合法；非 null=人话错误描述（判坏依据）。
 * 输入须已满足：JSON.parse 成功、非 null、typeof object、t 为 string（调用方前置判定）。
 */
export function journalLineSchemaError(obj: UnknownRecord): string | null {
  const t = obj["t"];
  const str = (k: string): string | null => (typeof obj[k] === "string" ? null : `缺字段/错类型 ${k}`);
  // s4g 裁量②收紧：generation/commandId=安全整数且≥1（生产端只写正整数序号，输入面同步收紧）；
  // ordinal=安全整数且≥0（0 基非负）。
  const finiteNum = (k: string): string | null =>
    typeof obj[k] === "number" && Number.isSafeInteger(obj[k] as number) && (obj[k] as number) >= 1
      ? null
      : `缺字段/错类型 ${k}`;
  const nestedStr = (o: unknown, k: string, label: string): string | null => {
    if (o === null || typeof o !== "object" || Array.isArray(o)) return `嵌套非法 ${label}`;
    return typeof (o as UnknownRecord)[k] === "string" ? null : `嵌套非法 ${label}.${k}`;
  };
  switch (t) {
    case "enqueue": {
      for (const k of ["intentId", "sessionId", "leafId"] as const) if (str(k)) return str(k);
      if (finiteNum("generation")) return finiteNum("generation");
      const mk = obj["matchKey"];
      if (mk === null || typeof mk !== "object" || Array.isArray(mk)) return "嵌套非法 matchKey";
      if (nestedStr(mk, "textHash", "matchKey.textHash")) return nestedStr(mk, "textHash", "matchKey.textHash");
      if (nestedStr(mk, "attachmentIdentity", "matchKey.attachmentIdentity"))
        return nestedStr(mk, "attachmentIdentity", "matchKey.attachmentIdentity");
      if (
        typeof (mk as UnknownRecord)["ordinal"] !== "number" ||
        !Number.isSafeInteger((mk as UnknownRecord)["ordinal"] as number) ||
        ((mk as UnknownRecord)["ordinal"] as number) < 0
      )
        return "嵌套非法 matchKey.ordinal";
      const p = obj["payload"];
      if (p === null || typeof p !== "object" || Array.isArray(p)) return "嵌套非法 payload";
      const pr = p as UnknownRecord;
      if (typeof pr["kind"] !== "string" || !INTENT_KINDS.includes(pr["kind"])) return "嵌套非法 payload.kind";
      if (typeof pr["rawText"] !== "string") return "嵌套非法 payload.rawText";
      if (!Array.isArray(pr["attachments"]) || !pr["attachments"].every((a) => typeof a === "string"))
        return "嵌套非法 payload.attachments";
      if (typeof pr["sentAt"] !== "string") return "嵌套非法 payload.sentAt";
      return null;
    }
    case "sending":
    case "engaged":
    case "cancelled":
    case "delivered":
    case "settled":
      return str("intentId");
    case "consumed": {
      const head = str("intentId") ?? str("anchorEntryId");
      if (head) return head;
      const ie = obj["intervalEnd"];
      if (ie === null || typeof ie !== "object" || Array.isArray(ie)) return "嵌套非法 intervalEnd";
      if (nestedStr(ie, "entryId", "intervalEnd.entryId")) return nestedStr(ie, "entryId", "intervalEnd.entryId");
      if (nestedStr(ie, "lengthHash", "intervalEnd.lengthHash")) return nestedStr(ie, "lengthHash", "intervalEnd.lengthHash");
      return null;
    }
    case "clear": {
      const head = str("sessionId");
      if (head) return head;
      const c = obj["cleared"];
      if (!Array.isArray(c)) return "缺字段/错类型 cleared"; // 缺失/非数组=外层字段错（R2 口径）
      if (!c.every((x) => typeof x === "string")) return "嵌套非法 cleared（元素须字符串）";
      return null;
    }
    case "unknown":
      return str("intentId") ?? str("reason");
    case "response-timeout":
      return str("intentId") ?? finiteNum("generation") ?? finiteNum("commandId");
    default:
      return `未知行型 ${String(t)}`;
  }
}
