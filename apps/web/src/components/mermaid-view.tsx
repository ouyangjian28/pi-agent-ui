import React from "react";

// MM v1 is a tiny text grammar, NOT the Mermaid JS/HTML engine. Unsupported
// syntax is atomic/lossless. All work shares MarkdownView's existing budget.
// Local caps may only tighten that budget, never grant a second allowance.
const MAX_NODES = 64;
const MAX_EDGES = 128;
const MAX_LABEL = 512;
const MAX_LINE = 4096;
const MAX_DEPTH = 8;
const MAX_DIMENSION = 16_000;
const MAX_AREA = 8_000_000;
type Budget = { elements: number; scans: number; literal: boolean };
type Shape = "rect" | "diamond" | "circle";
type Node = { id: string; label: string; shape: Shape };
type Edge = { from: number; to: number; label: string };
type Graph = { direction: "TD" | "LR"; nodes: Node[]; edges: Edge[]; ignored: string[] };
type Label = { lines: string[]; width: number; height: number };
type Positioned = Node & { x: number; y: number; width: number; height: number; text: Label };
type Routed = Edge & { path: string; arrow: string; x: number; y: number; text: Label };
type Diagram = { nodes: Positioned[]; edges: Routed[]; width: number; height: number; ignored: string[] };
const unsupported = "Mermaid 语法损坏或暂不支持，整块按原文显示（仅 graph/flowchart TD/LR、[] / {} / (())、--> 及边标签；subgraph 等未实现）。";
const limited = "Mermaid 已达预算，整块按原文显示（最多 64 节点 / 128 边 / 标签 512 字符 / 每行 4,096 字符 / 深度 8，且共享解析及布局预算）。";

function parse(source: string): Graph | string {
  if (source.split(/\r?\n/).some((line) => line.length > MAX_LINE)) return limited;
  const header = /^\s*(?:graph|flowchart)[ \t]+(TD|LR)[ \t]*(?=;|\r?\n|$)/.exec(source);
  if (!header) return unsupported;
  const graph: Graph = { direction: header[1] as "TD" | "LR", nodes: [], edges: [], ignored: [] };
  const ids = new Map<string, number>(); // __proto__/constructor are ordinary IDs.
  const identifier = /[A-Za-z_][A-Za-z_0-9]*/y;
  let pos = header[0].length;
  let error = unsupported;
  const spaces = () => { while (source[pos] === " " || source[pos] === "\t") pos++; };
  const label = (open: string, close: string): string | null => {
    pos += open.length;
    const start = pos;
    // A quoted node label can contain delimiter spelling as ordinary text.
    if (source[pos] === '"') {
      pos++;
      while (pos < source.length && source[pos] !== '"' && source[pos] !== "\n" && source[pos] !== "\r") pos++;
      if (source[pos] !== '"' || !source.startsWith(close, pos + 1)) return null;
      const value = source.slice(start + 1, pos);
      pos += 1 + close.length;
      if (value.length > MAX_LABEL) { error = limited; return null; }
      return value;
    }
    let depth = open.length;
    for (; pos < source.length; pos++) {
      const char = source[pos]!;
      if (char === "\n" || char === "\r") return null;
      if (char === open[0]) depth++;
      if (depth > MAX_DEPTH) { error = limited; return null; }
      if (char === close[0]) {
        depth--;
        if (depth === 0) {
          const end = pos + 1 - close.length;
          if (!source.startsWith(close, end)) return null;
          const value = source.slice(start, end);
          pos++;
          if (value.length > MAX_LABEL) { error = limited; return null; }
          return value;
        }
      }
      if (pos - start > MAX_LABEL + close.length) { error = limited; return null; }
    }
    return null;
  };
  const node = (): number | null => {
    spaces();
    identifier.lastIndex = pos;
    const match = identifier.exec(source);
    if (!match) return null;
    const id = match[0];
    pos = identifier.lastIndex;
    spaces();
    let value: string | null = id;
    let shape: Shape = "rect";
    let defined = true;
    if (source[pos] === "[") value = label("[", "]");
    else if (source[pos] === "{") { shape = "diamond"; value = label("{", "}"); }
    else if (source.startsWith("((", pos)) { shape = "circle"; value = label("((", "))"); }
    else defined = false;
    if (value === null) return null;
    if (value.length > MAX_LABEL) { error = limited; return null; }
    const index = ids.get(id);
    if (index !== undefined) {
      if (defined) graph.nodes[index] = { id, label: value, shape };
      return index;
    }
    if (graph.nodes.length >= MAX_NODES) { error = limited; return null; }
    ids.set(id, graph.nodes.length);
    graph.nodes.push({ id, label: value, shape });
    return graph.nodes.length - 1;
  };
  while (pos < source.length) {
    while (/[ \t\r\n;]/.test(source[pos] ?? "") && pos < source.length) pos++;
    if (pos >= source.length) break;
    if (source.startsWith("click", pos) && /[ \t\r\n;]/.test(source[pos + 5] ?? "\n")) {
      // click has NO executable representation. Preserve the exact physical
      // line (including indent/CRLF), show a note, and render only safe grammar.
      const start = source.lastIndexOf("\n", pos - 1) + 1;
      const end = source.indexOf("\n", pos);
      graph.ignored.push(source.slice(start, end < 0 ? source.length : end + 1));
      pos = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("subgraph", pos)) return unsupported;
    let from = node();
    if (from === null) return error;
    spaces();
    while (source.startsWith("-->", pos)) {
      pos += 3;
      spaces();
      let text = "";
      if (source[pos] === "|") {
        pos++;
        const start = pos;
        while (pos < source.length && source[pos] !== "|" && source[pos] !== "\r" && source[pos] !== "\n") pos++;
        if (source[pos] !== "|") return unsupported;
        text = source.slice(start, pos++);
        if (text.length > MAX_LABEL) return limited;
      }
      const to = node();
      if (to === null) return error;
      if (graph.edges.length >= MAX_EDGES) return limited;
      graph.edges.push({ from, to, label: text });
      from = to;
      spaces();
    }
    if (pos < source.length && !/[;\r\n]/.test(source[pos]!)) return unsupported;
  }
  return graph.nodes.length ? graph : unsupported;
}

// Conservative per-codepoint width (14px) plus padding; no DOM measuring,
// fonts/network, recursion, relaxation loops or quadratic graph solver.
function textBox(value: string): Label {
  const chars = Array.from(value);
  const lines: string[] = [];
  for (let i = 0; i < chars.length; i += 22) lines.push(chars.slice(i, i + 22).join(""));
  if (!lines.length) lines.push("");
  return { lines, width: Math.min(22, chars.length) * 14, height: lines.length * 20 };
}

function layout(graph: Graph, budget: Budget): Diagram | string {
  // Declaration order = one node per layer, TD rows / LR columns. Adjacent
  // forward edges use the central gap; all other edges (including cycles and
  // self loops) get a distinct exterior lane. No nodes/edges are silently cut.
  budget.scans -= graph.nodes.length * graph.edges.length + 8 * (graph.nodes.length + graph.edges.length);
  if (budget.scans < 0) return limited;
  const nodes: Positioned[] = graph.nodes.map((node) => {
    const text = textBox(node.label);
    let width = Math.max(88, text.width + 36);
    let height = Math.max(56, text.height + 28);
    if (node.shape === "diamond") { width *= 2; height *= 2; }
    if (node.shape === "circle") width = height = Math.ceil(Math.hypot(text.width, text.height)) + 36;
    return { ...node, text, width, height, x: 0, y: 0 };
  });
  const td = graph.direction === "TD";
  const maxWidth = Math.max(...nodes.map((node) => node.width));
  const maxHeight = Math.max(...nodes.map((node) => node.height));
  const labels = graph.edges.map((edge) => textBox(edge.label));
  const labelWidth = Math.max(0, ...labels.map((text) => text.width));
  const labelHeight = Math.max(0, ...labels.map((text) => text.height));
  const gap = Math.max(84, (td ? labelHeight : labelWidth) + 40);
  const primary = td ? maxHeight : maxWidth;
  const secondary = td ? maxWidth : maxHeight;
  const pad = 28;
  const laneSize = Math.max(48, (td ? labelWidth : labelHeight) + 24);
  nodes.forEach((node, index) => {
    node.x = td ? pad + maxWidth / 2 : pad + maxWidth / 2 + index * (primary + gap);
    node.y = td ? pad + maxHeight / 2 + index * (primary + gap) : pad + maxHeight / 2;
  });
  let lanes = 0;
  const directPairs = new Set<string>();
  const edges: Routed[] = graph.edges.map((edge, index) => {
    const from = nodes[edge.from]!;
    const to = nodes[edge.to]!;
    const text = labels[index]!;
    const pair = `${edge.from}:${edge.to}`;
    const direct = edge.to === edge.from + 1 && !directPairs.has(pair);
    directPairs.add(pair);
    let path: string;
    let x: number;
    let y: number;
    let ex: number;
    let ey: number;
    if (direct) {
      const sx = td ? from.x : from.x + from.width / 2;
      const sy = td ? from.y + from.height / 2 : from.y;
      ex = td ? to.x : to.x - to.width / 2;
      ey = td ? to.y - to.height / 2 : to.y;
      path = `M ${sx} ${sy} L ${ex} ${ey}`;
      x = (sx + ex) / 2;
      y = (sy + ey) / 2;
    } else {
      const lane = pad + secondary + laneSize * (++lanes);
      if (td) {
        const sy = from.y;
        // A self-loop returns to the node's top, not its own start point.
        ey = edge.from === edge.to ? to.y - to.height / 2 : to.y;
        ex = edge.from === edge.to ? to.x : to.x + to.width / 2;
        path = `M ${from.x + from.width / 2} ${sy} H ${lane} V ${edge.from === edge.to ? ey - 16 : ey} H ${ex}${edge.from === edge.to ? ` V ${ey}` : ""}`;
        x = lane;
        y = edge.from === edge.to ? (sy + ey - 16) / 2 : (sy + ey) / 2;
      } else {
        ex = edge.from === edge.to ? to.x - to.width / 2 : to.x;
        ey = edge.from === edge.to ? to.y : to.y + to.height / 2;
        path = `M ${from.x} ${from.y + from.height / 2} V ${lane} H ${edge.from === edge.to ? ex - 16 : ex} V ${ey}${edge.from === edge.to ? ` H ${ex}` : ""}`;
        x = edge.from === edge.to ? (from.x + ex - 16) / 2 : (from.x + ex) / 2;
        y = lane;
      }
    }
    // Arrowheads are local polygon geometry, not URL-based SVG markers/IDs.
    const vertical = (td && direct) || (td && edge.from === edge.to) || (!td && !direct && edge.from !== edge.to);
    const arrow = vertical
      ? `${ex},${ey} ${ex - 4},${ey + (td ? -8 : 8)} ${ex + 4},${ey + (td ? -8 : 8)}`
      : `${ex},${ey} ${ex + (td ? 8 : -8)},${ey - 4} ${ex + (td ? 8 : -8)},${ey + 4}`;
    return { ...edge, path, arrow, x, y, text };
  });
  const long = pad * 2 + nodes.length * primary + (nodes.length - 1) * gap;
  const wide = pad * 2 + secondary + lanes * laneSize + (lanes ? laneSize / 2 : 0);
  const width = td ? Math.max(wide, labelWidth + pad * 2) : long;
  const height = td ? long : Math.max(wide, labelHeight + pad * 2);
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_AREA) return limited;
  const elements = 2 + nodes.reduce((sum, node) => sum + 3 + node.text.lines.length, 0)
    + edges.reduce((sum, edge) => sum + 3 + (edge.label ? 3 + edge.text.lines.length : 0), 0)
    + (graph.ignored.length ? 2 : 0);
  if (elements + 2 > budget.elements) return limited;
  budget.elements -= elements;
  return { nodes, edges, width, height, ignored: graph.ignored };
}

function Text({ box, x = 0, y = 0 }: { box: Label; x?: number; y?: number }) {
  return <text x={x} y={y} textAnchor="middle">{box.lines.map((line, index) => <tspan key={index} x={x} y={y + (index - (box.lines.length - 1) / 2) * 20 + 5}>{line}</tspan>)}</text>;
}

function MermaidView({ diagram }: { diagram: Diagram }) {
  return <>
    <div className="markdown-mermaid-wrap" role="region" aria-label="Mermaid 流程图，可在容器内滚动" tabIndex={0}>
      <svg className="markdown-mermaid" role="img" aria-label="Mermaid 流程图" width={diagram.width} height={diagram.height} viewBox={`0 0 ${diagram.width} ${diagram.height}`}>
        {diagram.edges.map((edge, index) => <g className="mermaid-edge" key={index}>
          <path d={edge.path} />
          <polygon points={edge.arrow} />
        </g>)}
        {/* Labels paint after ALL edges so crossing paths cannot strike text. */}
        {diagram.edges.map((edge, index) => edge.label ? <g className="mermaid-edge-text" key={index}>
          <rect className="mermaid-edge-label" x={edge.x - edge.text.width / 2 - 6} y={edge.y - edge.text.height / 2 - 3} width={edge.text.width + 12} height={edge.text.height + 6} rx={3} />
          <Text box={edge.text} x={edge.x} y={edge.y} />
        </g> : null)}
        {diagram.nodes.map((node) => <g className="mermaid-node" key={node.id} transform={`translate(${node.x} ${node.y})`}>
          {node.shape === "circle" ? <circle r={node.width / 2} /> : node.shape === "diamond"
            ? <polygon points={`0,${-node.height / 2} ${node.width / 2},0 0,${node.height / 2} ${-node.width / 2},0`} />
            : <rect x={-node.width / 2} y={-node.height / 2} width={node.width} height={node.height} rx={6} />}
          <Text box={node.text} />
        </g>)}
      </svg>
    </div>
    {diagram.ignored.length ? <>
      <p className="markdown-limit" role="note">Mermaid click 交互指令未实现，仅保留原字，不解析、不执行。</p>
      <p className="markdown-literal">{diagram.ignored.join("")}</p>
    </> : null}
  </>;
}

export function mermaidBlock(source: string, original: string, budget: Budget): React.ReactNode {
  // Charge a conservative 16 full passes BEFORE tokenization/text wrapping.
  // This covers the bounded lexer, line/label copies, click-line lookups,
  // geometry generation and text sizing; layout additionally charges N*E.
  budget.scans -= source.length * 16;
  const graph = budget.scans < 0 ? limited : parse(source);
  const diagram = typeof graph === "string" ? graph : layout(graph, budget);
  if (typeof diagram === "string") {
    budget.elements -= 2;
    return <><p className="markdown-literal">{original}</p><p className="markdown-limit" role="note">{diagram}</p></>;
  }
  return <MermaidView diagram={diagram} />;
}
