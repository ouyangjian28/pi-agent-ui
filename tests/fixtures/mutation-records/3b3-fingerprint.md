# 变异记录：3b-3⑤ 指纹轮（基线 f6c7912）

## M-FP-1：指纹短路门失效（每次 notice 都全量重扫——skip 审计消失）
- 状态：KILLED
- 失败测试：['× 同内容同身份 notice→fingerprint-skip：无 append 无 invalidate（幂等重扫静默） 26ms', '× 同字节换 inode→fingerprint-skip-identity-change（不失效）；后续新 inode 上真追加仍达 402ms', '× 内容增长→正常 append+指纹跟进；随后同内容 notice→fingerprint-skip 403ms', '× 真盘 rename 覆盖同字节（真新 inode）→无 invalidate；随后真追加正常（RealReader+RealWatcher 冒烟） 403ms']
- 结果行：Tests  4 failed | 58 passed (62)

```diff
diff --git a/apps/server/src/runtime/history-source.ts b/apps/server/src/runtime/history-source.ts
index 02223e7..75a0da5 100644
--- a/apps/server/src/runtime/history-source.ts
+++ b/apps/server/src/runtime/history-source.ts
@@ -508,7 +508,7 @@ export class FileHistorySource implements HistorySourcePort {
     }
     if (entry.disposed || entry.state !== "active" || slot.entry !== entry) return; // 读期间失效/换代：丢弃（await 后复核）
     // 3b-3⑤ 指纹短路（契约 §1.3）：同指纹=整文件字节未变——无论 inode 是否更换（同字节换 inode=短路，观察一致面不换流）
-    if (read.fingerprint === entry.fingerprint) {
+    if (false) {
       if (read.identity !== entry.identity) {
         entry.identity = read.identity; // 后续追加/换代判据跟到新 inode
         this.audit(`fingerprint-skip-identity-change file=${entry.file} why=${why}`);
```

## M-FP-2：跳过时不跟进 identity→新 inode 上后续追加被误判 replace（短路自陷）
- 状态：KILLED
- 失败测试：['× 同字节换 inode→fingerprint-skip-identity-change（不失效）；后续新 inode 上真追加仍达 407ms', '× 真盘 rename 覆盖同字节（真新 inode）→无 invalidate；随后真追加正常（RealReader+RealWatcher 冒烟） 405ms']
- 结果行：Tests  2 failed | 60 passed (62)

```diff
diff --git a/apps/server/src/runtime/history-source.ts b/apps/server/src/runtime/history-source.ts
index 02223e7..af7187e 100644
--- a/apps/server/src/runtime/history-source.ts
+++ b/apps/server/src/runtime/history-source.ts
@@ -510,7 +510,6 @@ export class FileHistorySource implements HistorySourcePort {
     // 3b-3⑤ 指纹短路（契约 §1.3）：同指纹=整文件字节未变——无论 inode 是否更换（同字节换 inode=短路，观察一致面不换流）
     if (read.fingerprint === entry.fingerprint) {
       if (read.identity !== entry.identity) {
-        entry.identity = read.identity; // 后续追加/换代判据跟到新 inode
         this.audit(`fingerprint-skip-identity-change file=${entry.file} why=${why}`);
       } else {
         this.audit(`fingerprint-skip file=${entry.file} why=${why}`);
```

## M-FP-3：追加后指纹不更新→同内容再触永不短路（审计面消失）
- 状态：KILLED
- 失败测试：['× 内容增长→正常 append+指纹跟进；随后同内容 notice→fingerprint-skip 410ms']
- 结果行：Tests  1 failed | 61 passed (62)

```diff
diff --git a/apps/server/src/runtime/history-source.ts b/apps/server/src/runtime/history-source.ts
index 02223e7..5e77ac4 100644
--- a/apps/server/src/runtime/history-source.ts
+++ b/apps/server/src/runtime/history-source.ts
@@ -551,7 +551,7 @@ export class FileHistorySource implements HistorySourcePort {
       entry.baselineRows.push(row);
       entry.baseline.push(digests[i] as { locator: string; digest: string });
     }
-    entry.fingerprint = read.fingerprint; // 3b-3⑤：重扫成功落地后指纹跟进（下一轮同内容 notice 可短路）
+    // M-FP-3
     this.audit(`rescan file=${entry.file} why=${why} rows=${rows.length} appended=${appended}`);
     // 重挂观察（fs.watch 对 rename 类事件可能失效——重叠换新关旧；失败→unavailable，R6 fail-closed）
     this.rearmWatcher(slot, entry);
```

## M-FP-4：网关不记指纹（元数据接线断——审计行消失）
- 状态：KILLED
- 失败测试：['× 3b-3⑤：装载后审计 index-fingerprint（journal/session 各 12hex；journal-only 面 session=-） 8ms']
- 结果行：Tests  1 failed | 72 passed (73)

```diff
diff --git a/apps/server/src/ws/ws-gateway.ts b/apps/server/src/ws/ws-gateway.ts
index 8480e71..1f9a720 100644
--- a/apps/server/src/ws/ws-gateway.ts
+++ b/apps/server/src/ws/ws-gateway.ts
@@ -606,7 +606,7 @@ export class WsGateway {
    * 不得让旧引擎接收新流坐标的事件；R3：所有装载/增量出口统一容量门。 */
   /** 3b-3⑤：装载/续编时把两源整文件指纹落到索引（信息性元数据+审计行——变更检测触发器，非身份判据）。 */
   private recordFingerprints(file: string, index: ReadIndex): void {
-    const fp = this.opts.historySource?.fingerprints?.(file);
+    return; const fp = this.opts.historySource?.fingerprints?.(file);
     if (fp === null || fp === undefined) return;
     index.journalFingerprint = fp.journal;
     index.sessionFingerprint = fp.session;
```

## 还原后全仓复验
Tests  747 passed | 7 skipped (754)
