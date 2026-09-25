// ②WS/UI 值级脱敏产线（契约 v1.2 §5.4；真实现）。
// 零 node 依赖（浏览器安全）。顺序=NFC→剥控制→形态替换→不安全集合→截断→置位。
// 保证边界（如实声明）：已知敏感形态的确定删除+不可分类内容不外发；不承诺任意自然语言秘密识别。
//
// B05（c4 审定）：形态替换按「完整语义单元先行」排序——先处理作为整体出现的秘密
// （PEM/env/Bearer/AKIA/ssh-rsa/含 userinfo 的 URL），最后才跑泛路径规则。
// 理由：env 值（API_KEY=abcd/efgh/ijkl）与 ssh 公钥（base64 含 /）会被先行的
// 路径规则撕碎中段，留下残缺形态既泄漏又破坏后续识别（GPT 实测探针）。
//
// B07（3b2a 修复轮）：所有内部量词一律有界。无界贪婪类（\w*、[a-z0-9+.-]*、\S+）
// 在无锚字面（=、://、@、\\）文本上吃到串尾后逐字符回溯，每起点 O(n)、全程
// O(n²)；65KiB 无分隔符文本实测 ③⑦⑧三条各 ~3s（V8 无占有量词，Node 24
// `\w*+` 报 Nothing to repeat）。有界=每起点回溯步数封顶 → 总线性。
// 语义边界（如实声明；预览 limit 200/title 80 下界外字符不可见；machineId
// 超界输入本就走哈希映射）：
//   - env 键名 >128 字符：遮蔽从「能触及 = 的最早起点」开始，键名前缀透出（值恒遮）
//   - URL scheme >32 字符：遮蔽起点后移到 scheme 第 len-32 字符起（scheme 前缀透出，
//     其余仍遮——RFC 3986 注册 scheme 均 ≤32，界内语义全保）
//   - userinfo/host >256、URL 全长 >1024：⑦降级⑧整体遮 scheme:[url]；⑧只遮前 1024
//   - 路径段 >255 字符或 >32 段：超段路径另起匹配分段遮（[path][path] 拼接，
//     全跨度仍被遮）；超长单段不遮；Windows 路径 >255 只遮前 255
//   - PEM 标签 >255、Bearer 后空白 >64：不匹配（现实形态均远低于界）
import type { SanitizedText } from "./contracts.ts";

// --- 形态替换规则（顺序敏感：完整语义单元 → 泛形态） ---
const SECRET_REPLACEMENTS: readonly { readonly re: RegExp; readonly out: string }[] = [
  // ① PEM 整块（任意大写标签：PRIVATE KEY/CERTIFICATE/…；含多行正文）→ 整块遮蔽
  { re: /-----BEGIN [A-Z0-9 ]{1,255}-----[\s\S]*?-----END [A-Z0-9 ]{1,255}-----/g, out: "[secret]" },
  // ② 截断 PEM（有 BEGIN 无 END）→ 遮到末尾，正文不泄漏
  { re: /-----BEGIN [A-Z0-9 ]{1,255}-----[\s\S]*$/g, out: "[truncated-secret]" },
  // ③ env 赋值（完整键值单元；值可为带 / 的路径形态——先于路径规则防撕碎）
  { re: /[A-Za-z_]\w{0,127}=(?:"[^\n"]{4,}"|[\w./-]{8,})/g, out: "[env]" },
  // ④ Bearer 凭据（整 token）
  { re: /Bearer\s{1,64}\S+/gi, out: "[token]" },
  // ⑤ AWS AKIA 形态
  { re: /AKIA[0-9A-Z]{16}/g, out: "[secret]" },
  // ⑥ ssh 公钥（base64 可含 / 与 + ——先于路径规则防撕碎）
  { re: /ssh-rsa AAAA[0-9A-Za-z+/=]{32,}/g, out: "[secret]" },
  // ⑦ 含 userinfo 的 URL：整条遮蔽（带凭据 URL 比裸 URL 更敏感，不保留 scheme）
  { re: /[a-z][\w+.-]{0,31}:\/\/\S{1,256}@\S{1,256}/gi, out: "[url]" },
  // ⑧ URL 整体（scheme://…）：保留 scheme，余下全部遮蔽（host+路径均保守）
  { re: /([a-z][\w+.-]{0,31}):\/\/\S{1,1024}/gi, out: "$1:[url]" },
  // ⑨ POSIX 绝对路径 ≥2 段（段内容=非空白/非引号/非尖括号/非管道；含中文）。
  //    (?<!:) 排除 URL 的 //host 形态；单段如 /secret = 命名性内容，声明允许透出。
  { re: /(?<!:)(?:\/[^\s"'>|\\]{1,255}){2,32}\/?/g, out: "[path]" },
  // ⑩ Windows 盘符绝对路径 / UNC
  { re: /[A-Za-z]:\\[^\s"<>|]{1,255}/g, out: "[path]" },
  { re: /\\\\[\w.-]{1,255}\\[^\s"]{1,255}/g, out: "[path]" },
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

/**
 * FNV-1a 64 位（UTF-8 全字节；BigInt）。
 * B05（c4 审定）：charCodeAt & 0xff 丢高 8 位（\u0100/\u0200 同哈希整类碰撞）
 * → 改对 TextEncoder 编码的全部字节折叠。
 */
export function fnv1a64Hex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const prime = 0x100000001b3n, mask = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}
