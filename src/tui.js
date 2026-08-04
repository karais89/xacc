import readline from "node:readline";
import { createRequire } from "node:module";

import {
  accountEmail,
  isLoggedIn,
  listAccounts,
  removeAccount,
  renameAccount,
  saveAccount,
  suggestAccountName,
  switchAccount,
} from "./core.js";
import { runCodexLogin } from "./login.js";

const require = createRequire(import.meta.url);
const version = require("../package.json").version;

// ── ANSI control sequences ────────────────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const UNDERLINE = "\x1b[4m";
const ERASE_LINE = "\x1b[K";
const MOVE_UP = "\x1b[1A";
const GOTO_COL = "\x1b[G";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J\x1b[H";

// ── Theme ─────────────────────────────────────────────────────────────────
// A single-accent palette tuned for dark terminals (256-color). Every code is
// emptied when NO_COLOR is set, so the UI degrades gracefully.
function buildTheme() {
  const c = (code) => (process.env.NO_COLOR === undefined ? code : "");
  return {
    accent: c("\x1b[38;5;81m"), // focus cursor, prompts
    bright: c("\x1b[38;5;255m"), // active account name
    dim: c("\x1b[38;5;244m"), // inactive rows, secondary text
    faint: c("\x1b[38;5;238m"), // frame borders, rails, separators
    ok: c("\x1b[38;5;79m"), // active status, success
    warn: c("\x1b[38;5;215m"), // stale status
  };
}
const T = buildTheme();

// Aliases used by the interactive flows below.
const DIM = T.dim;
const CYAN = T.accent;
const GREEN = T.ok;

// ── Glyph set: box drawing needs a modern terminal; fall back to ASCII. ────
// A terminal that reports 256+ colors almost always renders Unicode glyphs,
// which is a more reliable signal than environment heuristics on Windows.
function pickGlyphs() {
  const colorDepth =
    typeof process.stdout.getColorDepth === "function" ? process.stdout.getColorDepth() : 4;
  const modern =
    process.platform !== "win32" ||
    colorDepth >= 8 ||
    !!(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuANSI);
  if (modern) {
    return {
      tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│",
      cursor: "▸", dotActive: "●", dotStale: "◐", dotIdle: "•",
      up: "↑", down: "↓", enter: "↵", back: "←", sep: "·", check: "✓",
    };
  }
  return {
    tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|",
    cursor: ">", dotActive: "*", dotStale: "~", dotIdle: "o",
    up: "^", down: "v", enter: "Enter", back: "Bksp", sep: "-", check: "ok",
  };
}

const G = pickGlyphs();

const cur = `${T.accent}${G.cursor}${RESET}`;
const dotActive = `${T.ok}${G.dotActive}${RESET}`;
const dotStale = `${T.warn}${G.dotStale}${RESET}`;
const dotIdle = `${T.faint}${G.dotIdle}${RESET}`;
const rail = `${T.faint}${G.v}${RESET}`;

function selectedAccount(accounts, index) {
  return accounts.length ? accounts[index] : null;
}

// Pure renderer: returns the array of lines making up a single frame.
// opts: { query, mode: "nav"|"search", hint, version }
export function buildTemplate(accounts, index, opts = {}) {
  const { query = "", mode = "nav", hint = "", version = "" } = opts;
  const width = Math.max(24, (process.stdout.columns || 80) - 2);
  const inner = width - 2; // minus rail columns
  const text = (s) => clip(s, inner - 1);
  const lines = [];

  // ── Title bar ────────────────────────────────────────────────────────────
  const title =
    `${BOLD}xacc${RESET}${T.faint} ${G.sep} Codex account manager${RESET}` +
    (version ? `${T.faint}  v${version}${RESET}` : "");
  const left = `${T.faint}${G.tl}${G.h} ${RESET}`;
  const right = `${T.faint} ${G.tr}${RESET}`;
  const filler = Math.max(0, width - displayWidth(left + title + right));
  lines.push(`${left}${title}${spaceN(filler)}${right}`);
  lines.push(`${rail} ${" ".repeat(inner - 1)}${rail}`);

  // ── Toast / hint ─────────────────────────────────────────────────────────
  if (hint) {
    lines.push(`${rail} ${T.accent}${text(hint)}${spaceN(Math.max(0, inner - 1 - displayWidth(hint)))}${RESET}${rail}`);
    lines.push(`${rail} ${" ".repeat(inner - 1)}${rail}`);
  }

  // ── List header ──────────────────────────────────────────────────────────
  const hdr = `${DIM}Accounts${RESET}`;
  lines.push(`${rail} ${hdr}${spaceN(inner - 1 - displayWidth(hdr))}${rail}`);
  lines.push(`${rail} ${" ".repeat(inner - 1)}${rail}`);

  const selected = selectedAccount(accounts, index);

  if (accounts.length === 0 && query.trim()) {
    const noMatch = `${DIM}no matches for '${query}'${RESET}`;
    lines.push(`${rail} ${noMatch}${spaceN(inner - 1 - displayWidth(noMatch))}${rail}`);
    lines.push(`${rail} ${" ".repeat(inner - 1)}${rail}`);
  } else if (accounts.length === 0) {
    lines.push(`${rail} ${" ".repeat(inner - 1)}${rail}`);
    lines.push(`${rail} ${" ".repeat(inner - 1)}${rail}`);
  } else {
    for (let i = 0; i < accounts.length; i++) {
      lines.push(`${rail} ${rowOf(accounts[i], i === index, inner - 4)} ${rail}`);
    }
  }

  // ── Divider + status/info ────────────────────────────────────────────────
  lines.push(`${rail} ${" ".repeat(inner - 1)}${rail}`);
  if (mode === "search") {
    const label = `${T.accent}${UNDERLINE}search${RESET}  ${query}${T.faint}|${RESET}`;
    lines.push(`${rail} ${text(label)}${spaceN(inner - 1 - displayWidth(label))}${rail}`);
  } else {
    const info = selected
      ? `${statusOf(selected)} ${DIM}${G.sep} ${selected.name}${RESET}` +
        (selected.email ? ` ${DIM}${G.sep} ${selected.email}${RESET}` : "") +
        ` ${DIM}${G.sep} ${G.enter} to switch${RESET}`
      : `${DIM}No accounts yet${RESET}`;
    lines.push(`${rail} ${text(info)}${spaceN(inner - 1 - displayWidth(info))}${rail}`);
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  lines.push(`${rail} ${" ".repeat(inner - 1)}${rail}`);
  const sep = `${T.faint} ${G.sep} ${RESET}`;
  let keys;
  if (mode === "search") {
    keys = `${DIM}${G.enter} apply${RESET}${sep}${DIM}${G.back} clear${RESET}`;
  } else {
    keys =
      `${DIM}${G.up}/${G.down} move${RESET}${sep}` +
      `${DIM}${G.enter} switch${RESET}${sep}` +
      `${DIM}/ search${RESET}${sep}` +
      `${DIM}a add${RESET}${sep}` +
      `${DIM}r rename${RESET}${sep}` +
      `${DIM}d delete${RESET}${sep}` +
      `${DIM}q quit${RESET}`;
  }
  lines.push(`${rail} ${text(keys)}${spaceN(inner - 1 - displayWidth(keys))}${rail}`);
  lines.push(`${T.faint}${G.bl}${G.h.repeat(inner)}${G.br}${RESET}`);

  return lines;
}

function dotOf(acc) {
  return acc.active ? (acc.matched ? dotActive : dotStale) : dotIdle;
}

// Renders one account row: cursor + status dot + name (+ email) on the left,
// status badge right-aligned. Selection is indicated by an accent cursor and
// accent name — no background block.
function rowOf(acc, isSelected, avail) {
  const cursor = isSelected ? cur : " ";
  const nameColor = isSelected ? T.accent : acc.active ? T.bright : DIM;
  const name = `${nameColor}${acc.name}${RESET}`;
  const email = acc.email ? `${DIM}  ${acc.email}${RESET}` : "";
  const badge = acc.active
    ? acc.matched
      ? `${T.ok}active${RESET}`
      : `${T.warn}stale${RESET}`
    : "";
  const left = `${cursor}${dotOf(acc)} ${name}${email}`;
  const badgeGap = badge ? 1 + displayWidth(badge) : 0;
  const pad = Math.max(0, avail - displayWidth(left) - badgeGap);
  return `${left}${spaceN(pad)}${badge ? ` ${badge}` : ""}`;
}

function statusOf(acc) {
  if (!acc.active) return `${DIM}inactive${RESET}`;
  return acc.matched
    ? `${T.ok}${G.dotActive} active${RESET}`
    : `${T.warn}${G.dotStale} current${RESET} ${DIM}(live auth differs)${RESET}`;
}

function spaceN(n) {
  return n > 0 ? " ".repeat(n) : "";
}
// Approximate display width ignoring ANSI codes.
function displayWidth(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
// Clip a (possibly ANSI-colored) string to a visible width, preserving codes.
function clip(s, max) {
  let out = "";
  let w = 0;
  let inEsc = false;
  for (const ch of s) {
    if (inEsc) {
      out += ch;
      if (ch === "m") inEsc = false;
      continue;
    }
    if (ch === "\x1b") {
      inEsc = true;
      out += ch;
      continue;
    }
    if (w >= max) return out + "…";
    out += ch;
    w += 1;
  }
  return out;
}

// Prompts a single line of input (cursor shown, raw mode off), then returns
// the answer and restores raw mode.
export function askLine(message) {
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
  // Enrich saved accounts with their login email for display.
  const load = () =>
    listAccounts().accounts.map((a) => ({ ...a, email: accountEmail(a.name) }));
  let full = load();
  let query = "";
  let mode = "nav";
  let hint = "";
  let prevHeight = 0;
  let finished = false;

  const visible = () => {
    if (!query.trim()) return full;
    const q = query.toLowerCase();
    return full.filter((a) => a.name.toLowerCase().includes(q));
  };

  let list = visible();
  let index = Math.max(0, list.findIndex((a) => a.active));

  // ── Empty-state handling ─────────────────────────────────────────────────
  if (full.length === 0) {
    if (!isLoggedIn()) {
      if (process.stdin.isTTY) {
        process.stdout.write(CLEAR_SCREEN);
        console.log(`${DIM}not logged in${RESET} — run ${CYAN}codex login${RESET} first, then ${CYAN}xacc tui${RESET} again.`);
        return null;
      }
      console.log("Not logged in yet. Run 'codex login' first, then run 'xacc tui'.");
      return null;
    }
    if (process.stdin.isTTY) {
      process.stdout.write(CLEAR_SCREEN);
      console.log(`You're logged in but have no saved accounts yet.`);
      const answer = await askLine(`Save this login as (default '${suggestAccountName() || "default"}'): `);
      const name = answer.trim() || suggestAccountName() || "default";
      try {
        saveAccount(name);
        console.log(`${T.ok}${G.check}${RESET} Saved the current login as '${name}'.`);
      } catch (error) {
        console.error(`Error: ${error.message}`);
      }
      return null;
    }
    console.log("You are logged in but no accounts are saved. Run 'xacc save <name>'.");
    return null;
  }

  if (!process.stdin.isTTY) {
    console.log("Recorded accounts (run 'xacc tui' in an interactive terminal to pick):");
    for (const account of full) {
      console.log(` ${account.active ? (account.matched ? "*" : "~") : " "} ${account.name}`);
    }
    return null;
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  const render = () => {
    // Move cursor back to the top-left of the previous frame and redraw,
    // erasing any lines that are no longer part of the frame.
    if (prevHeight) process.stdout.write(MOVE_UP.repeat(prevHeight));
    process.stdout.write(GOTO_COL);
    const frame = buildTemplate(visible(), index, { query, mode, hint, version });
    const height = frame.length;
    const total = Math.max(height, prevHeight);
    for (let i = 0; i < total; i++) {
      process.stdout.write(`${i < height ? frame[i] : ""}${ERASE_LINE}${i < total - 1 ? "\n" : ""}`);
    }
    prevHeight = height;
  };

  const renderClean = () => {
    process.stdout.write(CLEAR_SCREEN);
    prevHeight = 0;
    render();
  };

  const refreshList = () => {
    list = visible();
    index = Math.max(0, Math.min(index, list.length - 1));
  };

  // Erases the frame currently on screen (leaves the cursor right below it).
  const clearFrame = () => {
    if (prevHeight > 0) {
      process.stdout.write(MOVE_UP.repeat(prevHeight));
      for (let i = 0; i < prevHeight; i++) {
        process.stdout.write(`${ERASE_LINE}${i < prevHeight - 1 ? "\n" : ""}`);
      }
      prevHeight = 0;
    }
  };

  // ── Flows that leave the picker (prompt input) ───────────────────────────
  const suspend = () => {
    clearFrame();
    process.stdout.write(SHOW_CURSOR);
    process.stdin.setRawMode(false);
  };
  const resume = (msg) => {
    hint = msg || "";
    refreshList();
    renderClean();
    process.stdout.write(HIDE_CURSOR);
  };

  const addFlow = async () => {
    suspend();
    console.log(`${DIM}Running 'codex login'... complete the login in your browser.${RESET}`);
    const { ok } = await runCodexLogin();
    if (!ok) {
      resume(`Could not run 'codex login' (is Codex installed?).`);
      return;
    }
    const suggested = suggestAccountName() || "default";
    const answer = await askLine(`Save this login as (default '${suggested}'): `);
    const name = answer.trim() || suggested;
    try {
      const { overwritten } = saveAccount(name);
      full = load();
      resume(`${T.ok}${G.check}${RESET} Saved '${name}'.${overwritten ? " (overwritten)" : ""}`);
    } catch (error) {
      resume(`${error.message}`);
    }
  };

  const renameFlow = async () => {
    const current = list[index];
    if (!current) return;
    suspend();
    const answer = await askLine(`Rename '${current.name}' to: `);
    const newName = answer.trim();
    if (newName && newName !== current.name) {
      try {
        renameAccount(current.name, newName);
        full = load();
        resume(`${T.ok}${G.check}${RESET} Renamed '${current.name}' -> '${newName}'.`);
      } catch (error) {
        resume(`${error.message}`);
      }
    } else {
      resume();
    }
  };

  const deleteFlow = async () => {
    const current = list[index];
    if (!current) return;
    suspend();
    const answer = await askLine(`Delete '${current.name}'? (y/N): `);
    if (answer.trim().toLowerCase() === "y") {
      try {
        removeAccount(current.name);
        full = load();
        resume(`${T.ok}${G.check}${RESET} Deleted '${current.name}'.`);
      } catch (error) {
        resume(`${error.message}`);
      }
    } else {
      resume();
    }
  };

  const doSwitch = (name) => {
    try {
      switchAccount(name);
      clearFrame();
      console.log(`${T.ok}${G.dotActive}${RESET} Switched to '${name}' — restart Codex if it is running.`);
      finish(name);
    } catch (error) {
      hint = error.message;
      render();
    }
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
        finish(null);
        process.exitCode = 130;
        return;
      }

      if (mode === "search") {
        if (key.name === "escape" || (key.name === "return" || key.name === "enter")) {
          mode = "nav";
          refreshList();
          render();
        } else if (key.name === "backspace") {
          query = query.slice(0, -1);
          refreshList();
          render();
        } else if (str && /^[\x20-\x7e]$/.test(str)) {
          query += str;
          refreshList();
          render();
        }
        return;
      }

      switch (key.name) {
        case "up":
          if (list.length) {
            index = (index - 1 + list.length) % list.length;
            hint = "";
            render();
          }
          break;
        case "down":
          if (list.length) {
            index = (index + 1) % list.length;
            hint = "";
            render();
          }
          break;
        case "return":
        case "enter": {
          const current = list[index];
          if (current) doSwitch(current.name);
          break;
        }
        case "/":
          if (full.length) {
            mode = "search";
            query = "";
            render();
          }
          break;
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
    renderClean();
  });
}
