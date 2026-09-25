// ②WS/UI 值级脱敏产线（契约 v1.2 §5.4；真实现）。
// 零 node 依赖（浏览器安全）。顺序=NFC→剥控制→形态替换→不安全集合→截断→置位。
// 保证边界（如实声明）：已知敏感形态的确定删除+不可分类内容不外发；不承诺任意自然语言秘密识别。
//
// B05（c4 审定）：形态替换按「完整语义单元先行」排序——先处理作为整体出现的秘密
// （PEM/env/Bearer/AKIA/ssh-rsa/含 userinfo 的 URL），最后才跑泛路径规则。
// 理由：env 值（API_KEY=abcd/efgh/ijkl）与 ssh 公钥（base64 含 /）会被先行的
// 路径规则撕碎中段，留下残缺形态既泄漏又破坏后续识别（GPT 实测探针）。
//
// B07（3b2a 修复轮）→ **B6 勘正（GPT 3b2b）**：
//   - 「全量词有界→总线性」声明不成立：①PEM 惰性 [\s\S]*? 在重复 BEGIN 无 END 输入上
//     每起点扫描剩余后缀（实测 512KiB≈5.7s）。已改为 maskPem 线性扫描器（indexOf 单调
//     推进，可证明单次扫过）：不再存在重复起点路径。其余规则的有界量词仍保留（消灭
//     O(n²) 回溯），但线性性由「无回溯压力」而非「有界」单独保证。
//   - 替换先缩短再截断→界外尾部拉回预览（N8/N9）：有界跨度只匹配长令牌前缀时，
//     未消费尾段在截断后重新可见。已修：令牌型规则（③env/⑦userinfo/⑧URL/⑩Windows
//     及 UNC）一律追加尾随 \\S* ——尾随无约束量词零回溯（线性），且后无其它子式，
//     使「已识别敏感单元整体消费或整体遮」成立：替换缩短后拉回预览的只可能是
//     未被任何规则识别的内容（设计语义），不再有「识别了却只遮一半」的泄漏面。
// 语义边界（如实声明；预览 limit 200/title 80 下截断后可见的仅限未识别内容；
// machineId 超界输入本就走哈希映射）：
//   - env 键名 >128 字符：遮蔽从「能触及 = 的最早起点」开始，键名前缀透出（值恒遮）
//   - URL scheme >32 字符：遮蔽起点后移（scheme 前缀透出，其余整令牌遮）
//   - userinfo/host >256、URL 全长 >1024：⑦降级⑧；⑧尾随 \\S* 吃满整个令牌（N8 修复）
//   - 路径段 >255 字符或 >32 段：POSIX 超段路径链式匹配分段遮（[path] 拼接，全跨度仍遮）；
//     超长单段不遮；Windows 路径 >255 尾随 \\S* 吃满令牌（N9 修复）
//   - PEM 标签 >255 或含非 [A-Z0-9 ]：不当作 PEM（维护既有语义）；BEGIN 无 END→遮到末尾
//   - Bearer 后空白 >64：不匹配（现实形态远低于界；此为失配不泄漏，非半遮）
import type { SanitizedText } from "./contracts.ts";

// --- 形态替换规则（顺序敏感：完整语义单元 → 泛形态；PEM=①②已抽出为 maskPem 线性扫描器，先于本表） ---
const SECRET_REPLACEMENTS: readonly { readonly re: RegExp; readonly out: string }[] = [
  // ③ env 赋值（完整键值单元；值可为带 / 的路径形态——先于路径规则防撕碎；尾随 \\S* 吃满同令牌余段）
  { re: /[A-Za-z_]\w{0,127}=(?:"[^\n"]{4,}"|[\w./-]{8,})\S*/g, out: "[env]" },
  // ④ Bearer 凭据（整 token）
  { re: /Bearer\s{1,64}\S+/gi, out: "[token]" },
  // ⑤ AWS AKIA 形态
  { re: /AKIA[0-9A-Z]{16}/g, out: "[secret]" },
  // ⑥ ssh 公钥（base64 可含 / 与 + ——先于路径规则防撕碎；尾随 \\S* 吃满令牌防半遮尾段）
  { re: /ssh-rsa AAAA[0-9A-Za-z+/=]{32,}\S*/g, out: "[secret]" },
  // ⑦ 含 userinfo 的 URL：整令牌遮蔽（带凭据 URL 比裸 URL 更敏感，不保留 scheme；尾随 \\S* 吃满 host 段）
  { re: /[a-z][\w+.-]{0,31}:\/\/\S{1,256}@\S{1,256}\S*/gi, out: "[url]" },
  // ⑧ URL 整体（scheme://…）：保留 scheme，余下全部遮蔽；尾随 \\S* 吃满整个令牌（N8：超长 URL 不再泄漏尾段）
  { re: /([a-z][\w+.-]{0,31}):\/\/\S{1,1024}\S*/gi, out: "$1:[url]" },
  // ⑨ POSIX 绝对路径 ≥2 段（段内容=非空白/非引号/非尖括号/非管道；含中文）。
  //    (?<!:) 排除 URL 的 //host 形态；单段如 /secret = 命名性内容，声明允许透出。
  //    超段路径链式匹配：/g 每轮吃 32 段，下一轮从紧邻处再起——全跨度拼接遮蔽。
  { re: /(?<!:)(?:\/[^\s"'<>|\\]{1,255}){2,32}\/?/g, out: "[path]" },
  // ⑩ Windows 盘符绝对路径 / UNC（尾随 \\S* 吃满令牌——N9：超长路径不再泄漏尾段）
  { re: /[A-Za-z]:\\[^\s"<>|]{1,255}\S*/g, out: "[path]" },
  { re: /\\\\[\w.-]{1,255}\\[^\s"]{1,255}\S*/g, out: "[path]" },
];

/** PEM 整块/截断遮蔽（3b2c-B6：线性扫描器，替代旧正则①②）。
 *  语义与旧①②一致：BEGIN+END（标签合法 [A-Z0-9 ]{1,255}，两标签可不同）→[secret]；
 *  只有 BEGIN 无后续合法 END→[truncated-secret] 遮到末尾（正文不泄漏）。
 *  线性性：indexOf 单调推进——每个 BEGIN 只向右找第一个合法 END，找不到即终止整个扫描
 *  （旧正则每起点重扫剩余后缀，重复 BEGIN 无 END 输入 O(n²)，实测 512KiB≈5.7s）。 */
function maskPem(s: string): string {
  const BEGIN = "-----BEGIN ";
  let out = "";
  let pos = 0;
  for (;;) {
    const b = s.indexOf(BEGIN, pos);
    if (b < 0) return out + s.slice(pos);
    const labelStart = b + BEGIN.length;
    const labelEnd = s.indexOf("-----", labelStart);
    const labelOk =
      labelEnd >= 0 && labelEnd - labelStart >= 1 && labelEnd - labelStart <= 255 &&
      /^[A-Z0-9 ]+$/.test(s.slice(labelStart, labelEnd));
    if (!labelOk) { // 非 PEM 开始（标签非法）——原样透出，从下一字符继续（单调推进）
      out += s.slice(pos, labelStart);
      pos = labelStart;
      continue;
    }
    // 找第一个合法 END（标签可不同于 BEGIN——与旧正则惰性语义一致：最近者胜）
    let e = labelEnd;
    for (;;) {
      e = s.indexOf("-----END ", e);
      if (e < 0) { // 无 END：截断 PEM → 遮到末尾（规则②）
        out += s.slice(pos, b) + "[truncated-secret]";
        return out;
      }
      const eLabelStart = e + "-----END ".length;
      const eLabelEnd = s.indexOf("-----", eLabelStart);
      const eLabelOk =
        eLabelEnd >= 0 && eLabelEnd - eLabelStart >= 1 && eLabelEnd - eLabelStart <= 255 &&
        /^[A-Z0-9 ]+$/.test(s.slice(eLabelStart, eLabelEnd));
      if (eLabelOk) {
        out += s.slice(pos, b) + "[secret]";
        pos = eLabelEnd + 5;
        break;
      }
      e = eLabelStart; // 非法 END 标签→跳过继续向右（单调推进）
    }
  }
}

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
  // 形态替换（PEM 线性扫描器先行——旧①②；单轮全局即够：替换输出 [xxx] 形态不再匹配任何规则）
  s = maskPem(s);
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
  s = maskPem(s);
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
