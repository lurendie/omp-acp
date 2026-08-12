#!/usr/bin/env node
// ACP handshake test: spawns `omp acp` and performs the initialize round-trip
// (Agent Client Protocol v2). Verifies the agent advertises session support.
//
// Usage: node acp-handshake.cjs [-omp <path>] [--timeout <ms>]
"use strict";

const { spawn } = require("child_process");

const args = process.argv.slice(2);
const omp = args[args.indexOf("-omp") + 1] || "omp";
const ti = args.indexOf("--timeout");
const timeoutMs = Number(ti >= 0 ? args[ti + 1] : 15000);

const child = spawn(omp, ["acp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let buf = "";
const frames = [];
let settled = false;

child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      console.error("[acp-handshake] non-JSON frame:", line.slice(0, 200));
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[omp-acp] " + d));
child.on("exit", (code) => {
  if (!settled) {
    console.error(`FAIL: omp acp exited early with code ${code}`);
    process.exit(1);
  }
});

const timer = setTimeout(() => {
  if (!settled) {
    console.error(`FAIL: ACP initialize timed out after ${timeoutMs}ms`);
    child.kill();
    process.exit(1);
  }
}, timeoutMs);

// ACP v2 initialize — the client (Zed) always sends this first.
setTimeout(() => {
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 2,
        capabilities: {},
        info: { name: "omp-acp-installer", title: "OMP ACP Installer", version: "0.1.0" },
      },
    }) + "\n"
  );
}, 800);

function poll() {
  for (const f of frames) {
    if (f.id === 1 && f.result) {
      settled = true;
      clearTimeout(timer);
      const r = f.result;
      const info = r.agentInfo || r.info || {};
      const caps = r.agentCapabilities || r.capabilities || {};
      const okVersion = r.protocolVersion === 1 || r.protocolVersion === 2;
      const okSession = !!(caps.session || caps.sessionCapabilities);
      console.log(`agent: ${info.name} ${info.version} (protocolVersion ${r.protocolVersion})`);
      console.log(`session capability: ${okSession ? "yes" : "NO"}`);
      console.log(`authMethods: ${JSON.stringify(r.authMethods || [])}`);
      child.stdin.end();
      setTimeout(() => process.exit(okVersion && okSession ? 0 : 1), 300);
      return;
    }
    if (f.id === 1 && f.error) {
      settled = true;
      clearTimeout(timer);
      console.error("FAIL: initialize error:", JSON.stringify(f.error));
      child.stdin.end();
      setTimeout(() => process.exit(1), 300);
      return;
    }
  }
  setTimeout(poll, 100);
}
poll();
