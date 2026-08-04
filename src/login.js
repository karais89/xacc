import { spawn } from "node:child_process";

import { readAuth, writeAuth } from "./core.js";

// True when the on-disk auth.json parses to an object with at least one key.
// A missing file is not treated as a failure signal (some login commands do
// not write one), but an empty object is — codex writes `{}` when the flow is
// cancelled before tokens are received.
function authLooksEmpty() {
  const raw = readAuth();
  if (raw == null) return false;
  try {
    const obj = JSON.parse(raw.toString("utf-8"));
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return true;
    return Object.keys(obj).length === 0;
  } catch {
    return true;
  }
}

// Runs `codex login` (with optional extra args forwarded, e.g. --device-auth)
// inheriting stdio so the user can complete the OAuth flow. Resolves with
// { ok: true } when codex exits 0 and left a usable auth.json, otherwise
// { ok: false }. `codex login` overwrites auth.json as soon as the flow
// starts, so on cancel/failure the previous auth is restored and the last
// account stays active instead of going stale.
// `command` defaults to "codex" and `args` defaults to ["login"].
// The `shell` option defaults to true on Windows so npm .cmd shims resolve;
// pass { shell: false } when the command is a direct path to an executable.
export function runCodexLogin(command = "codex", args = ["login"], { shell = process.platform === "win32" } = {}) {
  return new Promise((resolve) => {
    const prior = readAuth();
    let child;
    try {
      const cmd =
        shell && process.platform === "win32" && /[\s"]/.test(command)
          ? `"${command.replace(/"/g, '\\"')}"`
          : command;
      child = spawn(cmd, args, { stdio: "inherit", shell });
    } catch {
      writeAuth(prior);
      resolve({ ok: false });
      return;
    }
    let settled = false;
    const done = (ok) => {
      if (!settled) {
        settled = true;
        const failed = !ok || authLooksEmpty();
        if (failed) writeAuth(prior);
        resolve({ ok: !failed });
      }
    };
    child.on("close", (code) => done(code === 0));
    child.on("error", () => done(false));
  });
}
