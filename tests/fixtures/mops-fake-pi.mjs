#!/usr/bin/env node
// M-OPS E2E 假 pi（tests/fixtures/mops-fake-pi.mjs）——无真 pi 依赖的集成测试替身。
// 模式（env MOPS_FAKE_PI_MODE）：
//   list      --list-models → stdout 固定清单表 exit 0（腿1 ok）
//   listfail  --list-models → stderr 一行 + exit 1（腿1b 失败面）
//   ready     正常 rpc 面壳：捕获 argv → $MOPS_ARGV_FILE；stdin 逐行 demux：
//             get_state/能力/设置 → 带command和实际配置的0.99形状；prompt不结算，常驻；
//             可经 $MOPS_RPC_FILE 留真实收到的帧+配置快照（仅测试临时目录）。
//   ready-no-facts 配置get_state只有success没有状态事实，验证不假确认。
//   ready-model-mismatch set_model成功回指定模型但实际仍旧值，验证post-state门。
//   exit      捕获 argv；stderr 打「model "nope" not found」+ exit 127（腿3a spawn-exited）
//   timeout   捕获 argv；静默挂起（不回探针——readiness 超时腿）
//   timeout-k 捕获 argv；回探针后就绪但 prompt 命令静默不答（备用：response 超时面）
//   cwd      批A 生产烟测：启动即把 {cwd,argv,pid} 写到 $FAKE_PI_CWD_FILE；探针应答常驻（同 ready）。
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = process.env.MOPS_FAKE_PI_MODE ?? "ready";

if (args.includes("--list-models")) {
  if (mode === "listfail") {
    process.stderr.write("fake-pi: list-models boom (exit 1)\n");
    process.exit(1);
  }
  process.stdout.write(
    [
      "provider  model                   context   thinking",
      "kimi-coding  k3                     262144    yes",
      "kimi-coding  k3-mini                 65536    no",
      "deepseek     deepseek-chat          131072    no",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (process.env.MOPS_ARGV_FILE) appendFileSync(process.env.MOPS_ARGV_FILE, JSON.stringify(args) + "\n");

if (mode === "exit") {
  process.stderr.write('fake-pi: fatal: model "nope" not found in provider registry\n');
  process.exit(127);
}

if (mode === "cwd" && process.env.FAKE_PI_CWD_FILE) {
  appendFileSync(process.env.FAKE_PI_CWD_FILE, JSON.stringify({ cwd: process.cwd(), argv: args, pid: process.pid }) + "\n");
  // 批A-r2：--session 路径上装载最小合法 pi 转录 header（v3 形状——真 SDK SessionManager.open 兼容；
  // GPT P1-A1 建议替身至少装载真转录，烟测腿⑦ 断言面）。
  const sIdx = args.indexOf("--session");
  if (sIdx >= 0 && args[sIdx + 1]) {
    const header = { type: "session", version: 3, id: "00000000-0000-4000-8000-000000000001", timestamp: new Date().toISOString(), cwd: process.cwd() };
    appendFileSync(args[sIdx + 1], JSON.stringify(header) + "\n");
  }
}

const models = [
  { provider: "kimi-coding", id: "k3", name: "Fixture K3", input: ["text", "image"] },
  { provider: "kimi-coding", id: "k3-mini", name: "Fixture K3 Mini", input: ["text"] },
  { provider: "deepseek", id: "deepseek-chat", name: "Fixture Chat", input: ["text"] },
];
const modelIndex = args.lastIndexOf("--model");
const requestedModel = modelIndex < 0 ? undefined : args[modelIndex + 1];
let currentModel = mode === "ready-model-mismatch" ? models[1]
  : models.find(m => `${m.provider}/${m.id}` === requestedModel) ?? models[0];
let thinkingLevel = "off";
const levels = ["off", "low", "medium", "high"];
const state = () => ({ model: currentModel, thinkingLevel, isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
const respond = (msg, success, data) => process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success, ...(data !== undefined ? { data } : {}) }) + "\n");

if (mode === "timeout") {
  setInterval(() => {}, 60_000); // 静默挂起
} else {
  // ready / timeout-k：探针应答常驻
  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (process.env.MOPS_RPC_FILE) appendFileSync(process.env.MOPS_RPC_FILE, JSON.stringify({ msg, state: state(), pid: process.pid }) + "\n");
      if (typeof msg?.id !== "string") continue;
      switch (msg.type) {
        case "get_state":
          respond(msg, true, mode === "ready-no-facts" && msg.id.startsWith("cfg-") ? undefined : state());
          break;
        case "get_available_models": respond(msg, true, { models }); break;
        case "get_available_thinking_levels": respond(msg, true, { levels }); break;
        case "set_model": {
          const selected = models.find(m => m.provider === msg.provider && m.id === msg.modelId);
          if (selected === undefined) { respond(msg, false); break; }
          if (mode !== "ready-model-mismatch") currentModel = selected;
          respond(msg, true, selected);
          break;
        }
        case "set_thinking_level":
          if (!levels.includes(msg.level)) { respond(msg, false); break; }
          thinkingLevel = msg.level;
          respond(msg, true);
          break;
        // prompt/stop：不答（turn不结算——write-ack launched不依赖turn完），保留原超时语义。
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
