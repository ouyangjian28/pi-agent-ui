import React from "react";

// Deliberately not CommonMark: I3-MD core + bounded GFM pipe tables, never HTML or remote embeds.
// Bounds apply BEFORE parsing: 100 Ki UTF-16 units/message block, 2,000 lines,
// 4,096 units/inline line (longer lines stay literal), 4,000 elements, depth 8,
// and 2M scanned units. This also bounds adversarial delimiter/streaming frames.
const MAX_CHARS = 100 * 1024;
const MAX_LINES = 2_000;
const MAX_INLINE = 4_096;
const MAX_DEPTH = 8;
// TB-MD: <=32 columns / <=500 data rows; the existing global budgets still win.
// Physical table lines also obey MAX_INLINE (not a fresh allowance per cell).
const MAX_TABLE_COLUMNS = 32;
const MAX_TABLE_ROWS = 500;

type Budget = { elements: number; scans: number; literal: boolean };
type Line = { raw: string; text: string };
type ListMarker = { indent: number; ordered: boolean; start: number; body: string };

function listMarker(text: string): ListMarker | null {
  const match = /^([ \t]*)([-+*]|\d{1,9}\.)[ \t]+(.*)$/.exec(text);
  if (!match) return null;
  return {
    indent: match[1]!.replace(/\t/g, "    ").length,
    ordered: match[2]!.endsWith("."),
    start: Number.parseInt(match[2]!, 10),
    body: match[3]!,
  };
}

function safeHref(href: string): boolean {
  // Check the ORIGINAL spelling: no browser whitespace/control normalization,
  // entity decoding, relative URLs, protocol-relative URLs, or protocol guessing.
  if (!/^https?:\/\//i.test(href) || /[\s\u0000-\u001f\u007f]/.test(href)) return false;
  try {
    const url = new URL(href);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

function inline(text: string, budget: Budget, depth = 0, links = true): React.ReactNode[] {
  if (text.length > MAX_INLINE || depth >= MAX_DEPTH || budget.literal) return [text];
  const nodes: React.ReactNode[] = [];
  let plain = "";
  const flush = () => {
    if (plain) nodes.push(plain);
    plain = "";
  };
  // Charge the full possible suffix BEFORE every search (a conservative upper bound).
  const find = (needle: string, start: number): number => {
    budget.scans -= text.length - start;
    if (budget.scans < 0) {
      budget.literal = true;
      return -1;
    }
    return text.indexOf(needle, start);
  };
  const closingTicks = (width: number, start: number): number => {
    let pos = start;
    while (pos < text.length) {
      const next = find("`", pos);
      if (next < 0) return -1;
      let end = next + 1;
      while (text[end] === "`") end++;
      if (end - next === width) return next;
      pos = end;
    }
    return -1;
  };
  const closingDelimiter = (mark: string, width: number, start: number): number => {
    let pos = start;
    while (pos < text.length) {
      const next = find(mark, pos);
      if (next < 0) return -1;
      // A delimiter inside a complete code span cannot close emphasis.
      const tick = find("`", pos);
      if (tick >= 0 && tick < next) {
        let tickEnd = tick + 1;
        while (text[tickEnd] === "`") tickEnd++;
        const width = tickEnd - tick;
        const end = closingTicks(width, tickEnd);
        if (end < 0) return -1;
        pos = end + width;
        continue;
      }
      let end = next + 1;
      while (text[end] === mark) end++;
      const run = end - next;
      if (run <= 3 && (run === width || (run === 3 && width < 3))) return end - width;
      pos = end;
    }
    return -1;
  };

  for (let i = 0; i < text.length;) {
    if (budget.elements <= 0 || budget.literal) {
      budget.literal = true;
      plain += text.slice(i);
      break;
    }
    const char = text[i]!;
    if (char === "`") {
      let runEnd = i + 1;
      while (text[runEnd] === "`") runEnd++;
      const width = runEnd - i;
      const end = closingTicks(width, runEnd);
      // Unsupported multi-backtick spans stay wholly literal, including content.
      if (width !== 1) {
        const next = end < 0 ? text.length : end + width;
        plain += text.slice(i, next);
        i = next;
        continue;
      }
      if (end < 0) {
        plain += text.slice(i); // A half-open streaming span stays entirely literal.
        break;
      }
      flush();
      budget.elements--;
      nodes.push(<code key={`code-${i}`}>{text.slice(i + 1, end)}</code>);
      i = end + 1;
      continue;
    }
    if ((char === "[" && links) || (char === "!" && text[i + 1] === "[")) {
      const image = char === "!";
      const labelStart = i + (image ? 2 : 1);
      const labelEnd = find("](", labelStart);
      if (labelEnd >= 0) {
        let end = labelEnd + 2;
        let balance = 1;
        // Balanced parentheses keep e.g. javascript:alert(1) wholly literal.
        while (end < text.length && balance > 0) {
          if (--budget.scans < 0) {
            budget.literal = true;
            break;
          }
          if (text[end] === "(") balance++;
          if (text[end] === ")") balance--;
          end++;
        }
        if (balance === 0) {
          const href = text.slice(labelEnd + 2, end - 1);
          if (!image && safeHref(href)) {
            flush();
            budget.elements--;
            nodes.push(<a key={`link-${i}`} href={href} target="_blank" rel="noopener noreferrer">{inline(text.slice(labelStart, labelEnd), budget, depth + 1, false)}</a>);
          } else {
            plain += text.slice(i, end);
          }
          i = end;
          continue;
        }
      }
    }
    if (char === "*" || char === "_") {
      let end = i + 1;
      while (text[end] === char) end++;
      const width = end - i;
      // Do not interpret underscores in identifiers, or four-plus-marker runs.
      const inWord = char === "_" && /[\p{L}\p{N}]/u.test(text[i - 1] ?? "");
      if (width <= 3 && !inWord && text[end] !== undefined && !/\s/.test(text[end]!)) {
        const close = closingDelimiter(char, width, end);
        if (close > end && !/\s/.test(text[close - 1]!)) {
          flush();
          budget.elements -= width === 3 ? 2 : 1;
          const content = inline(text.slice(end, close), budget, depth + 1, links);
          nodes.push(width === 3 ? <strong key={`em-${i}`}><em>{content}</em></strong> : width === 2 ? <strong key={`em-${i}`}>{content}</strong> : <em key={`em-${i}`}>{content}</em>);
          i = close + width;
          continue;
        }
      }
      plain += text.slice(i, end);
      i = end;
      continue;
    }
    plain += char;
    i++;
  }
  flush();
  return nodes;
}

// The info token must be NONEMPTY when present: two adjacent whitespace stars
// around an empty token would backtrack quadratically on "```" + spaces + "!".
const fenceOpen = (text: string) => /^ {0,3}(`{3,})[ \t]*(?:([\w+#.-]+)[ \t]*)?$/.exec(text);
const heading = (text: string) => /^ {0,3}(#{1,3})[ \t]+(.+)$/.exec(text);

type TableRow = { cells: string[]; complete: boolean; limited: boolean };
type Alignment = "left" | "center" | "right" | undefined;

function tableRow(text: string, budget: Budget): TableRow {
  // Charge four full passes: candidate lookup, splitting, trim, validation.
  budget.scans -= text.length * 4;
  if (budget.scans < 0) budget.literal = true;
  if (text.length > MAX_INLINE || budget.literal) return { cells: [], complete: false, limited: true };
  const source = text.trim();
  const cells: string[] = [];
  let cell = "";
  let ticks = 0;
  let lastPipe = -1;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\" && i + 1 < source.length) {
      const next = source[++i]!;
      // Only table-specific escaped pipes are decoded. Other spelling is intact.
      cell += next === "|" ? "|" : "\\" + next;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      lastPipe = i;
      if (cells.length > MAX_TABLE_COLUMNS + 1) return { cells: [], complete: false, limited: true };
    } else if (char === "`") {
      let end = i + 1;
      while (source[end] === "`") end++;
      const width = end - i;
      if (ticks === 0) ticks = width;
      else if (ticks === width) ticks = 0;
      cell += source.slice(i, end);
      i = end - 1;
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  const leading = source.startsWith("|");
  const trailing = lastPipe === source.length - 1;
  if (leading) cells.shift();
  if (trailing) cells.pop();
  // Conservative streaming subset: framed rows beginning with | require a
  // closing |, and every row must match the header exactly. No padding/dropping.
  // Unframed A | B rows are supported; a same-width unfinished last cell without
  // outer pipes is indistinguishable from valid GFM, so its available text stays.
  return { cells, complete: (!leading || trailing) && ticks === 0, limited: cells.length > MAX_TABLE_COLUMNS };
}

function blocks(lines: Line[], budget: Budget): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const raw = (start: number, end = lines.length) => lines.slice(start, end).map((line) => line.raw).join("");
  const isTableStart = (index: number) => {
    const text = lines[index]!.text;
    // A leading outer pipe is an explicit (possibly half-open) candidate.
    // Unframed prose/code/links containing | retain the old inline semantics
    // unless a separator-shaped following line establishes table intent.
    const next = lines[index + 1]?.text ?? "";
    return text.trimStart().startsWith("|") || (text.includes("|") && next.includes("|") && (next.length > MAX_INLINE || /^[ \t:|\-]+$/.test(next)));
  };
  const isBlock = (index: number) => {
    const text = lines[index]!.text;
    const marker = listMarker(text);
    return fenceOpen(text) !== null || heading(text) !== null || (marker !== null && marker.indent <= 3) || isTableStart(index);
  };
  function table(start: number): { node: React.ReactNode; next: number } {
    let end = start + 1;
    // Scan the entire contiguous candidate even after a local limit so fallback
    // preserves original whitespace/escapes/extra columns and doesn't parse tails.
    while (end < lines.length && lines[end]!.text.includes("|") && !fenceOpen(lines[end]!.text) && !heading(lines[end]!.text) && !listMarker(lines[end]!.text)) end++;
    const literal = (limited = false) => ({
      node: <React.Fragment key={`table-${start}`}>
        <p className="markdown-literal">{raw(start, end)}</p>
        {limited && !budget.literal ? <p className="markdown-limit" role="note">表格过大，按纯文本显示（最多 32 列 / 500 数据行 / 每行 4,096 字符）。</p> : null}
      </React.Fragment>, next: end,
    });
    if (end - start - 2 > MAX_TABLE_ROWS) {
      budget.elements -= 2;
      return literal(true);
    }
    const rows = lines.slice(start, end).map((line) => tableRow(line.text, budget));
    const header = rows[0]!;
    if (rows.some((row) => row.limited)) {
      budget.elements -= 2;
      return literal(true);
    }
    if (rows.length < 2 || header.cells.length === 0 || rows.some((row) => !row.complete || row.cells.length !== header.cells.length)) {
      budget.elements--;
      return literal();
    }
    const separator = rows[1]!.cells;
    if (separator.some((cell) => !/^:?-+:?$/.test(cell))) {
      budget.elements--;
      return literal();
    }
    const align: Alignment[] = separator.map((cell) => cell.startsWith(":") ? (cell.endsWith(":") ? "center" : "left") : cell.endsWith(":") ? "right" : undefined);
    const data = [header, ...rows.slice(2)];
    // Reserve all wrapper/section/row/cell elements, plus fallback headroom,
    // BEFORE inline rendering. Partial tables are never committed to the tree.
    const elements = 4 + data.length * (1 + header.cells.length);
    if (elements + 2 > budget.elements) {
      budget.literal = true;
      return literal();
    }
    budget.elements -= elements;
    const rendered = data.map((row, rowIndex) => <tr key={rowIndex}>{row.cells.map((cell, column) => rowIndex === 0
      ? <th key={column} scope="col" style={{ textAlign: align[column] }}>{inline(cell, budget)}</th>
      : <td key={column} style={{ textAlign: align[column] }}>{inline(cell, budget)}</td>)}</tr>);
    if (budget.literal || budget.elements <= 0) {
      budget.literal = true;
      return literal();
    }
    return { node: <div className="markdown-table-wrap" role="region" aria-label="Markdown 表格" tabIndex={0} key={`table-${start}`}><table><thead>{rendered[0]}</thead><tbody>{rendered.slice(1)}</tbody></table></div>, next: end };
  }
  // Exactly one nested list level; deeper marker lines remain literal inside li.
  function list(start: number, marker: ListMarker, depth: number): { node: React.ReactNode; next: number } {
    const items: React.ReactNode[] = [];
    let i = start;
    budget.elements--;
    while (i < lines.length && budget.elements > 0 && !budget.literal) {
      const item = listMarker(lines[i]!.text);
      if (!item || item.indent !== marker.indent || item.ordered !== marker.ordered) break;
      const key = i;
      budget.elements--;
      const content = inline(item.body, budget);
      i++;
      while (i < lines.length && budget.elements > 0 && !budget.literal) {
        const nested = listMarker(lines[i]!.text);
        if (!nested || nested.indent <= marker.indent) break;
        if (depth === 0) {
          const result = list(i, nested, 1);
          content.push(result.node);
          i = result.next;
        } else {
          content.push(<span className="markdown-literal" key={i}>{"\n" + lines[i]!.raw}</span>);
          budget.elements--;
          i++;
        }
      }
      items.push(<li key={key}>{content}</li>);
    }
    return {
      node: marker.ordered ? <ol key={`list-${start}`} start={marker.start}>{items}</ol> : <ul key={`list-${start}`}>{items}</ul>,
      next: i,
    };
  }

  for (let i = 0; i < lines.length;) {
    if (budget.elements <= 0 || budget.literal) {
      budget.literal = true;
      nodes.push(<p className="markdown-literal" key={i}>{raw(i)}</p>);
      break;
    }
    const line = lines[i]!;
    const fence = fenceOpen(line.text);
    if (fence) {
      let end = i + 1;
      for (; end < lines.length; end++) {
        const close = /^ {0,3}(`{3,})[ \t]*$/.exec(lines[end]!.text);
        if (close && close[1]!.length >= fence[1]!.length) break;
      }
      if (end === lines.length) {
        nodes.push(<p className="markdown-literal" key={i}>{raw(i)}</p>);
        break;
      }
      budget.elements -= 4;
      nodes.push(<div className="markdown-codeblock" key={i}>
        {fence[2] ? <small className="markdown-language">{fence[2]}</small> : null}
        <pre><code>{raw(i + 1, end)}</code></pre>
      </div>);
      i = end + 1;
      continue;
    }
    const title = heading(line.text);
    if (title) {
      budget.elements--;
      const tag = `h${title[1]!.length}` as "h1" | "h2" | "h3";
      nodes.push(React.createElement(tag, { key: i }, inline(title[2]!, budget)));
      i++;
      continue;
    }
    const marker = listMarker(line.text);
    if (marker && marker.indent <= 3) {
      const result = list(i, marker, 0);
      nodes.push(result.node);
      i = result.next;
      continue;
    }
    if (isTableStart(i)) {
      const result = table(i);
      nodes.push(result.node);
      i = result.next;
      continue;
    }
    const start = i++;
    while (i < lines.length && !isBlock(i)) i++;
    budget.elements--;
    // Parse each physical line independently so malformed/long lines cannot
    // trigger unbounded scans or consume delimiters from a later streaming line.
    const content: React.ReactNode[] = [];
    for (let j = start; j < i; j++) {
      content.push(<React.Fragment key={j}>{inline(lines[j]!.raw, budget)}</React.Fragment>);
    }
    nodes.push(<p key={start}>{content}</p>);
  }
  return nodes;
}

/** Safe, bounded React-only rendering. No HTML parser, DOM injection, or fetch. */
export const MarkdownView = React.memo(function MarkdownView({ text, truncated = false }: { text: string; truncated?: boolean }) {
  let source = text.slice(0, MAX_CHARS);
  // Never split a surrogate pair at the display boundary.
  if (source.length < text.length && /[\ud800-\udbff]/.test(source.at(-1) ?? "")) source = source.slice(0, -1);
  const rawLines = source.split(/(?<=\n)/);
  const lines = rawLines.slice(0, MAX_LINES).map((raw) => ({ raw, text: raw.replace(/\r?\n$/, "") }));
  const clipped = source.length < text.length || rawLines.length > MAX_LINES;
  const budget: Budget = { elements: 4_000, scans: 2_000_000, literal: false };
  const content = blocks(lines, budget);
  return <div className="entry-text markdown-view">
    {content}
    {truncated ? <span aria-label="原文已截断">…</span> : null}
    {clipped ? <p className="markdown-limit" role="note">内容过长，已截断显示（最多 100 Ki 字符 / 2,000 行）。</p> : null}
    {budget.literal ? <p className="markdown-limit" role="note">已达解析预算，剩余内容按纯文本显示。</p> : null}
  </div>;
});
