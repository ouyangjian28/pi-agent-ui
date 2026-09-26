# 变异记录：3b-3④ 预算容量（基线 40aee70）

## M-B1：触顶边界 off-by-one（恰 20,000 误判越界）→BG2 挂
- 状态：KILLED
- 失败：['× BG2 恰在预算内（20,000）不触顶：双源 19,997+3=20,000 恰好放行，快照正常 8046ms', '× BG5 内存峰值披露（非生产 RSS 断言）：20k 流+32 流池满载下 heapUsed<384MiB 快照记录 8046ms', 'FAIL  |integration| tests/integration/real-fs-budget.test.ts > 3b-3④ 预算容量（真盘体量；组合层无合计门——单文件/单流/流池三门） > BG2 恰在预算内（20,000）不触顶：双源 19,997+3=20,000 恰好放行，快照正常', 'FAIL  |integration| tests/integration/real-fs-budget.test.ts > 3b-3④ 预算容量（真盘体量；组合层无合计门——单文件/单流/流池三门） > BG5 内存峰值披露（非生产 RSS 断言）：20k 流+32 流池满载下 heapUsed<384MiB 快照记录']
- 结果行：Tests  2 failed | 3 passed (5)

```diff
diff --git a/packages/protocol/src/read-index.ts b/packages/protocol/src/read-index.ts
index d008872..389f111 100644
--- a/packages/protocol/src/read-index.ts
+++ b/packages/protocol/src/read-index.ts
@@ -121,7 +121,7 @@ export class ReadIndex {
   }
 
   /** 预算内事件上限（超限=该流废弃，下次 get 重扫换流；出口有限，无内部循环）。 */
-  get overBudget(): boolean { return this.events.length > this.limits.maxEventsPerStream; }
+  get overBudget(): boolean { return this.events.length >= this.limits.maxEventsPerStream; }
 }
 
 export interface ReadIndexRegistryLimits {
```

## M-B2：LRU 淘汰去（流池无界）→BG4 挂
- 状态：KILLED
- 失败：['× BG4 流池 LRU 32：33 文件装载挤出最旧→旧文件重订=新 streamId（流身份丢失）；当前流数不超 32 1044ms', 'FAIL  |integration| tests/integration/real-fs-budget.test.ts > 3b-3④ 预算容量（真盘体量；组合层无合计门——单文件/单流/流池三门） > BG4 流池 LRU 32：33 文件装载挤出最旧→旧文件重订=新 streamId（流身份丢失）；当前流数不超 32']
- 结果行：Tests  1 failed | 4 passed (5)

```diff
diff --git a/packages/protocol/src/read-index.ts b/packages/protocol/src/read-index.ts
index d008872..a8e8517 100644
--- a/packages/protocol/src/read-index.ts
+++ b/packages/protocol/src/read-index.ts
@@ -192,7 +192,7 @@ export class ReadIndexRegistry {
   get size(): number { return this.map.size; }
 
   private evictIfNeeded(): void {
-    while (this.map.size > this.limits.maxStreams) {
+    while (false) {
       const oldest = this.map.keys().next().value as string | undefined;
       if (oldest === undefined) break; // 有限出口
       const evicted = this.map.get(oldest);
```

## M-B3：每文件扫描预算上限绕过→BG3 挂
- 状态：KILLED
- 失败：['× BG3 每文件扫描预算 8MiB：9MiB journal→4402（scan-over-budget，retryable=true） 8079ms', 'FAIL  |integration| tests/integration/real-fs-budget.test.ts > 3b-3④ 预算容量（真盘体量；组合层无合计门——单文件/单流/流池三门） > BG3 每文件扫描预算 8MiB：9MiB journal→4402（scan-over-budget，retryable=true）']
- 结果行：Tests  1 failed | 4 passed (5)

```diff
diff --git a/apps/server/src/runtime/history-source.ts b/apps/server/src/runtime/history-source.ts
index 02223e7..e88b76a 100644
--- a/apps/server/src/runtime/history-source.ts
+++ b/apps/server/src/runtime/history-source.ts
@@ -67,7 +67,7 @@ export class RealReader implements HistoryReaderPort {
   async read(absPath: string): Promise<{ text: string; identity: string; fingerprint: string }> {
     const { fh } = await openSafeFile(absPath);
     try {
-      const [buf, st] = await Promise.all([readBounded(fh, this.maxBytes, absPath), fh.stat()]);
+      const [buf, st] = await Promise.all([readBounded(fh, Number.MAX_SAFE_INTEGER, absPath), fh.stat()]);
       // 3b2c-F1-05/F2-03：合法性判据=字节级（非字符值）——完整前缀（末 \n 前）用 fatal UTF-8
       // 解码：非法编码（0xff/0xfe/断裂多字节）拒；合法字符值（含真实用户输入的 U+FFFD=EF BF BD）
       // 放行（旧判据「完整行含 U+FFFD 即拒」会误杀含该合法字符的整文件）。撕裂尾（末段无 \n）
```

## 还原后全仓复验
Tests  767 passed | 7 skipped (774)
