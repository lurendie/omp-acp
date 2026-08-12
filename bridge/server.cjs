#!/usr/bin/env node
// omp-mcp bridge — MCP server (stdio, newline-delimited JSON-RPC) that hosts a
// persistent `omp --mode rpc` child per Zed project and exposes omp as MCP tools
// for the Zed Agent Panel:
//
//   omp_status      session/model/context snapshot
//   omp_run         delegate a task to omp (fresh session, streams progress)
//   omp_continue    switch to the latest omp session and continue it
//   omp_abort       abort the in-flight run
//   omp_models      list models available to omp
//   omp_sessions    list recent omp session files
//
// Spawned by the Zed extension (`context_server_command`) via a `node -e`
// loader. Receives user settings as JSON through OMP_ZED_CFG:
//   { ompPath?, model?, autoConfirm?, timeoutMs?, sessionDir?, bridgePath?, extraArgs? }
// Working directory is the project root; omp runs with --cwd <project root>.
//
// No dependencies — Node >= 18 built-ins only.
"use strict";

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const VERSION = "0.1.0";
const MCP_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEBUG = !!process.env.OMP_ZED_DEBUG;

function dbg(...args) {
  if (DEBUG) console.error("[omp-mcp:dbg]", ...args);
}

function log(...args) {
  console.error("[omp-mcp]", ...args);
}

function main(cfg) {
  cfg = Object.assign(
    { ompPath: "omp", model: null, autoConfirm: false, timeoutMs: DEFAULT_TIMEOUT_MS, sessionDir: null, bridgePath: null, extraArgs: [] },
    cfg || {}
  );
  const projectRoot = process.cwd();
  const sessionDir = () =>
    cfg.sessionDir || path.join(os.homedir(), ".omp", "agent", "sessions");

  // ---------------------------------------------------------------------------
  // omp RPC child
  // ---------------------------------------------------------------------------
  let rpc = null; // child process
  let rpcReady = false;
  let rpcQueue = []; // frames waiting for the ready frame
  const pending = new Map(); // id -> {resolve, reject, timer, command}
  let nextReq = 1;

  function ensureRpc() {
    if (rpc && !rpc.killed) return;
    const args = ["--mode", "rpc", "--cwd", projectRoot];
    if (cfg.model) args.push("--model", cfg.model);
    for (const a of cfg.extraArgs || []) args.push(a);
    rpc = spawn(cfg.ompPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    rpcReady = false;

    let buf = "";
    rpc.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handleRpcFrame(line);
      }
    });
    rpc.stderr.on("data", (d) => log("[omp]", String(d).trim()));
    rpc.on("error", (e) => {
      log("omp spawn failed:", e.message);
      rpc = null;
      rpcReady = false;
      failAll(`omp failed to start: ${e.message}`);
    });
    rpc.on("exit", (code, sig) => {
      log("omp exited:", code ?? sig);
      rpc = null;
      rpcReady = false;
      rpcQueue = [];
      failAll(`omp exited (${code ?? sig})`);
    });
  }

  function sendRpc(msg) {
    dbg("->rpc", JSON.stringify(msg).slice(0, 160));
    if (!rpc || rpc.killed || !rpcReady) {
      rpcQueue.push(msg);
      ensureRpc();
      return;
    }
    rpc.stdin.write(JSON.stringify(msg) + "\n");
  }

  function request(type, payload, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const id = `req_${nextReq++}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, command: type });
      sendRpc({ id, type, ...payload });
    });
  }

  function failAll(err) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(err));
    }
    pending.clear();
    abortActive("error", `omp process lost: ${err}`);
  }

  // ---------------------------------------------------------------------------
  // RPC frame handling
  // ---------------------------------------------------------------------------
  function handleRpcFrame(line) {
    dbg("<-rpc", line.slice(0, 160), `(pending=${pending.size}, active=${!!active})`);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      log("bad frame from omp:", line.slice(0, 200));
      return;
    }

    switch (frame.type) {
      case "ready":
        rpcReady = true;
        while (rpcQueue.length) {
          const msg = rpcQueue.shift();
          if (rpc && !rpc.killed) rpc.stdin.write(JSON.stringify(msg) + "\n");
        }
        break;

      case "response":
        onResponse(frame);
        break;

      case "extension_ui_request":
        onUiRequest(frame);
        break;

      case "host_tool_call": {
        // We never register host tools; reject if omp somehow calls one.
        writeRpcFrame({ type: "host_tool_result", id: frame.id, isError: true, result: { content: [{ type: "text", text: "host tool not available in omp-mcp" }] } });
        break;
      }

      case "extension_error":
        log("extension error:", frame.extensionPath, frame.event, frame.error);
        break;

      // Session/agent lifecycle events — routed to the active run.
      case "agent_start":
        progressActive("agent started");
        break;
      case "agent_end":
        finishActive("done");
        break;
      case "turn_start":
        progressActive("turn started");
        break;
      case "turn_end":
        progressActive("turn ended");
        break;
      case "message_start":
      case "message_end":
      case "auto_compaction_start":
      case "auto_compaction_end":
        break;
      case "message_update":
        onMessageUpdate(frame);
        break;
      case "tool_execution_start":
        onToolEvent(frame, "start");
        break;
      case "tool_execution_update":
        onToolEvent(frame, "update");
        break;
      case "tool_execution_end":
        onToolEvent(frame, "end");
        break;
      case "prompt_result":
        // A scheduled prompt resolved without invoking the agent.
        if (active && !active.done && frame.agentInvoked === false) {
          finishActive("done-local");
        }
        break;
      case "command_output":
      case "session_info_update":
      case "config_update":
      case "available_commands_update":
      case "subagent_lifecycle":
      case "subagent_progress":
      case "subagent_event":
        break;
      default:
        log("unhandled frame type:", frame.type);
    }
  }

  function onResponse(frame) {
    const p = pending.get(frame.id);
    if (!p) {
      log("response for unknown id:", frame.id);
      return;
    }
    pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.success) p.resolve(frame);
    else p.reject(new Error(`${p.command} failed: ${frame.error}`));
  }

  function writeRpcFrame(msg) {
    if (rpc && !rpc.killed) rpc.stdin.write(JSON.stringify(msg) + "\n");
  }

  // ---------------------------------------------------------------------------
  // Active run tracking
  // ---------------------------------------------------------------------------
  let active = null; // {policy, progressToken, text[], thinking[], tools[], timer, finish, aborted}

  function progressActive(message) {
    if (!active) return;
    emitProgress(active, message);
  }

  function emitProgress(run, message) {
    if (!run.progressToken) return;
    run._pAcc = (run._pAcc || 0) + 1;
    const n = run._pAcc;
    const send = () =>
      writeMcp({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: run.progressToken, progress: n, message },
      });
    const now = Date.now();
    if (!run._pLast || now - run._pLast > 100) {
      run._pLast = now;
      send();
    } else if (!run._pTimer) {
      run._pTimer = setTimeout(() => {
        run._pTimer = null;
        if (active === run && !run.done) send();
      }, 120);
    }
  }

  function onMessageUpdate(frame) {
    if (!active) return;
    const ev = frame.assistantMessageEvent || {};
    switch (ev.type) {
      case "text_delta":
        active.text.push(ev.delta || "");
        break;
      case "thinking_delta":
        active.thinking.push(ev.delta || "");
        break;
      default:
        break;
    }
  }

  function onToolEvent(frame, phase) {
    if (!active) return;
    const t = frame.toolCall || frame.toolName || "tool";
    const name = typeof t === "string" ? t : t.name || "tool";
    emitProgress(active, `omp ${phase === "start" ? "▶" : phase === "end" ? "■" : "…"} ${name}`);
  }

  function abortActive(status, message) {
    if (active && !active.done) {
      const run = active;
      writeRpcFrame({ type: "abort" });
      run.finish(status, message ? { message } : {});
    }
  }

  function finishActive(status) {
    if (active && !active.done) active.finish(status);
  }

  // ---------------------------------------------------------------------------
  // Run helpers
  // ---------------------------------------------------------------------------
  const IMAGE_MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
  };
  const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // omp's own limit is 20 MiB

  // Load local image files as omp RPC ImageContent ({type, data(base64), mimeType}).
  function loadImages(paths) {
    if (!paths || !paths.length) return [];
    return paths.map((p) => {
      const ext = path.extname(p).toLowerCase();
      const mimeType = IMAGE_MIME_BY_EXT[ext];
      if (!mimeType) throw new Error(`unsupported image type '${ext}' (supported: png, jpg, jpeg, gif, webp, bmp, svg): ${p}`);
      const buf = fs.readFileSync(p);
      if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image too large (${buf.length} bytes, max ${MAX_IMAGE_BYTES}): ${p}`);
      return { type: "image", data: buf.toString("base64"), mimeType };
    });
  }
  function runPrompt({ task, model, policy, timeoutMs, progressToken, label, images }) {
    return new Promise((resolve) => {
      const started = Date.now();
      const run = {
        policy,
        progressToken,
        text: [],
        thinking: [],
        done: false,
        timer: null,
        finish: null,
      };
      run.finish = (status, extra = {}) => {
        if (run.done) return;
        run.done = true;
        clearTimeout(run.timer);
        clearTimeout(run._pTimer);
        if (active === run) active = null;
        resolve({
          status,
          text: run.text.join(""),
          thinking: run.thinking.join(""),
          durationMs: Date.now() - started,
          ...extra,
        });
      };
      active = run;

      // Bound the whole run; abort path surfaces partial output.
      run.timer = setTimeout(() => {
        abortActive("timeout", `timed out after ${timeoutMs}ms`);
      }, timeoutMs);

      const chain = async () => {
        if (model) {
          const slash = model.indexOf("/");
          const provider = slash >= 0 ? model.slice(0, slash) : "";
          const modelId = slash >= 0 ? model.slice(slash + 1) : model;
          try {
            await request("set_model", { provider, modelId }, 10_000);
          } catch (e) {
            run.finish("error", { error: `set_model failed: ${e.message}` });
            return;
          }
        }
        try {
          const res = await request("prompt", { message: task, ...(images && images.length ? { images } : {}) }, 15_000);
          if (res.data && res.data.agentInvoked === false) {
            // Local-only completion (e.g. slash command) — no agent turn.
            run.finish("done-local");
          }
          // Otherwise completion arrives via agent_end / prompt_result.
        } catch (e) {
          run.finish("error", { error: e.message });
        }
      };
      chain();
    });
  }

  function findLatestSession() {
    const root = sessionDir();
    let best = null;
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".jsonl")) {
          try {
            const st = fs.statSync(full);
            if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs, sizeBytes: st.size };
          } catch {}
        }
      }
    };
    walk(root);
    return best;
  }

  function listSessions(limit) {
    const root = sessionDir();
    const found = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".jsonl")) {
          try {
            const st = fs.statSync(full);
            found.push({ path: full, modifiedAt: new Date(st.mtimeMs).toISOString(), sizeBytes: st.size });
          } catch {}
        }
      }
    };
    walk(root);
    found.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
    return found.slice(0, limit || 10);
  }

  function ompVersion() {
    try {
      return execFileSync(cfg.ompPath, ["--version"], { timeout: 5000, windowsHide: true }).toString().trim();
    } catch {
      return "unknown";
    }
  }

  // ---------------------------------------------------------------------------
  // UI request policy (extension_ui_request from omp)
  // ---------------------------------------------------------------------------
  function onUiRequest(frame) {
    const { id, method, title, message } = frame;
    const dialogMethods = new Set(["select", "confirm", "input", "editor", "cancel"]);

    if (!dialogMethods.has(method)) {
      // Fire-and-forget UI noise (notify/setStatus/setWidget/setTitle/open_url).
      log(`ui(${method}):`, title ? `${title} — ` : "", message ? String(message).slice(0, 300) : "");
      return;
    }

    const policy = active ? active.policy : { autoConfirm: cfg.autoConfirm };
    log(`ui dialog '${method}' (autoConfirm=${policy.autoConfirm}):`, title, "—", String(message || "").slice(0, 300));

    let response;
    switch (method) {
      case "select": {
        const options = frame.options || [];
        const first = options[0];
        response = { id, value: first ? first.value ?? first.label : "" };
        break;
      }
      case "confirm":
        response = { id, confirmed: !!policy.autoConfirm };
        break;
      case "input":
        response = { id, value: frame.default ?? "" };
        break;
      case "editor":
        response = { id, value: "" };
        break;
      case "cancel":
        response = { id, cancelled: true };
        break;
      default:
        return;
    }
    writeRpcFrame({ type: "extension_ui_response", ...response });
  }

  // ---------------------------------------------------------------------------
  // MCP server
  // ---------------------------------------------------------------------------
  function writeMcp(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  function mcpResult(id, result) {
    writeMcp({ jsonrpc: "2.0", id, result });
  }

  function mcpError(id, code, message) {
    writeMcp({ jsonrpc: "2.0", id, error: { code, message } });
  }

  function textToolResult(text, structured) {
    const result = { content: [{ type: "text", text }] };
    if (structured) result.structuredContent = structured;
    return result;
  }

  const TOOLS = [
    {
      name: "omp_status",
      description: "Snapshot of the omp agent for this project: version, current model, session file, message count, context usage, streaming state.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "omp_run",
      description:
        "Delegate a self-contained task to the Oh My Pi (omp) coding agent. omp runs in this project, with its own tools (read/edit/bash/grep/task/web_search...). Use for large refactors, investigations, or multi-file work that would clutter the current thread. Returns the final assistant text; streams progress. Confirmation dialogs omp raises are answered per autoConfirm (default: no).",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The task to run, in natural language." },
          images: { type: "array", items: { type: "string" }, description: "Optional local image file paths (png/jpg/jpeg/gif/webp/bmp/svg) attached to the prompt. For text-only models omp auto-describes them with a vision model." },
          model: { type: "string", description: 'Model as "provider/modelId" (optional; default: omp\'s configured model).' },
          sessionMode: { type: "string", enum: ["fresh", "persistent"], description: "fresh = new session per run (default); persistent = keep reusing the bridge's session." },
          autoConfirm: { type: "boolean", description: "Auto-confirm omp dialogs for this run (default: from settings, off)." },
          timeoutMs: { type: "number", description: "Run timeout in ms (default: settings timeoutMs, 600000)." },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
    {
      name: "omp_continue",
      description:
        "Switch to the most recently modified omp session for this project and optionally continue it with a follow-up instruction. Use to resume previous omp work from the same project.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Optional follow-up instruction. Omit to just switch to the session and return its file." },
          images: { type: "array", items: { type: "string" }, description: "Optional local image file paths attached to the follow-up prompt." },
          model: { type: "string", description: 'Model as "provider/modelId" (optional).' },
          autoConfirm: { type: "boolean", description: "Auto-confirm omp dialogs for this run." },
          timeoutMs: { type: "number", description: "Run timeout in ms." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "omp_abort",
      description: "Abort the in-flight omp_run / omp_continue. Idempotent.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "omp_models",
      description: "List models available to omp (from the configured providers).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "omp_sessions",
      description: "List recent omp session files for this project (path, modified time, size).",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", description: "Max entries (default 10)." } },
        additionalProperties: false,
      },
    },
  ];

  const PROMPTS = [
    {
      name: "omp-run",
      description: "Run a task with the omp agent",
      arguments: [{ name: "task", description: "The task to run", required: true }],
    },
    {
      name: "omp-continue",
      description: "Continue the latest omp session",
      arguments: [{ name: "task", description: "Optional follow-up instruction", required: false }],
    },
  ];

  async function dispatchTool(name, params, progressToken) {
    const p = params || {};
    switch (name) {
      case "omp_status": {
        ensureRpc();
        const [state, stats] = await Promise.all([
          request("get_state", {}, 10_000),
          request("get_session_stats", {}, 10_000).catch(() => null),
        ]);
        const d = state.data || {};
        return textToolResult(
          JSON.stringify(
            { version: ompVersion(), model: d.model, sessionFile: d.sessionFile, sessionName: d.sessionName, messageCount: d.messageCount, contextUsage: d.contextUsage, isStreaming: d.isStreaming, thinkingLevel: d.thinkingLevel, fastMode: d.fastModeActive, stats: stats ? stats.data : null },
            null,
            2
          ),
          { version: ompVersion(), model: d.model, sessionFile: d.sessionFile, messageCount: d.messageCount }
        );
      }

      case "omp_run": {
        if (!p.task || typeof p.task !== "string") throw new Error("omp_run requires a string 'task'");
        if (active) throw new Error("omp is busy: a run is already in progress");
        const timeoutMs = p.timeoutMs ?? cfg.timeoutMs;
        const policy = { autoConfirm: p.autoConfirm ?? cfg.autoConfirm };
        const r = await new Promise((resolve) => {
          ensureRpc();
          const go = async () => {
            const images = loadImages(p.images);
            if (p.sessionMode !== "persistent") {
              await request("new_session", {}, 10_000);
            }
            resolve(await runPrompt({ task: p.task, model: p.model, policy, timeoutMs, progressToken, label: "omp_run", images }));
          };
          go().catch((e) => resolve({ status: "error", error: e.message, text: "", thinking: "", durationMs: 0 }));
        });
        if (r.status === "error") throw new Error(r.error || "omp run failed");
        return textToolResult(r.text || "(no text output)", {
          status: r.status,
          model: p.model || null,
          sessionFile: r.sessionFile || null,
          messageCount: r.messageCount || null,
          durationMs: r.durationMs,
        });
      }

      case "omp_continue": {
        if (active) throw new Error("omp is busy: a run is already in progress");
        const timeoutMs = p.timeoutMs ?? cfg.timeoutMs;
        const policy = { autoConfirm: p.autoConfirm ?? cfg.autoConfirm };
        const r = await new Promise((resolve) => {
          ensureRpc();
          const go = async () => {
            const latest = findLatestSession();
            if (!latest) throw new Error("no omp session found under " + sessionDir());
            await request("switch_session", { sessionPath: latest.path }, 15_000);
            if (!p.task) {
              resolve({ status: "switched", sessionFile: latest.path, text: "", thinking: "", durationMs: 0 });
              return;
            }
            const images = loadImages(p.images);
            resolve(await runPrompt({ task: p.task, model: p.model, policy, timeoutMs, progressToken, label: "omp_continue", images }));
          };
          go().catch((e) => resolve({ status: "error", error: e.message, text: "", thinking: "", durationMs: 0 }));
        });
        if (r.status === "error") throw new Error(r.error);
        if (r.status === "switched") return textToolResult(`Switched to omp session: ${r.sessionFile}`, { status: "switched", sessionFile: r.sessionFile });
        return textToolResult(r.text || "(no text output)", { status: r.status, sessionFile: r.sessionFile, durationMs: r.durationMs });
      }

      case "omp_abort":
        abortActive("aborted", "aborted by caller");
        return textToolResult("Abort signal sent to omp.", { status: "aborted" });

      case "omp_models": {
        ensureRpc();
        const res = await request("get_available_models", {}, 15_000);
        return textToolResult(JSON.stringify(res.data ?? null, null, 2));
      }

      case "omp_sessions": {
        const list = listSessions(p.limit ?? 10);
        return textToolResult(JSON.stringify(list, null, 2), { count: list.length });
      }

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (line.trim()) log("bad MCP frame:", line.slice(0, 200));
      return;
    }
    const { id, method, params } = msg;

    if (method && !id) {
      // Notification
      if (method === "notifications/cancelled") {
        if (params && params.requestId) abortActive("aborted", "cancelled by client");
      } else if (method === "notifications/initialized") {
        // noop
      }
      return;
    }

    try {
      switch (method) {
        case "initialize":
          mcpResult(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true }, prompts: { listChanged: false }, logging: {} },
            serverInfo: { name: "omp-mcp", version: VERSION },
          });
          break;

        case "ping":
          mcpResult(id, {});
          break;

        case "tools/list":
          mcpResult(id, { tools: TOOLS });
          break;

        case "tools/call": {
          const { name, arguments: args } = params || {};
          if (!name) throw new Error("tools/call requires 'name'");
          const token = args && args._meta && args._meta.progressToken;
          const result = await dispatchTool(name, args, token);
          mcpResult(id, result);
          break;
        }

        case "prompts/list":
          mcpResult(id, { prompts: PROMPTS });
          break;

        case "prompts/get": {
          const name = params && params.name;
          if (name === "omp-run") {
            const task = (params.arguments && params.arguments.task) || "";
            mcpResult(id, {
              description: "Run a task with the omp agent",
              messages: [{ role: "user", content: { type: "text", text: `Run this task with the omp agent:\n${task}` } }],
            });
          } else if (name === "omp-continue") {
            const task = (params.arguments && params.arguments.task) || "";
            mcpResult(id, {
              description: "Continue the latest omp session",
              messages: [{ role: "user", content: { type: "text", text: task ? `Continue your latest omp session with: ${task}` : "Continue your latest omp session and report what you did." } }],
            });
          } else {
            throw new Error(`unknown prompt: ${name}`);
          }
          break;
        }

        case "shutdown":
          mcpResult(id, null);
          cleanup(0);
          break;

        default:
          mcpError(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      mcpError(id, -32603, e.message || String(e));
    }
  });

  rl.on("close", () => cleanup(0));

  let cleaning = false;
  function cleanup(code) {
    if (cleaning) return;
    cleaning = true;
    try {
      if (rpc && !rpc.killed) {
        rpc.stdin.end();
        const k = setTimeout(() => rpc.kill("SIGKILL"), 2000);
        k.unref();
      }
    } catch {}
    process.exit(code);
  }

  process.on("SIGINT", () => cleanup(0));
  process.on("SIGTERM", () => cleanup(0));

  log(`bridge ready (omp=${cfg.ompPath}, cwd=${projectRoot})`);
}

module.exports = main;

// Direct execution (standalone / smoke tests) mirrors the `node -e` loader:
// read the settings JSON from OMP_ZED_CFG and start the server.
if (require.main === module) {
  let cfg = {};
  try {
    cfg = JSON.parse(process.env.OMP_ZED_CFG || "{}");
  } catch (e) {
    log("invalid OMP_ZED_CFG:", e.message);
  }
  main(cfg);
}
