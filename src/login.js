import { spawn } from "node:child_process";

// Runs `codex login` (with optional extra args forwarded, e.g. --device-auth)
// inheriting stdio so the user can complete the OAuth flow. Resolves with
// { ok: true } when codex exits 0, otherwise { ok: false }.
// `command` defaults to "codex" and `args` defaults to ["login"].
// The `shell` option defaults to true on Windows so npm .cmd shims resolve;
// pass { shell: false } when the command is a direct path to an executable.
export function runCodexLogin(command = "codex", args = ["login"], { shell = process.platform === "win32" } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const cmd =
        shell && process.platform === "win32" && /[\s"]/.test(command)
          ? `"${command.replace(/"/g, '\\"')}"`
          : command;
      child = spawn(cmd, args, { stdio: "inherit", shell });
    } catch {
      resolve({ ok: false });
      return;
    }
    let settled = false;
    const done = (ok) => {
      if (!settled) {
        settled = true;
        resolve({ ok });
      }
    };
    child.on("close", (code) => done(code === 0));
    child.on("error", () => done(false));
  });
}
