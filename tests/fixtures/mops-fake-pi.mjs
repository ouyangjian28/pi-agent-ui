#!/usr/bin/env node
// M-OPS E2E 假 pi（tests/fixtures/mops-fake-pi.mjs）——无真 pi 依赖的集成测试替身。
// 模式（env MOPS_FAKE_PI_MODE）：
//   list      --list-models → stdout 固定清单表 exit 0（腿1 ok）
//   listfail  --list-models → stderr 一行 + exit 1（腿1b 失败面）
//   ready     正常 rpc 面壳：捕获 argv → $MOPS_ARGV_FILE；stdin 逐行 demux：
//             {type:"get_state"} → 回 {type:"response",id,success:true}（readiness 探针往返）；
//             其他行忽略；常驻（腿2 尾追+sidecar）
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
}

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
      if (msg?.type === "get_state" && typeof msg.id === "string") {
        process.stdout.write(JSON.stringify({ type: "response", id: msg.id, success: true }) + "\n");
      }
      // 其他帧（prompt/stop 等）：ready 模式不答（turn 不结算——write-ack launched 不依赖 turn 完）
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
