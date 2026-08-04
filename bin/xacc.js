#!/usr/bin/env node

import { createRequire } from "node:module";

import {
  authFile,
  duplicateAccountOf,
  getActiveAccount,
  listAccounts,
  removeAccount,
  saveAccount,
  sharedWorkspaceOf,
  suggestAccountName,
  switchAccount,
} from "../src/core.js";
import { runCodexLogin } from "../src/login.js";
import { askLine, selectAccountInteractive } from "../src/tui.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function printUsage() {
  console.log(`xacc - switch saved Codex CLI accounts

Usage:
  xacc login [name] [flags]          Run 'codex login', then save the account
  xacc switch [name]                 Switch account (picker without a name)
  xacc list [--active]               List saved accounts
  xacc current                       Show the active account
  xacc save <name> [--force]         Save the current auth.json as a named account
  xacc remove <name>                 Delete a saved account
  xacc tui                           Interactive account manager
  xacc --version                     Show the installed version
  xacc help                          Show this help

Notes:
  - 'login' runs the real 'codex login' flow (plus any extra args you pass,
    e.g. --device-auth for headless), then saves it. The account name is
    suggested from your login email; pass a name to set it directly.
  - Existing names are protected. Pass --force to 'login' or 'save' only when
    you intentionally want to replace that snapshot.
  - 'save' is a legacy alias that stores the current auth.json without logging in.
  - Restart Codex after switching if it is already running.
  - Storage: ${authFile()}`);
}

function die(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// Returns the optional profile name, xacc's overwrite choice, and flags to
// forward to the real `codex login` command.
function parseLoginArgs(args) {
  const nameArgs = args.filter((a) => !a.startsWith("-"));
  const overwrite = args.includes("--force");
  const forwarded = args.filter((a) => a.startsWith("-") && a !== "--force");
  if (nameArgs.length > 1) die("Usage: xacc login [<name>] [codex login flags...]");
  return { name: nameArgs[0], forwarded, overwrite };
}

async function tryLogin(resolved, forwarded) {
  console.log("Running 'codex login'... complete the login in your browser.");
  const { ok } = await runCodexLogin("codex", ["login", ...forwarded]);
  if (!ok) die("'codex login' failed. Is Codex installed and did the login succeed?");
  if (resolved) return resolved;
  const suggested = suggestAccountName() || "default";
  if (process.stdin.isTTY) {
    const answer = await askLine(`Save this login as (default '${suggested}'): `);
    return answer.trim() || suggested;
  }
  return suggested;
}

const [, , command, ...args] = process.argv;

// Runs the interactive picker and then exits the process deterministically.
// The exit runs on a microtask right after the picker resolves, i.e. before
// the event loop ever parks again on the raw-mode TTY stdin (or a draining
// socket), so the process can never hang after switching. Because the picker
// is no longer a top-level await, forcing the exit also cannot trigger the
// 'unsettled top-level await' warning.
const runPicker = (promise) =>
  promise.then(
    () => process.exit(process.exitCode || 0),
    (error) => {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  );

try {
  switch (command) {
    case "tui": {
      runPicker(selectAccountInteractive());
      break;
    }
    case "login": {
      const { name, forwarded, overwrite } = parseLoginArgs(args);
      const finalName = await tryLogin(name, forwarded);
      const { overwritten, unchanged } = saveAccount(finalName, { overwrite });
      const dup = duplicateAccountOf(finalName);
      const ws = sharedWorkspaceOf(finalName);
      console.log(
        `Logged in and ${unchanged ? "already saved" : "saved"} as '${finalName}'.${overwritten ? " (replaced)" : ""}` +
          (dup ? ` Warning: already saved as '${dup}'.` : "") +
          (ws ? ` Shares a workspace with '${ws}'.` : "")
      );
      break;
    }
    case "save": {
      const positional = args.filter((arg) => !arg.startsWith("-"));
      const unknownFlags = args.filter((arg) => arg.startsWith("-") && arg !== "--force");
      const name = positional[0];
      if (!name || positional.length > 1 || unknownFlags.length) {
        die("Usage: xacc save <name> [--force]");
      }
      const { overwritten, unchanged } = saveAccount(name, { overwrite: args.includes("--force") });
      console.log(
        unchanged
          ? `Account '${name}' already contains the current auth.`
          : `Saved current auth as '${name}'.${overwritten ? " (replaced)" : ""}`
      );
      break;
    }
    case "switch": {
      const name = args[0];
      if (!name) {
        runPicker(selectAccountInteractive());
        break;
      }
      const { backedUp } = switchAccount(name);
      console.log(`Switched to '${name}'.${backedUp ? " (current auth backed up)" : ""}`);
      console.log("Restart Codex if it is already running.");
      break;
    }
    case "list": {
      const onlyActive = args.includes("--active");
      const { accounts, active } = listAccounts();
      if (accounts.length === 0) {
        console.log("No saved accounts. Run 'xacc login' to add one.");
        break;
      }
      for (const account of accounts) {
        if (onlyActive && !account.active) continue;
        const marker = account.active
          ? account.matched
            ? "*"
            : "~"
          : " ";
        const state = account.active
          ? account.matched
            ? "active"
            : "recorded (live auth differs)"
          : "";
        console.log(`${marker} ${account.name}${state ? ` ${DIM}(${state})${RESET}` : ""}`);
      }
      if (onlyActive && active && !active.matched) {
        console.log(`${DIM}~ recorded current account (live auth differs from saved snapshot)${RESET}`);
      }
      break;
    }
    case "current": {
      const active = getActiveAccount();
      if (!active) {
        console.log("No active account detected.");
      } else if (active.matched) {
        console.log(active.name);
      } else {
        console.log(`${active.name} (recorded, live auth differs from saved snapshot)`);
      }
      break;
    }
    case "remove": {
      const name = args[0];
      if (!name) die("Usage: xacc remove <name>");
      removeAccount(name);
      console.log(`Removed '${name}'.`);
      break;
    }
    case "help":
    case "-h":
    case "--help":
    case undefined:
      printUsage();
      break;
    case "version":
    case "-v":
    case "--version":
      console.log(version);
      break;
    default:
      die(`Unknown command '${command}'. See 'xacc help'.`);
  }
} catch (error) {
  die(error.message);
}
