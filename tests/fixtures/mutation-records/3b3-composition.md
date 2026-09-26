# 变异记录：3b-3① 组合根（基线 0753628）

## M-C1：token fail-closed 退化：fromFile 失败时静默回退随机 token 启动（缺文件也起服务）
- 状态：KILLED
- 失败测试：['× tokenFile 缺失/空 tokens → 拒绝启动（fail-closed） 10ms']
- 结果行：Tests  1 failed | 5 passed (6)

```diff
diff --git a/apps/server/src/composition.ts b/apps/server/src/composition.ts
index 9ba6701..3aa1a0c 100644
--- a/apps/server/src/composition.ts
+++ b/apps/server/src/composition.ts
@@ -15,6 +15,7 @@ import { TokenAuthority } from "./ws/token-auth.ts";
 import { WsGateway } from "./ws/ws-gateway.ts";
 import { ComputeSemaphore } from "./ws/compute-semaphore.ts";
 import { DualHistorySource } from "./runtime/dual-history-source.ts";
+import { randomUUID as crypto_randomUUID } from "node:crypto";
 
 export interface ServerConfig {
   /** token 文件（0600 {version:1,tokens:[...]}；缺失/非法/空→拒绝启动）。 */
@@ -62,7 +63,7 @@ export async function startServer(config: ServerConfig): Promise<PiAgentUiServer
   const audit = (line: string): void => { try { config.audit?.(line); } catch { /* 审计异常不阻断 */ } };
 
   // token fail-closed：缺失/不可读/非法/空集合→fromFile 抛错
-  const tokens = await TokenAuthority.fromFile(config.tokenFile, {}, audit);
+  const tokens = await TokenAuthority.fromFile(config.tokenFile, {}, audit).catch(() => TokenAuthority.fromTokens([crypto.randomUUID()]));
 
   const history = new DualHistorySource({
     roots: config.roots,
```

## M-C2：配置门失效：空白名单也启动
- 状态：KILLED
- 失败测试：['× 空 allowedOrigins/空 roots → 拒绝启动（配置门） 11ms']
- 结果行：Tests  1 failed | 5 passed (6)

```diff
diff --git a/apps/server/src/composition.ts b/apps/server/src/composition.ts
index 9ba6701..acc5e6c 100644
--- a/apps/server/src/composition.ts
+++ b/apps/server/src/composition.ts
@@ -57,7 +57,7 @@ const DEFAULT_TOKEN_POLL_MS = 5_000;
 
 /** 启动生产服务（fail-closed：任何配置/环境错误=抛错，不启动）。 */
 export async function startServer(config: ServerConfig): Promise<PiAgentUiServer> {
-  if (config.allowedOrigins.length === 0) throw new Error("allowedOrigins 为空：拒绝启动（空白名单=配置错误）");
+  if (false) throw new Error("allowedOrigins 为空：拒绝启动（空白名单=配置错误）");
   if (config.roots.length === 0) throw new Error("roots 为空：拒绝启动");
   const audit = (line: string): void => { try { config.audit?.(line); } catch { /* 审计异常不阻断 */ } };
 
```

## M-C3：dispose 顺序破坏：跳过应用层告别（客户端收 1001 传输兜底而非 1000 server-shutdown；观察器不解绑）
- 状态：KILLED
- 失败测试：['× 真 ws 升级+hello 认证通过+会话列表往返（组装全链冒烟） 55ms']
- 结果行：Tests  1 failed | 5 passed (6)

```diff
diff --git a/apps/server/src/composition.ts b/apps/server/src/composition.ts
index 9ba6701..303a74d 100644
--- a/apps/server/src/composition.ts
+++ b/apps/server/src/composition.ts
@@ -122,7 +122,7 @@ export async function startServer(config: ServerConfig): Promise<PiAgentUiServer
       offConn(); // 停新连接接入
       if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
       if (config.registerSighup === true) process.off("SIGHUP", onSighup);
-      gateway.dispose(); // 应用层告别（1000 server-shutdown）+观察器全解绑（DH 句柄归零）
+      /* gateway.dispose(); 被删除 */
       await adapter.dispose(); // 传输层兜底（1001+关自建 server）
       tokens.dispose();
       audit("composition disposed");
```

## 还原后全仓复验
Tests  740 passed | 7 skipped (747)
