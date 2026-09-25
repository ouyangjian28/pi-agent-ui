// ②WS/UI 值级脱敏产线（契约 v1.2 §5.4；真实现）。
// 零 node 依赖（浏览器安全）。顺序=NFC→剥控制→形态替换→不安全集合→截断→置位。
// 保证边界（如实声明）：已知敏感形态的确定删除+不可分类内容不外发；不承诺任意自然语言秘密识别。
import type { SanitizedText } from "./contracts.ts";

// --- 形态替换规则（顺序敏感：先长形态后短形态） ---
const SECRET_REPLACEMENTS: readonly { readonly re: RegExp; readonly out: string }[] = [
  // PEM 整块（含多行正文）→ 整块遮蔽
  { re: /-----BEGIN [A-Z ]+KEY-----[\s\S]*?-----END [A-Z ]+KEY-----/g, out: "[secret]" },
  // 截断 PEM（有 BEGIN 无 END）→ 遮到末尾，正文不泄漏
  { re: /-----BEGIN [A-Z ]+KEY-----[\s\S]*$/g, out: "[truncated-secret]" },
  // URL userinfo（先于路径与 URL 整体：避免 //user:pass@host 被路径形态吞掉）
  { re: /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi, out: "[userinfo-removed]" },
  // URL 整体（scheme://…）：保留 scheme，余下全部遮蔽（host+路径均保守；先于 POSIX 路径防 // 被吞）
  { re: /([a-z][a-z0-9+.-]*):\/\/\S+/gi, out: "$1:[url]" },
  // POSIX 绝对路径 ≥2 段（段内容=非空白/非引号/非尖括号/非管道；含中文）。
  // (?<!:) 排除 URL 的 //host 形态；单段如 /secret = 命名性内容，声明允许透出。
  { re: /(?<!:)(?:\/[^\s"'>|\\]+){2,}\/?/g, out: "[path]" },
  // Windows 盘符绝对路径 / UNC
  { re: /[A-Za-z]:\\[^\s"<>|]+/g, out: "[path]" },
  { re: /\\\\[\w.-]+\\[^\s"]+/g, out: "[path]" },
  // env 赋值
  { re: /[A-Za-z_]\w*=(?:"[^\n"]{4,}"|[\w./-]{8,})/g, out: "[env]" },
  // Bearer 凭据
  { re: /Bearer\s+\S+/gi, out: "[token]" },
  // AWS AKIA 形态 / ssh 公钥
  { re: /AKIA[0-9A-Z]{16}/g, out: "[secret]" },
  { re: /ssh-rsa AAAA[0-9A-Za-z+/=]{32,}/g, out: "[secret]" },
];

// --- 不安全字符集（精确 Unicode 集合；存在→整段替换） ---
const UNSAFE_CHARS =
  /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/;

// --- 控制字符（Cc/Co/Cs + U+2028/2029 + 软连字 U+00AD；\n 折叠空格、\t 保留）---
// 注：Cf 不在此剥——RTL/双向/零宽等危险 Cf 留给 UNSAFE_CHARS 整段替换（剥除会让恶意混入不可见化后静默通过）。
const CONTROL_RE = /[\p{Cc}\p{Co}\p{Cs}\u2028\u2029\u00AD]/gu;

/**
 * 正文/预览脱敏。limit=代码单元截断上限。
 * 单段路径（如 /secret）为命名性内容，按契约声明允许透出。
 */
export function sanitizeText(input: string, limit: number): SanitizedText {
  let s = input.normalize("NFC");
  s = s.replace(CONTROL_RE, (ch) => (ch === "\n" ? " " : ch === "\t" ? ch : ""));
  // 形态替换（单轮全局即够：替换输出 [xxx] 形态不再匹配任何规则）
  for (const { re, out } of SECRET_REPLACEMENTS) s = s.replace(re, out);
  if (UNSAFE_CHARS.test(s)) return { text: "[unsafe-content]", truncated: false };
  if (s.length > limit) {
    // Unicode 截断边界：不切断代理对
    let end = limit;
    const lo = s.charCodeAt(end - 1), hi = s.charCodeAt(end);
    if (lo >= 0xd800 && lo <= 0xdbff && hi >= 0xdc00 && hi <= 0xdfff) end -= 1;
    return { text: s.slice(0, end), truncated: true };
  }
  return { text: s, truncated: false };
}

/**
 * 机器标识符映射（契约 §5.4 第 5 条）：
 * 1) 先跑凭据形态替换（AKIA… 等形态不得借 ID 字段过白名单）；
 * 2) 白名单 /^[\w:.-]{1,128}$/ → 原样（合法宿主 entryId 保留，验收身份所需）；
 * 3) 否则映射 `~id-<FNV-1a64 hex16>`——前缀 `~` 不在白名单字符集，
 *    故映射输出永不等于任何合法 ID（撞键结构性消除）。
 * 非密码学哈希（稳定关联所需，非安全用途）。
 * number 字段（commandId/generation/ordinal）为数字安全，不经本函数。
 */
export function machineId(id: string): string {
  let s = id.normalize("NFC");
  for (const { re, out } of SECRET_REPLACEMENTS) s = s.replace(re, out);
  if (s !== id) return `~id-${fnv1a64Hex(id)}`; // 凭据形态被替换→按非法处理（不外发原值；~ 前缀防撞键）
  if (/^[\w:.-]{1,128}$/.test(s)) return s;
  return `~id-${fnv1a64Hex(s)}`;
}

/** FNV-1a 64 位 → 16 位 hex（BigInt；浏览器/Node 均支持） */
export function fnv1a64Hex(s: string): string {
  const prime = 0x100000001b3n, mask = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i) & 0xff);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}
