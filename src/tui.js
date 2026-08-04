import { spawn } from "node:child_process";
import readline from "node:readline";

import {
  isLoggedIn,
  listAccounts,
  removeAccount,
  renameAccount,
  saveAccount,
  suggestAccountName,
  switchAccount,
} from "./core.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
// eslint-disable-next-line no-control-regex
const ERASE_LINE = "\x1b[K";
// eslint-disable-next-line no-control-regex
const MOVE_UP = "\x1b[1A";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J\x1b[H";

const CONTROLS =
  `${DIM}^/v move · Enter switch · a add · r rename · d delete · q quit${RESET}`;

// Pure renderer: returns the block of lines drawn for a given selection.
export function buildTemplate(accounts, selected, hint = "") {
  const lines = [`${BOLD}xacc${RESET}  ${CONTROLS}`, ""];
  if (hint) {
    lines.push(`${CYAN}${hint}${RESET}`);
  }
  accounts.forEach((account, i) => {
    const cursor = i === selected ? `${CYAN}>${RESET} ` : "  ";
    const state = account.active
      ? account.matched
        ? `${CYAN}(active)${RESET}`
        : `${DIM}(recorded)${RESET}`
      : "";
    lines.push(`${cursor}${account.name} ${state}`);
  });
  lines.push("");
  return lines;
}

// Prompts a single line of input (cursor shown, raw mode off), then returns
// the answer and restores raw mode.
function askLine(message) {
  return new Promise((resolve) => {
    process.stdout.write(SHOW_CURSOR);
    process.stdin.setRawMode(false);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(message, (answer) => {
      rl.close();
      process.stdin.setRawMode(true);
      process.stdout.write(HIDE_CURSOR);
      resolve(answer);
    });
  });
}

export async function selectAccountInteractive() {
  let accounts = listAccounts().accounts;

  // Empty state: guide, or save the current login as the first account.
  if (accounts.length === 0) {
    if (!isLoggedIn()) {
      console.log("Not logged in yet. Run 'codex login' first, then 'xacc save <name>'.");
      return null;
    }
    if (!process.stdin.isTTY) {
      console.log(
        "You are logged in but have no saved accounts. Run 'xacc save <name>' to save the current login."
      );
      return null;
    }
    console.log("You are logged in, but no accounts are saved yet.");
    const answer = await askLine("Save this login as (default 'default'): ");
    const name = answer.trim() || "default";
    saveAccount(name);
    console.log(`Saved current auth as '${name}'.`);
    accounts = listAccounts().accounts;
    if (accounts.length === 0) return null;
  }

  if (!process.stdin.isTTY) {
    console.log("Recorded accounts (run 'xacc tui' in an interactive terminal to pick):");
    for (const account of accounts) {
      console.log(` ${account.active ? "*" : " "} ${account.name}`);
    }
    return null;
  }

  let index = Math.max(0, accounts.findIndex((a) => a.active));
  let busy = false;
  let finished = false;
  let blockHeight = 0;
  let hint = "";

  const redrawInPlace = () => {
    const block = buildTemplate(accounts, index, hint);
    process.stdout.write(MOVE_UP.repeat(blockHeight));
    process.stdout.write(ERASE_LINE);
    for (const line of block) {
      process.stdout.write(`${line}${ERASE_LINE}\n`);
    }
    blockHeight = block.length;
  };

  const redrawFull = () => {
    process.stdout.write(CLEAR_SCREEN);
    const block = buildTemplate(accounts, index, hint);
    for (const line of block) {
      process.stdout.write(`${line}\n`);
    }
    blockHeight = block.length;
  };

  const refresh = () => {
    accounts = listAccounts().accounts;
    index = Math.max(0, Math.min(index, accounts.length - 1));
  };

  const resume = () => {
    busy = false;
    process.stdout.write(HIDE_CURSOR);
    redrawFull();
  };

  const suspend = () => {
    process.stdout.write(SHOW_CURSOR);
    process.stdin.setRawMode(false);
  };

  const addFlow = async () => {
    busy = true;
    suspend();
    process.stdout.write(CLEAR_SCREEN + SHOW_CURSOR);
    console.log(`${DIM}Running 'codex login'... complete the login in your browser.${RESET}`);
    try {
      const codex = spawn("codex", ["login"], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      await new Promise((resolve) => {
        codex.on("close", resolve);
        codex.on("error", resolve);
      });
    } catch {
      hint = "Could not run 'codex login' (is Codex installed?).";
      resume();
      return;
    }
    const suggested = suggestAccountName();
    const answer = await askLine(`Save this login as (default '${suggested || "default"}'): `);
    const name = answer.trim() || suggested || "default";
    try {
      saveAccount(name);
      hint = `Saved '${name}'.`;
    } catch (error) {
      hint = error.message;
    }
    refresh();
    resume();
  };

  const renameFlow = async () => {
    busy = true;
    suspend();
    const oldName = accounts[index].name;
    const answer = await askLine(`Rename '${oldName}' to: `);
    const newName = answer.trim();
    if (newName && newName !== oldName) {
      try {
        renameAccount(oldName, newName);
        hint = `Renamed '${oldName}' -> '${newName}'.`;
      } catch (error) {
        hint = error.message;
      }
    }
    refresh();
    resume();
  };

  const deleteFlow = async () => {
    busy = true;
    suspend();
    const name = accounts[index].name;
    const answer = await askLine(`Delete '${name}'? (y/N): `);
    if (answer.trim().toLowerCase() === "y") {
      try {
        removeAccount(name);
        hint = `Deleted '${name}'.`;
      } catch (error) {
        hint = error.message;
      }
    }
    refresh();
    resume();
  };

  return new Promise((resolvePicker) => {
    let onKeypress;
    const cleanup = () => {
      finished = true;
      process.stdout.write(SHOW_CURSOR);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKeypress);
    };
    const finish = (name) => {
      cleanup();
      resolvePicker(name);
    };

    onKeypress = (str, key) => {
      if (finished) return;
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(130);
      }
      if (busy) return;
      switch (key.name) {
        case "up":
          index = (index - 1 + accounts.length) % accounts.length;
          redrawInPlace();
          break;
        case "down":
          index = (index + 1) % accounts.length;
          redrawInPlace();
          break;
        case "return":
        case "enter": {
          const name = accounts[index].name;
          try {
            switchAccount(name);
            console.log(`Switched to '${name}'.`);
            console.log("Restart Codex if it is already running.");
            finish(name);
          } catch (error) {
            console.error(`Error: ${error.message}`);
            finish(null);
          }
          break;
        }
        case "a":
          addFlow();
          break;
        case "r":
          renameFlow();
          break;
        case "d":
          deleteFlow();
          break;
        case "q":
        case "escape":
          finish(null);
          break;
      }
    };

    process.stdin.setRawMode(true);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
    process.stdout.write(HIDE_CURSOR);
    process.stdin.on("keypress", onKeypress);
    redrawInPlace();
  });
}