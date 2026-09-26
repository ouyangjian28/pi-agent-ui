# 3b3-fix6 变异记录（GPT fix5 复审 83→修复轮；2026-10-01）

标准（同 3b3-fix4/3b3-fix5.md）：真实 diff + 复现命令 + 退出码 + 还原校验。
基线：本轮工作树（F6-1/F6-3 修复+探针在场）。

## M-F6-TERM deliverTerminal 成员资格门移除（F6-1 HS 面）

- 目标：证明终止通知投递的成员资格复核（P11/P12：回调内 dispose 后继停/回调内退订他人跳过）是必要防线。
- 变异基线：apps/server/src/runtime/history-source.ts sha256=4d84f1acd5f445bd67bfd33a6867374de7aa255ddf60e7e0d89d53fe4552510c。
- diff（一处锚点——循环内成员资格检查删除，源级 srcDisposed 整批停保留）：
  ```diff
         if (this.srcDisposed) return; // 源级终态：dispose 之后不再开始后继宿主回调
   -     const cur = entry.sinks;
   -     if (cur === null || !cur.has(sk)) continue; // 注册已被回调内撤销：跳过该注册
   +     // MUTATION M-F6-TERM: 成员资格门移除（cur/has 检查跳过）
         try {
  ```
- 命令：`npx vitest run tests/unit/server/history-source.test.ts tests/unit/server/dual-history-source.test.ts -t "F6/"`
- 结果：exit 1，KILLED（1 failed：F6/P-TERM-UNBIND——A 回调内退订 C 后 C 仍收终止通知；P-TERM-DISPOSE/P-TERM-DISPOSE-UNAVAIL 由 srcDisposed 整批停覆盖合法存活=语义分层）。
- 还原：`cp /tmp/mut-f6a.bak apps/server/src/runtime/history-source.ts`；还原校验=sha256 同值 4d84f1acd5f445bd…510c。

## M-F6-WRAP wrapSinks ok() 资格门移除（F6-1 DUAL 面）——合法存活

- 目标：证明 Dual 层 wrapSinks 的 `ok()=！st.closed && st.sinks!==null && alive()` 转发门是必要防线。
- 变异基线：apps/server/src/runtime/dual-history-source.ts sha256=892d3c1c2b696cfd43aadb3a79d6d67efb61237a476722206997521ecf1ae871。
- diff（五方法转发去掉 ok() 前置）：
  ```diff
   -     onAppend: (row) => { if (ok()) host.onAppend(row); },
   +     onAppend: (row) => { host.onAppend(row); }, // MUTATION M-F6-WRAP: ok() 门移除
   -     ...(host.onInvalidate !== undefined ? { onInvalidate: (r) => { if (ok()) host.onInvalidate?.(r); } } : {}),
   +     ...(host.onInvalidate !== undefined ? { onInvalidate: (r) => { host.onInvalidate?.(r); } } : {}),
   -     ...(host.onUnavailable !== undefined ? { onUnavailable: (r) => { if (ok()) host.onUnavailable?.(r); } } : {}),
   +     ...(host.onUnavailable !== undefined ? { onUnavailable: (r) => { host.onUnavailable?.(r); } } : {}),
   -     onLive: (ev) => { if (ok()) host.onLive(ev); },
   +     onLive: (ev) => { host.onLive(ev); },
   -     onStatus: (s) => { if (ok()) host.onStatus(s); },
   +     onStatus: (s) => { host.onStatus(s); },
  ```
- 命令：`npx vitest run tests/unit/server/dual-history-source.test.ts -t "F6/"`
- 结果：exit 0，**SURVIVED（合法，纵深防御层）**——归因：closeObsState 撤销时先调 unJ/unS 把 wrap 从两子源 entry.sinks 删除，后续投递被 M-F6-TERM 面的成员资格门拦截；子源 dispose 后 srcDisposed 整批停兜底。故 wrap 门在当前可达路径上无独占杀伤面，属**纵深防御**（防未来重构中子源绑定回收缺口）。如实入档：不为「杀」而造测试。
- 还原：`cp /tmp/mut-f6b.bak apps/server/src/runtime/dual-history-source.ts`；还原校验=sha256 同值 892d3c1c2b696cfd…e871。

## M-F6-FREEZE freezeStatus 冻结移除（F6-3 P6 序列化重入边界）

- 目标：证明资格门冻结（宿主 status getter/toJSON 一次性求值）是序列化重入边界（GPT fix5 P6：宿主行为可在 enqueue 的 JSON.stringify 重入 invalidate→撤帧找不到未入队快照）的必要防线。
- 变异基线：packages/protocol/src/subscription-engine.ts sha256=1e0b31f47d0884dfc0da4a795a633d1e1019651c8894496f5793aabc7201c287。
- diff（一处锚点）：
  ```diff
   -    const status = freezeStatus(this.d.status());
   +    const status = this.d.status(); // MUTATION M-F6-FREEZE: 冻结移除
  ```
- 命令：`npx vitest run tests/unit/server/ws-gateway.test.ts -t "F6/P-SERIAL"`
- 结果：exit 1，KILLED（1 failed：宿主求值计数 2≠1——页预算实测+入队序列化再触宿主；冻结在场时恰一次往返（toJSON×1，getter 不再被求值）且下游任意次序列化计数不增+帧内纯数据）。
- 还原：`cp /tmp/mut-f6c.bak packages/protocol/src/subscription-engine.ts`；还原校验=sha256 同值 1e0b31f47d0884df…1c287。

## 汇总

| 变异 | 目标面 | 杀手 | 退出码 | 还原后 |
|---|---|---|---|---|
| M-F6-TERM | F6-1 HS 终止通知成员资格门 | F6/P-TERM-UNBIND | 1 KILLED | 过（sha256 同值） |
| M-F6-WRAP | F6-1 DUAL wrap 转发门 | ——（纵深防御层，子源门全量覆盖可达路径） | 0 SURVIVED（合法） | 基线 |
| M-F6-FREEZE | F6-3 status 纯数据化 | F6/P-SERIAL-REENTRY | 1 KILLED | 过（sha256 同值） |

还原校验：三个 .bak 均以 sha256 同值回基线；全套终态见 TEST-MAP 3b3-fix6 节。
