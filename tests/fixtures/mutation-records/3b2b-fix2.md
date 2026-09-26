# 变异记录：3b2b-fix2 轮（基线 c50f323）

方法：python 锚点替换（count==1 断言）→ 定向 vitest → git checkout 还原（还原后全仓 729+7 绿复验）。
脚本：/tmp/mut-3b2c-fix2.py（会话内；锚点即下述 diff）。

## M-F2-01：observe 出口不消费 credit（`if (credit > 0)` → `if (false)`）
- 文件：apps/server/src/runtime/dual-history-source.ts（observe 尾段 credit 块）
- kill：dual-history-source.test.ts 1 failed（F2-01 用例——observe-session-credit 审计缺失即挂）→ KILLED

## M-F2-02：observe 登记退回单条覆盖（`regs.push(st)` → `this.obs.set(file, [st])`）
- 文件：apps/server/src/runtime/dual-history-source.ts（observe 登记段）
- kill：dual-history-source.test.ts 1 failed（F2-02 用例——旧注册丢失→晚附找不到入口）→ KILLED

## M-F2-02b：closeObsState 清整列表不按身份 splice（→ `this.obs.delete(st.file)` 无条件）
- 文件：apps/server/src/runtime/dual-history-source.ts（closeObsState 尾段）
- kill：dual-history-source.test.ts 1 failed（F2-02 用例——B stop 清掉 A 的登记）→ KILLED

## M-F2-03：前缀解码去 ignoreBOM（默认剥 BOM）
- 文件：apps/server/src/runtime/history-source.ts（RealReader.read 前缀 decoder）
- kill：history-source.test.ts 2 failed（BOM locator 偏移+两输入折叠）→ KILLED
