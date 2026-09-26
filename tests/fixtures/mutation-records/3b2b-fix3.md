# 变异记录：3b2b-fix3 轮（基线 ce50b50）
方法：python 锚点替换（count==1 断言）→定向 vitest→git diff 存 unified patch→git checkout 还原→全仓复验。

## M-F3-01：免扣门失效：free 绑定也消耗 awaitingBind（退回 F3-01 双账本漂移）
- 状态：KILLED
- 失败测试：['× F1-02（fix3 免扣模型）：晚附不消耗装载方引用——B release 结算自己的债；C 重开续流零静默断流 405ms', '× F3-01：晚附后交错结算（B observe + C release）无 carry；后继 D 双源观察+新行直达 3ms', '× F3-02：多注册×多 load——晚附双绑定免扣；C/D release 各结算；当前交付双达+后继周期双源 1ms']
- 结果行：Tests  3 failed | 22 passed (25)

```diff
diff --git a/apps/server/src/runtime/history-source.ts b/apps/server/src/runtime/history-source.ts
index 370c034..8227019 100644
--- a/apps/server/src/runtime/history-source.ts
+++ b/apps/server/src/runtime/history-source.ts
@@ -361,7 +361,7 @@ export class FileHistorySource implements HistorySourcePort {
     // 供 DualHistorySource 晚附用：晚附的观察不消耗任何装载方的待结算引用（谁的 load 谁结算），
     // 从根上消除「绑定顺手烧掉别人的引用再另记账补偿」的双账本漂移（credit 账删除）。
     const free = opts?.consumeLoadRef === false;
-    if (!free && slot.awaitingBind > 0) slot.awaitingBind -= 1;
+    if (slot.awaitingBind > 0) slot.awaitingBind -= 1;
     this.audit(`observed file=${file} awaiting=${slot.awaitingBind}${free ? " free=1" : ""}`);
     if (slot.dirtyPending) {
       slot.dirtyPending = false;
```

## M-F3-02：晚附退回消费模式：绑定顺手烧掉装载方引用（F3-01/F3-02 原路径）
- 状态：KILLED
- 失败测试：['× F1-02（fix3 免扣模型）：晚附不消耗装载方引用——B release 结算自己的债；C 重开续流零静默断流 406ms', '× F3-01：晚附后交错结算（B observe + C release）无 carry；后继 D 双源观察+新行直达 3ms', '× F3-02：多注册×多 load——晚附双绑定免扣；C/D release 各结算；当前交付双达+后继周期双源 1ms']
- 结果行：Tests  3 failed | 22 passed (25)

```diff
diff --git a/apps/server/src/runtime/dual-history-source.ts b/apps/server/src/runtime/dual-history-source.ts
index 41da48f..e54ff59 100644
--- a/apps/server/src/runtime/dual-history-source.ts
+++ b/apps/server/src/runtime/dual-history-source.ts
@@ -194,7 +194,7 @@ export class DualHistorySource implements HistorySourcePort {
     for (const st of regs) {
       if (st.closed || st.sinks === null || st.unS !== null) continue;
       const wrap = wrapSinks(st.sinks);
-      const unS = this.sessionSrc.observe?.(file, wrap, { consumeLoadRef: false }) ?? null;
+      const unS = this.sessionSrc.observe?.(file, wrap) ?? null;
       if (unS !== null) {
         st.unS = unS;
         attached++;
```

## M-F3-03：晚附只绑首个注册（退回部分绑定：F3-02 第二注册永失 session 面）
- 状态：KILLED
- 失败测试：['× F3-02：多注册×多 load——晚附双绑定免扣；C/D release 各结算；当前交付双达+后继周期双源 7ms', '× F3-02b：多注册×单 load——晚附双绑定免扣；C observe 结算唯一引用；无任何 carry 1ms']
- 结果行：Tests  2 failed | 23 passed (25)

```diff
diff --git a/apps/server/src/runtime/dual-history-source.ts b/apps/server/src/runtime/dual-history-source.ts
index 41da48f..4c85884 100644
--- a/apps/server/src/runtime/dual-history-source.ts
+++ b/apps/server/src/runtime/dual-history-source.ts
@@ -198,6 +198,7 @@ export class DualHistorySource implements HistorySourcePort {
       if (unS !== null) {
         st.unS = unS;
         attached++;
+        break;
       }
     }
     if (attached > 0) {
```

## 还原后全仓复验
Tests  734 passed | 7 skipped (741)
