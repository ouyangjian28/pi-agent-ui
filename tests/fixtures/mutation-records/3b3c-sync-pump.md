# 变异记录：3b3c 同步排水轮（基线 7bfcde2）

## M-P1：onAppend 路径去同步排水（回归泵饥饿：快客户端被积压门误杀）
- 状态：KILLED
- 失败：['× RW1 快/慢并存：慢客户端卡分页→订阅级 4431（retryable=false 只关订阅）；快客户端全量不受影响；慢客户端 cursor 续读恢复 5605ms', '× RW2 停读套接字（真慢客户端）：live 积压转运→连接级 4431（retryable=true 断链重连）；订阅级不误杀 1821ms', 'FAIL  |integration| tests/integration/real-ws.test.ts > 3b-3③ real-ws：真实传输+慢客户端矩阵 > RW1 快/慢并存：慢客户端卡分页→订阅级 4431（retryable=false 只关订阅）；快客户端全量不受影响；慢客户端 cursor 续读恢复', 'FAIL  |integration| tests/integration/real-ws.test.ts > 3b-3③ real-ws：真实传输+慢客户端矩阵 > RW2 停读套接字（真慢客户端）：live 积压转运→连接级 4431（retryable=true 断链重连）；订阅级不误杀']
- 结果行：Tests  2 failed | 13 passed (15)

```diff
diff --git a/apps/server/src/ws/ws-gateway.ts b/apps/server/src/ws/ws-gateway.ts
index 58b9f00..e1cfddf 100644
--- a/apps/server/src/ws/ws-gateway.ts
+++ b/apps/server/src/ws/ws-gateway.ts
@@ -732,7 +732,7 @@ export class WsGateway {
             this.audit(`index-over-budget file=${file} waterMark=${index.waterMark}`);
             this.closeSubscriptionsFor(file, "index-over-budget");
           }
-          if (!this.pumpIfBacklogged(file)) this.schedulePump(file); // 3b3c：达批同步排水，防同 tick 批量编入饥饿泵定时器
+          this.schedulePump(file);
         },
         onInvalidate: (reason) => {
           if (this.watchers.get(file) !== rec) return; // R3：旧闭包不得退新订阅
```

## M-P2：syncIndex 批量分发去分块排水（恢复期大批量续编饥饿）
- 状态：KILLED
- 失败：['× RF11 3b3c：恢复期大批量续编（session 首装 1100 行）→既有 live 引擎同步排水不被积压门误杀 5002ms', 'FAIL  |integration| tests/integration/real-fs.test.ts > 3b-3② real-fs：真实 OS 文件时序（真 tmpdir+真 fs.watch+真 reader） > RF11 3b3c：恢复期大批量续编（session 首装 1100 行）→既有 live 引擎同步排水不被积压门误杀']
- 结果行：Tests  1 failed | 14 passed (15)

```diff
diff --git a/apps/server/src/ws/ws-gateway.ts b/apps/server/src/ws/ws-gateway.ts
index 58b9f00..7291880 100644
--- a/apps/server/src/ws/ws-gateway.ts
+++ b/apps/server/src/ws/ws-gateway.ts
@@ -857,7 +857,6 @@ export class WsGateway {
     for (let i = 0; i < fresh.length; i++) {
       const fe = fresh[i]!;
       this.forEachEngine(file, (e) => e.onHistoryAppend(fe.event));
-      if ((i & 15) === 15) this.pumpIfBacklogged(file);
     }
     this.schedulePump(file);
   }
```

## M-P3：排水判据退回混合 buffered（paging 滞留误触发→每事件排水帧碎片化→连接队列超限）
- 状态：KILLED
- 失败：['× RW1 快/慢并存：慢客户端卡分页→订阅级 4431（retryable=false 只关订阅）；快客户端全量不受影响；慢客户端 cursor 续读恢复 5604ms', 'FAIL  |integration| tests/integration/real-ws.test.ts > 3b-3③ real-ws：真实传输+慢客户端矩阵 > RW1 快/慢并存：慢客户端卡分页→订阅级 4431（retryable=false 只关订阅）；快客户端全量不受影响；慢客户端 cursor 续读恢复']
- 结果行：Tests  1 failed | 14 passed (15)

```diff
diff --git a/apps/server/src/ws/ws-gateway.ts b/apps/server/src/ws/ws-gateway.ts
index 58b9f00..b9cdba5 100644
--- a/apps/server/src/ws/ws-gateway.ts
+++ b/apps/server/src/ws/ws-gateway.ts
@@ -833,7 +833,7 @@ export class WsGateway {
    * 返回是否已排水（未达批由调用方走异步 schedulePump 收尾）。 */
   private pumpIfBacklogged(file: string): boolean {
     let hit = false;
-    this.forEachEngine(file, (e) => { if (e.outboxDepth >= LIMITS.maxEventsPerLiveFrame) hit = true; });
+    this.forEachEngine(file, (e) => { if (e.state.buffered >= LIMITS.maxEventsPerLiveFrame) hit = true; });
     if (hit) this.pumpFile(file);
     return hit;
   }
```

## 还原后全仓复验
Tests  762 passed | 7 skipped (769)
