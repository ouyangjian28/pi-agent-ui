# 写侧收线 N6 变异档：gateway origin 快照独立杀面（基线=01a5af8，先提交后变异）

对象=tests/unit/server/ws-gateway.test.ts「B3 快照①」（构造后热插/热删调用方数组双向断言）。
还原=`git checkout -- apps/server/src/ws/ws-gateway.ts`，复核 `git rev-parse HEAD:apps/server/src/ws/ws-gateway.ts` == `git hash-object apps/server/src/ws/ws-gateway.ts` → **RESTORE_OK**。
背景：⑤B r1 的 S7 变异只杀 transport 层快照；gateway 层快照（hello 后检查）无独立变异覆盖（GPT r2 N3-④/N6，TEST-MAP:760 挂账）——本档补齐销案。

## M1 NOSNAPSHOT（去快照——直接绑调用方数组）
- 改法：constructor 内 `this.originSnapshot = Object.freeze([...opts.allowedOrigins]);` → `this.originSnapshot = opts.allowedOrigins; // MUTATION NOSNAPSHOT`
- 结果：VITEST_EXIT=1；1 failed | 102 skipped（-t "B3 快照" 定向）。首败=**B3 快照①:252**（`AssertionError: expected false to be true`——热插的 `http://evil.example` 被放行，无 4401）；首断言先杀即止（热删分支同缺陷形态，随首败不可达=正常）。
- 归因：缺快照→鉴权跟随调用方数组活变→构造期白名单承诺失效（外部热插即混入）。双向例的另一翼（热删后原白名单仍过）在缺陷形下同样反向（合法端被踢），由首败遮蔽，非无杀力。
- 完整输出=../run-records/n6-gateway-origin-snapshot-mut1.log。

## 复核
- 还原后定向 103/103 绿 + 全仓 60 files/1159 passed|15 skipped 绿（还原后首轮曾现 history-source.test.ts 偶发首败——21 轮审尾项⑦已知未定根因，再跑两次全绿，与本档无关）。
- 单变异单杀面（缺陷形唯一：去 freeze+去复制同点）；无第二形态（如只去 freeze 不去复制=不可观测差异，诚实披露）。
