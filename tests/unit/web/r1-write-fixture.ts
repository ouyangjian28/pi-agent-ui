import type { WriteSnapshot } from "../../../apps/web/src/ws/write-client";
/** 共享组件真消费面：完整、稳定引用的快照，不能用每次新建的半 DTO 掩盖接线。 */
export const READY_WRITE_SNAPSHOT: WriteSnapshot = {
  connState: "ready", errorKind: null, errorMessage: null, inflight: [], lastResult: null,
  resumeState: { phase: "idle" }, lastResumeResult: null,
};
