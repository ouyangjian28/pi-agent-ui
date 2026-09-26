# 变异记录：3b-3② real-fs E2E（基线=本文件同提交（real-fs E2E 落地提交））

## M-RF-a
- 状态：KILLED
- 失败测试：['× RF7 缺源恢复晚附：journal-only 订阅→session 落盘→后续新行直达+晚附行恰一次 3159ms']
- 结果行：Tests  1 failed | 8 passed (9)

```diff
diff --git a/apps/server/src/ws/ws-gateway.ts b/apps/server/src/ws/ws-gateway.ts
index 8480e71..e863a7e 100644
--- a/apps/server/src/ws/ws-gateway.ts
+++ b/apps/server/src/ws/ws-gateway.ts
@@ -648,7 +648,7 @@ export class WsGateway {
       const before = index.waterMark;
       const appended = index.continueFrom(rows);
       this.recordFingerprints(file, index);
-      if (appended > 0) {
+      if (false) {
         const fresh = index.read(before + 1, appended);
         for (const fe of fresh) this.forEachEngine(file, (e) => e.onHistoryAppend(fe.event));
         this.schedulePump(file);
```

## M-RF-b
- 状态：KILLED
- 失败测试：['× RF1 双源同 tick 追加：journal+session 各恰一次到货，无错流无换流 3164ms', '× RF2 撕裂尾跨写补全：半行不发布，补全+换行后恰一次发布（session 面） 3407ms', '× RF3 rename-over 同字节：不换流（fingerprint 短路）+重挂后新追加仍达（watch 重建） 3457ms', '× RF4 rename-over 改写：在订连接收 4409（invalid-stream 真路径）；重订得新 streamId 3155ms']
- 结果行：Tests  6 failed | 3 passed (9)

```diff
diff --git a/apps/server/src/runtime/history-source.ts b/apps/server/src/runtime/history-source.ts
index 02223e7..7c13fd1 100644
--- a/apps/server/src/runtime/history-source.ts
+++ b/apps/server/src/runtime/history-source.ts
@@ -87,7 +87,7 @@ export class RealReader implements HistoryReaderPort {
       }
       if (tail.length > 0) text += new TextDecoder("utf-8", { ignoreBOM: true }).decode(tail);
       // 3b-3⑤：指纹=整文件字节（含撕裂尾）——撕裂尾增长也改变指纹（触发重扫→前缀比对裁决追加）
-      return { text, identity: `${st.dev}:${st.ino}`, fingerprint: sha256HexBytes(buf) };
+      return { text, identity: `${st.dev}:${st.ino}`, fingerprint: "" };
     } finally {
       await fh.close().catch(() => {});
     }
```

## 还原后全仓复验
Tests  756 passed | 7 skipped (763)
