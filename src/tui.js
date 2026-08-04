import readline from "node:readline";

import { listAccounts, switchAccount } from "./core.js";

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

// Pure renderer: returns the block of lines drawn for a given selection.
export function buildTemplate(accounts, selected) {
  const lines = [
    `${BOLD}codexsw${RESET}  ${DIM}^/v move, Enter switch, q quit${RESET}`,
    "",
  ];
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

export function selectAccountInteractive() {
  const { accounts } = listAccounts();
  if (accounts.length === 0) {
    console.log("No saved accounts. Run 'codex login', then 'codexsw save <name>'.");
    return Promise.resolve(null);
  }
  if (!process.stdin.isTTY) {
    console.log("Recorded accounts (run 'codexsw tui' in an interactive terminal to pick):");
    for (const account of accounts) {
      console.log(` ${account.active ? "*" : " "} ${account.name}`);
    }
    return Promise.resolve(null);
  }

  let index = Math.max(0, accounts.findIndex((a) => a.active));

  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
    process.stdout.write(HIDE_CURSOR);

    let blockHeight = 0;
    let finished = false;

    const draw = () => {
      const block = buildTemplate(accounts, index);
      process.stdout.write(MOVE_UP.repeat(blockHeight));
      for (const line of block) {
        process.stdout.write(`${line}${ERASE_LINE}\n`);
      }
      blockHeight = block.length;
    };

    const cleanup = () => {
      finished = true;
      process.stdout.write(MOVE_UP.repeat(blockHeight));
      process.stdout.write(ERASE_LINE);
      process.stdout.write(SHOW_CURSOR);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKeypress);
    };

    const onKeypress = (str, key) => {
      if (finished) return;
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve(null);
        process.exit(130);
      }
      switch (key.name) {
        case "up":
          index = (index - 1 + accounts.length) % accounts.length;
          draw();
          break;
        case "down":
          index = (index + 1) % accounts.length;
          draw();
          break;
        case "return":
        case "enter": {
          const name = accounts[index].name;
          cleanup();
          resolve(name);
          break;
        }
        case "q":
        case "escape": {
          cleanup();
          resolve(null);
          break;
        }
      }
    };

    process.stdin.on("keypress", onKeypress);
    draw();
  }).then((name) => {
    if (!name) return null;
    const { backedUp } = switchAccount(name);
    console.log(
      `Switched to '${name}'.${backedUp ? " (current auth backed up)" : ""}`
    );
    console.log("Restart Codex if it is already running.");
    return name;
  });
}
