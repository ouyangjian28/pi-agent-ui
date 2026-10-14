import { LIMITS } from "@pi-agent-ui/protocol/src/contracts";
export const MODEL_DEFAULT = "__default__";
export const LAST_MODEL_KEY = "piagent-last-model";
export function isPersistableModel(value: string): boolean {
  return value === MODEL_DEFAULT || (!value.startsWith("__") && LIMITS.modelPattern.test(value));
}
export function readLastModel(): string | null {
  try { const value = window.localStorage.getItem(LAST_MODEL_KEY); return value !== null && isPersistableModel(value) ? value : null; }
  catch { return null; }
}
export function writeLastModel(value: string): void {
  try { if (isPersistableModel(value)) window.localStorage.setItem(LAST_MODEL_KEY, value); }
  catch { /* 无痕存储降级，不影响发送 */ }
}
export function autoFile(now: () => Date = () => new Date(), random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const d = now(); const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `auto-${stamp}-${Array.from(random(16), (b) => b.toString(16).padStart(2, "0")).join("")}.jsonl`;
}
export function effectiveModel(choice: string, freeText: string): string | undefined {
  const value = freeText.trim() || choice;
  return value === MODEL_DEFAULT && freeText.trim() === "" ? undefined : value;
}
export function isSendableModel(value: string | undefined): boolean {
  return value === undefined || (value !== MODEL_DEFAULT && isPersistableModel(value));
}
