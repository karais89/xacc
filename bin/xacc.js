#!/usr/bin/env node

import {
  authFile,
  getActiveAccount,
  listAccounts,
  removeAccount,
  saveAccount,
  switchAccount,
} from "../src/core.js";
import { selectAccountInteractive } from "../src/tui.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function printUsage() {
  console.log(`xacc - switch saved Codex CLI accounts

Usage:
  xacc tui               Interactive account picker
  xacc save <name>       Save the current auth.json as a named account
  xacc switch <name>     Switch to a saved account (auto-backs up current)
  xacc list              List saved accounts
  xacc current           Show the active account
  xacc remove <name>     Delete a saved account
  xacc help              Show this help

Notes:
  - To add a new account, run 'codex login', then 'xacc save <name>'.
  - Restart Codex after switching if it is already running.
  - Storage: ${authFile()}`);
}

function renderList() {
  const { accounts, active } = listAccounts();
  if (accounts.length === 0) {
    console.log("No saved accounts. Run 'codex login', then 'xacc save <name>'.");
    return;
  }
  for (const account of accounts) {
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
  if (active && !active.matched) {
    console.log(`${DIM}~ recorded current account (live auth differs from saved snapshot)${RESET}`);
  }
}

function die(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const [, , command, ...args] = process.argv;

try {
  switch (command) {
    case "tui": {
      await selectAccountInteractive();
      break;
    }
    case "save": {
      const name = args[0];
      if (!name) die("Usage: xacc save <name>");
      const { overwritten } = saveAccount(name);
      console.log(`Saved current auth as '${name}'.${overwritten ? " (overwritten)" : ""}`);
      break;
    }
    case "switch": {
      const name = args[0];
      if (!name) die("Usage: xacc switch <name>");
      const { backedUp } = switchAccount(name);
      console.log(
        `Switched to '${name}'.${backedUp ? " (current auth backed up)" : ""}`
      );
      console.log("Restart Codex if it is already running.");
      break;
    }
    case "list":
      renderList();
      break;
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
    default:
      die(`Unknown command '${command}'. See 'xacc help'.`);
  }
} catch (error) {
  die(error.message);
}
