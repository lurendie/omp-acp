#!/usr/bin/env node
// Bridge smoke test: drives bridge/server.mjs as an MCP client and exercises
// initialize -> tools/list -> omp_status -> omp_run -> omp_continue -> shutdown
// against a real `omp --mode rpc` child.
//
// Usage: node test/bridge-smoke.mjs [--omp <path>] [--task <text>] [--timeout-ms <n>]
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const OMP = opt("--omp", process.env.OMP_PATH || "omp");
const TASK = opt("--task", "只回复三个字：连接正常。不要使用任何工具。");
const RUN_TIMEOUT = Number(opt("--timeout-ms", "180000"));

const bridge = path.join(__dirname, "..", "bridge", "server.cjs");
const child = spawn(process.execPath, [bridge], {
  cwd: __dirname,
  env: {
    ...process.env,
    OMP_ZED_CFG: JSON.stringify({ ompPath: OMP, autoConfirm: true, timeoutMs: RUN_TIMEOUT }),
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let nextId = 1;
const pending = new Map();
const progressNotes = [];

const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error("BAD FRAME:", line.slice(0, 200));
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject, label } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${label}: ${msg.error.message}`));
    else resolve(msg.result);
  } else if (msg.method === "notifications/progress") {
    progressNotes.push(msg.params.message);
  }
});
child.stderr.on("data", (d) => process.stderr.write(d));
child.on("exit", (code) => {
  if (code !== 0) console.error(`bridge exited with code ${code}`);
});

function call(method, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
      label: method,
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const started = Date.now();

  console.log(`[1] initialize (omp=${OMP})`);
  const init = await call("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "omp-mcp-smoke", version: "0.1.0" },
  });
  check("serverInfo.name === omp-mcp", init.serverInfo && init.serverInfo.name === "omp-mcp", JSON.stringify(init.serverInfo));
  check("tools capability", !!(init.capabilities && init.capabilities.tools));
  notify("notifications/initialized", {});

  console.log("[2] tools/list");
  const tools = await call("tools/list", {});
  const names = tools.tools.map((t) => t.name);
  check(">= 5 tools", names.length >= 5, names.join(","));
  for (const n of ["omp_status", "omp_run", "omp_continue", "omp_abort", "omp_models", "omp_sessions"]) {
    check(`tool ${n}`, names.includes(n));
  }

  console.log("[3] prompts/list");
  const prompts = await call("prompts/list", {});
  check("omp-run prompt", prompts.prompts.some((p) => p.name === "omp-run"));
  check("omp-continue prompt", prompts.prompts.some((p) => p.name === "omp-continue"));

  console.log("[4] tools/call omp_status");
  const status = await call("tools/call", { name: "omp_status", arguments: {} });
  const statusText = status.content.map((c) => c.text).join("");
  const statusJson = JSON.parse(statusText);
  check("status has model", !!statusJson.model && !!statusJson.model.id, statusText.slice(0, 200));
  check("status has version", typeof statusJson.version === "string");
  check("status has contextUsage", !!statusJson.contextUsage);

  console.log(`[5] tools/call omp_run (timeout ${RUN_TIMEOUT}ms)`);
  const run = await call("tools/call", {
    name: "omp_run",
    arguments: {
      task: TASK,
      sessionMode: "fresh",
      autoConfirm: true,
      timeoutMs: RUN_TIMEOUT,
      _meta: { progressToken: "smoke-run" },
    },
  });
  const runText = run.content.map((c) => c.text).join("");
  check("run returned text", runText.trim().length > 0, `text=${JSON.stringify(runText.slice(0, 120))}`);
  check("run structured.status === done", run.structuredContent && run.structuredContent.status === "done", JSON.stringify(run.structuredContent));
  check("progress notifications seen", progressNotes.length > 0, `notes=${progressNotes.length}`);
  console.log(`      omp_run result (${run.structuredContent?.durationMs ?? "?"}ms): ${runText.trim().slice(0, 200)}`);

  console.log("[6] tools/call omp_continue (switch only)");
  const cont = await call("tools/call", { name: "omp_continue", arguments: {} });
  const contText = cont.content.map((c) => c.text).join("");
  check("continue returned session path", /\.jsonl/.test(contText), contText.slice(0, 200));

  console.log("[6b] tools/call omp_run with image attachment");
  const imgPath = path.join(__dirname, "pixel.png");
  require("fs").writeFileSync(
    imgPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    )
  );
  const runImg = await call("tools/call", {
    name: "omp_run",
    arguments: {
      task: "只用一句话回复：收到图片。不要使用任何工具。",
      images: [imgPath],
      sessionMode: "fresh",
      autoConfirm: true,
      timeoutMs: RUN_TIMEOUT,
    },
  });
  const runImgText = runImg.content.map((c) => c.text).join("");
  check("image run returned text", runImgText.trim().length > 0, `text=${JSON.stringify(runImgText.slice(0, 120))}`);
  check("image run status done", runImg.structuredContent && runImg.structuredContent.status === "done", JSON.stringify(runImg.structuredContent));
  console.log(`      image omp_run result (${runImg.structuredContent?.durationMs ?? "?"}ms): ${runImgText.trim().slice(0, 120)}`);

  console.log("[7] tools/call omp_sessions");
  const sessions = await call("tools/call", { name: "omp_sessions", arguments: { limit: 5 } });
  check("sessions listed", sessions.structuredContent && sessions.structuredContent.count > 0, JSON.stringify(sessions.structuredContent).slice(0, 120));

  console.log("[8] shutdown");
  await call("shutdown", {});

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE TEST ERROR:", e.message);
  process.exit(1);
});
