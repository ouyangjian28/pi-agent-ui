# 3b3-fix8 变异验证档（GPT fix7 复审 84/100 NO-GO 修复轮；2026-10-02）

基线（fix8 终态）：packages/protocol/src/subscription-engine.ts sha256=c25d08158114ea5e71d6813274af778e56a240aa2e3e9be0ecd8e8e45b7be4a1；apps/server/src/runtime/history-source.ts sha256=cc084943ef833fd9f317231c97ab8098c79f87f4720ea5f55da1a408eab41e8b（同 fix7）；apps/server/src/runtime/dual-history-source.ts sha256=892d3c1c2b696cfd43aadb3a79d6d67efb61237a476722206997521ecf1ae871（同 fix7）。全套 44 files 826 passed + 7 skipped（JSON=tests/fixtures/run-records/3b3-fix8-vitest.json）；根 tsc exit0；lint exit0。

本轮变异纪律（GPT fix7 F8-2）：全部给**真实 unified diff**（非自然语言摘要）、失败断言原文、退出码、还原哈希；窄变异只删本轮新增的门；跨轮重演标注基线归属。

## M-F8-COMMIT servePageFrom 提交尾终检删除（F8-1 / GPT fix7 P9/P10）

- diff（packages/protocol/src/subscription-engine.ts，基线 c25d0815…；全量 unified diff=**tests/fixtures/mutation-records/patches/fix8/m-f8-commit.diff**——fix9 入仓勘正：原 /tmp 文件无 diff 头，此为同一变异在 fix8 提交态 47d1a3c 上重建的带文件头版本）：
  ```diff
  -    const pageAt = this.d.now();
  -    if ((this.phase as string) === "closed") return err4404(requestId);
  +    const pageAt = this.d.now(); // MUTATION M-F8-COMMIT: 终检删除
  ```
- 命令（独立跑，单变异）：
  - `npx vitest run tests/unit/subscription-engine.test.ts -t "F8/P-PAGE-EST-EVENT"` → exit 1，AssertionError: `expected { t: 'snapshot', …(10) } to match object { t: 'error', code: 4404, …(1) }`（估算窗关引擎后退役页照发；fix10 勘正：此处是 estimateEvent 填装窗，非时钟窗）。
  - `-t "F8/P-PAGE-NONFINAL"` → exit 1，同型断言（done-else 分支复活 closed 引擎）。
  - `-t "F8/P-PAGE-NOW-ENGINE"` → exit 1，同型断言（GPT fix7 P10 引擎序列：装页/终判毕→lastPageAt=now() 窗失效）。
  - `-t "F8/P-PAGE-NOW"`（ws-gateway 整合例）→ **exit 0 合法存活**：该例 arm 在网关入站帧时钟（st.lastFrameAt，ws-gateway.ts:321；fix10 勘正：原记 :408 有误，:408=认证失败记账）早触发→invalidate 先删 sub→续页请求落到「请求与订阅状态不符」网关级 4404——真实系统防线，但**非引擎提交点杀伤**；引擎提交点杀伤由 P-PAGE-NOW-ENGINE 承担，真提交点整合例=fix9 F9/P-PAGE-NOW-COMMIT。
- 还原：`cp /tmp/f8-base-se.ts` → sha256 回 c25d0815…（同值）。

## M-F8-H1 + M-F8-CACHED + M-F8-GRACE 三口联合删除（F8-1 / GPT fix7 P8/P11/P10）

- 联合跑理由：三口各属不同分支（H+1/缓存重发/宽限窗），互不重叠；各自探针只触自己的分支。
- diff（节选；全量=**tests/fixtures/mutation-records/patches/fix8/m-f8-h1-cached-grace.diff**（原 /tmp 文件已入仓））：
  ```diff
         const graceNow = this.d.now();
  -      if ((this.phase as string) === "closed") return [err4404(req.requestId)];
  +      void 0; // MUTATION M-F8-GRACE: 宽限窗终检删除
  ```
  ```diff
  -      if ((this.phase as string) === "closed") return [err4404(req.requestId)];
  +      void 0; // MUTATION M-F8-CACHED: 缓存重发终检删除
  ```
  ```diff
  -        if ((this.phase as string) === "closed") return [err4404(req.requestId)];
  +        void 0; // MUTATION M-F8-H1: H+1 终检删除
  ```
- 命令与失败断言：
  - `-t "F8/P-H1-EST"` → exit 1，AssertionError: `expected { t: 'snapshot', … } to match { t: 'error', code: 4404, … }`（退役空页漏出+rememberPage 落账）。
  - `-t "F8/P-CACHED-EST"` → exit 1，同型（退役缓存页返回）。
  - `-t "F8/P-GRACE-NOW"` → exit 1，AssertionError: `expected { t: 'error', code: 4409, … } to match { t: 'error', code: 4404, … }`（宽限检查内关引擎后流程落入「游标与本快照进度不符」4409——close 清 recentPages→缓存失配；旧归因按实记）。
- 还原：cp 基线副本 → sha256 回 c25d0815…（同值）。

## 跨轮重演（fix7 三变异在 fix8 基线上复跑；GPT fix7 F8-2）

> 原始 fix7 档为自然语言摘要（当时 /tmp 日志已无，不重建当时记录）；以下为 **fix8 基线上的新复跑**（2026-10-02），真实 diff+退出码+还原哈希落本档；fix7 档已加指针节。

- **M-F7-1 重演**（history-source.ts cc084943…）：deliverTerminal try/finally 回退为旧尾清。KILLED：`-t "F7/P-TERM-RETAIN"` → exit 1，AssertionError: `expected Set{ { …(5) }, { …(5) }, { …(5) } } to be null`（源级提前 return 出口滞留旧 sinks 面）。diff=patches/fix8/replay-m-f7-1.diff；还原 sha256 同值。
- **M-F7-WRAP 重演**（dual-history-source.ts 892d3c1c…）：wrapSinks ok() 门全删。KILLED：`-t "F7/P-LATE-WATCH-FAIL"` → exit 1，AssertionError: `expected [ 'watch-failed' ] to have a length of +0 but got 1`（已收口注册漏收终止回调）。diff=patches/fix8/replay-m-f7-wrap.diff；还原 sha256 同值。
- **M-F7-PAGE 重演（窄）**（subscription-engine.ts c25d0815…）：两处 F7-3 冻结复核删除。**合法 SURVIVED（fix8 新结论）**：`P-PAGE-REENTRY`/`P-H1-FREEZE` 均 exit 0——F8-1 提交尾/H+1 终检在同窗内纵深拦截（closed 同样返 4404，可观测行为等价）。fix7 档「双杀」结论属 fix7 基线（彼时无 F8 终检）；fix8 基线上独立杀伤归因移交 M-F8-COMMIT/H1。
- **复合变异 M-F7-PAGE+M-F8-COMMIT/H1**（同删四口）：KILLED 双探针——`P-PAGE-REENTRY`/`P-H1-FREEZE` 均 exit 1，AssertionError: `expected 2 to be 1`。diff=patches/fix8/replay-m-page-f8compound.diff；还原 sha256 回 c25d0815…（同值）。
  - **fix9 勘正（GPT fix8 复审 P16 采纳）**：旧注「4404 计数=引擎拒帧+网关退役链各一」归因错误。fix9 在 fix9 基线上重验复合变异（见 3b3-fix9.md）：首败断言为**快照计数** `expect(c.frames().filter((f)=>f.t==="snapshot").length).toBe(1)`（ws-gateway.test.ts:2880/P-PAGE-REENTRY、:2920/P-H1-FREEZE）——引擎拒门已删后退役旧快照排在 4409 后，不存在两份 4404 的路径；当时仅凭 `expected 2 to be 1` 一行推断归因不成立。另：同一四口复合在 fix9 基线上已杀不动（F9-1 预算口先验纵深覆盖），需六口复合同删才重现，防御层叠加如实记录。

## 汇总

| 变异 | 目标面 | 杀手 | 退出码 | 还原后 |
|---|---|---|---|---|
| M-F8-COMMIT | servePageFrom 提交尾终检 | P-PAGE-EST-EVENT / P-PAGE-NONFINAL / P-PAGE-NOW-ENGINE | 1×3 KILLED | 过（sha256 同值） |
| M-F8-H1 | H+1 终检 | P-H1-EST | 1 KILLED | 过 |
| M-F8-CACHED | 缓存重发终检 | P-CACHED-EST | 1 KILLED | 过 |
| M-F8-GRACE | 宽限窗终检 | P-GRACE-NOW | 1 KILLED | 过 |
| M-F7-1 重演 | fix7 终止分发 finally | F7/P-TERM-RETAIN | 1 KILLED | 过（同值） |
| M-F7-WRAP 重演 | fix7 wrap 门 | F7/P-LATE-WATCH-FAIL | 1 KILLED | 过（同值） |
| M-F7-PAGE 重演（窄） | fix7 冻结复核 | —（F8-1 纵深覆盖） | 0 合法 SURVIVED | 过 |
| 复合 M-F7-PAGE+F8 | 四口同删 | P-PAGE-REENTRY + P-H1-FREEZE | 1+1 KILLED | 过（同值） |

过程事故如实记：首轮 M-F7-1 重演的 python 手术锚错块（命中 readLine 的 try）→tsc 立即报错、测试 zero——未产任何「假杀/假活」结论；换精确文本锚后重跑。全套机器产物曾有一次在变异态下生成（M-F7-PAGE 未还原时），**发现后已在干净基线重新生成并覆盖**（tests/fixtures/run-records/3b3-fix8-vitest.json 以 c25d0815 干净树为准）。
