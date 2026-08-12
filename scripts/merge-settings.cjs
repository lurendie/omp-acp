#!/usr/bin/env node
// Zed settings.json (JSONC) merge/remove helper used by install.ps1 / uninstall.ps1.
// Handles the `//` comment header Zed writes, without corrupting strings
// containing `//` (e.g. https:// URLs).
//
// Usage:
//   node merge-settings.cjs merge --file <path> --json '<patch json>'
//   node merge-settings.cjs remove --file <path> --keys 'agent_servers.omp,context_servers.omp'
"use strict";

const fs = require("fs");

function stripJsonc(src) {
  let out = "";
  let inStr = false, esc = false, line = false, block = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (line) {
      if (c === "\n") { line = false; out += c; }
      continue;
    }
    if (block) {
      if (c === "*" && n === "/") { block = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { line = true; i++; continue; }
    if (c === "/" && n === "*") { block = true; i++; continue; }
    if (c === ",") {
      // JSONC allows trailing commas — drop a comma that is followed by } or ]
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

const [op, ...rest] = process.argv.slice(2);
const arg = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

function load(file) {
  if (!fs.existsSync(file)) return {};
  const src = fs.readFileSync(file, "utf8");
  const stripped = stripJsonc(src);
  if (!stripped.trim()) return {};
  try {
    return JSON.parse(stripped);
  } catch (e) {
    console.error(`parse error in ${file}: ${e.message}`);
    process.exit(2);
  }
}

function setPath(obj, keyPath, value) {
  const parts = keyPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function deletePath(obj, keyPath) {
  const parts = keyPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
    if (!cur || typeof cur !== "object") return false;
  }
  const last = parts[parts.length - 1];
  const existed = last in cur;
  delete cur[last];
  return existed;
}

if (op === "merge") {
  const file = arg("--file");
  let patchJson = arg("--json");
  if (patchJson === "-") {
    // Read the patch from stdin — avoids PowerShell 5.1 mangling embedded quotes in argv.
    patchJson = fs.readFileSync(0, "utf8");
  }
  const patch = JSON.parse(patchJson);
  if (!file) { console.error("--file required"); process.exit(2); }
  const settings = load(file);
  const merged = { ...settings };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && settings[key] && typeof settings[key] === "object") {
      merged[key] = { ...settings[key], ...value };
    } else {
      merged[key] = value;
    }
  }
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
  console.log(`merged ${file}`);
} else if (op === "remove") {
  const file = arg("--file");
  const keys = (arg("--keys") || "").split(",").filter(Boolean);
  if (!file) { console.error("--file required"); process.exit(2); }
  const settings = load(file);
  let changed = false;
  for (const k of keys) changed = deletePath(settings, k) || changed;
  if (changed) {
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
    console.log(`removed ${keys.join(", ")} from ${file}`);
  } else {
    console.log(`nothing to remove (${keys.join(", ")})`);
  }
} else {
  console.error("unknown op:", op);
  process.exit(2);
}
