// Explicit navigation only. Never subscribe to Source selection/restoration,
// proxy SDK writes, copy drafts or treat local selection as durable launch.
import { LIMITS } from "@pi-agent-ui/protocol/src/contracts";
import { autoFile, MODEL_DEFAULT } from "../ws/draft-model";
import type { NativePiPort, NativePiSnapshot } from "./native-pi-port";
import { nativeDirectory } from "./oc-read-projection";

export type NativeNavigationResult =
  | { readonly status: "selected"; readonly kind: "session" | "draft"; readonly slotId: string; readonly file: string; readonly directory: string }
  | { readonly status: "local"; readonly reason: "not-ready" | "unconfirmed-target" | "directory-mismatch" | "filename-collision" | "invalid-filename" | "unavailable"; readonly message: string };
const local = (reason: Extract<NativeNavigationResult, { status: "local" }>["reason"], message: string): NativeNavigationResult => ({ status: "local", reason, message });
function ready(snapshot: NativePiSnapshot): boolean {
  return snapshot.list.state === "ready" && snapshot.write.connState === "ready" && snapshot.detail.connState === "ready" && snapshot.list.sessions !== null;
}
/** makeFile is a trusted implementation dependency, never Source/user input.
 * Directory is the native landing root, NOT an OS HOME or execution-cwd claim.
 */
export function nativeNavigationActions(port: NativePiPort, makeFile: () => string = autoFile) {
  const target = (hint: string | null | undefined): string | NativeNavigationResult => {
    const snapshot = port.getSnapshot();
    const directory = nativeDirectory(snapshot);
    if (!ready(snapshot) || directory === null) return local("not-ready", "pi 连接、会话清单或授权目录未确认，未切换目标。");
    if (hint !== undefined && hint !== directory) return local("directory-mismatch", "此目录未接入原生导航，原目标与草稿已保留。");
    return directory;
  };
  return {
    open(file: string, directoryHint?: string | null): NativeNavigationResult {
      const directory = target(directoryHint);
      if (typeof directory !== "string") return directory;
      if (!LIMITS.filePattern.test(file) || !port.getSnapshot().list.sessions?.some(row => row.file === file)) return local("unconfirmed-target", "目标不在已确认的 pi 清单中，未切换。");
      const id = port.openSession(file);
      return id === null ? local("unavailable", "界面已关闭或目标无效，未切换。") : { status: "selected", kind: "session", slotId: id, file, directory };
    },
    newDraft(directoryHint?: string | null): NativeNavigationResult {
      const directory = target(directoryHint);
      if (typeof directory !== "string") return directory;
      let file: string;
      try { file = makeFile(); } catch { return local("invalid-filename", "新草稿名称未生成，原目标与草稿已保留。"); }
      if (!LIMITS.filePattern.test(file)) return local("invalid-filename", "新草稿名称无效，原目标与草稿已保留。");
      const snapshot = port.getSnapshot();
      if (snapshot.list.sessions?.some(row => row.file === file) || [...snapshot.conversation.drafts.values(), ...snapshot.conversation.sessions.values()].some(slot => slot.file === file)) return local("filename-collision", "草稿名称已占用，未把已有会话当成新会话。");
      // A local slot only: no server create, prompt, resume or durable success.
      const id = port.createDraft(file, MODEL_DEFAULT);
      return id === null ? local("unavailable", "界面已关闭或目标无效，未创建草稿。") : { status: "selected", kind: "draft", slotId: id, file, directory };
    },
  };
}
