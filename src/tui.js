import readline from "node:readline";
import { createRequire } from "node:module";

import {
  accountMeta,
  duplicateAccountOf,
  isLoggedIn,
  listAccounts,
  planLabel,
  removeAccount,
  renameAccount,
  saveAccount,
  suggestAccountName,
  switchAccount,
} from "./core.js";
import { runCodexLogin } from "./login.js";
import { fetchAllUsages } from "./usage.js";

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
    bad: c("\x1b[38;5;203m"), // near-limit usage
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
      barFull: "▓", barEmpty: "░", ellipsis: "…",
    };
  }
  return {
    tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|",
    cursor: ">", dotActive: "*", dotStale: "~", dotIdle: "o",
    up: "^", down: "v", enter: "Enter", back: "Bksp", sep: "-", check: "ok",
    barFull: "#", barEmpty: ".", ellipsis: "...",
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
// opts: { query, mode: "nav"|"search", hint, version, usageLoading }
export function buildTemplate(accounts, index, opts = {}) {
  const { query = "", mode = "nav", hint = "", version = "", usageLoading = false } = opts;
  const width = Math.max(24, (process.stdout.columns || 80) - 2);
  const inner = width - 2; // minus rail columns
  // Clips to inner-2 so the appended ellipsis still fits within the frame.
  const text = (s) => clip(s, inner - 2);
  // A fully-padded content line: rail + content + fill + rail, always `width` wide.
  const line = (s) => {
    const t = text(s);
    return `${rail} ${t}${spaceN(Math.max(0, inner - 1 - displayWidth(t)))}${rail}`;
  };
  const blank = () => `${rail} ${" ".repeat(inner - 1)}${rail}`;
  const lines = [];

  // ── Title bar ────────────────────────────────────────────────────────────
  const left = `${T.faint}${G.tl}${G.h} ${RESET}`;
  const right = `${T.faint} ${G.tr}${RESET}`;
  let titleText = `${BOLD}xacc${RESET}${T.faint} ${G.sep} Codex account manager${RESET}`;
  const budget = width - displayWidth(left + right);
  // Drop the version suffix, then clip, so the top border never exceeds the frame.
  if (version && displayWidth(titleText + `${T.faint}  v${version}${RESET}`) <= budget) {
    titleText = `${titleText}${T.faint}  v${version}${RESET}`;
  }
  if (displayWidth(titleText) > budget) titleText = clip(titleText, Math.max(0, budget - 1));
  lines.push(`${left}${titleText}${spaceN(budget - displayWidth(titleText))}${right}`);
  lines.push(blank());

  // ── Toast / hint ─────────────────────────────────────────────────────────
  if (hint) {
    lines.push(line(`${T.accent}${hint}${RESET}`));
    lines.push(blank());
  }

  // ── List header ──────────────────────────────────────────────────────────
  lines.push(line(`${DIM}Accounts${RESET}`));
  lines.push(blank());

  const selected = selectedAccount(accounts, index);

  if (accounts.length === 0 && query.trim()) {
    lines.push(line(`${DIM}no matches for '${query}'${RESET}`));
    lines.push(blank());
  } else if (accounts.length === 0) {
    lines.push(blank());
    lines.push(blank());
  } else {
    for (let i = 0; i < accounts.length; i++) {
      lines.push(line(rowOf(accounts[i], i === index, inner - 2)));
    }
  }

  // ── Divider + status/info ────────────────────────────────────────────────
  lines.push(blank());
  if (mode === "search") {
    lines.push(line(`${T.accent}${UNDERLINE}search${RESET}  ${query}${T.faint}|${RESET}`));
  } else if (selected) {
    const detail = buildDetail(selected, usageLoading);
    if (detail) {
      for (const d of detail) lines.push(line(d));
    } else {
      lines.push(blank());
    }
  } else {
    lines.push(line(`${DIM}No accounts yet${RESET}`));
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  lines.push(blank());
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
  lines.push(line(keys));
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

// A 10-cell usage bar. The fill color follows the limit: healthy, high, then
// near-limit. `NO_COLOR` (via T) keeps the cells readable, dropping the % tint.
function bar(percent) {
  const cells = 10;
  const pct = Math.round(percent);
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
  const color = pct < 50 ? T.ok : pct < 80 ? T.warn : T.bad;
  const full = `${color}${G.barFull.repeat(filled)}${RESET}`;
  const empty = `${T.faint}${G.barEmpty.repeat(cells - filled)}${RESET}`;
  return `${full}${empty} ${color}${pct}%${RESET}`;
}

function pctOrDash(win) {
  return win && win.usedPercent != null ? win.usedPercent : null;
}

// Short, human-readable label for a rate-limit window duration (e.g. "5h",
// "7d", "1w"). Falls back to a generic "usage" when unknown.
function windowLabel(seconds) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "usage";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.round(seconds / 86400)}d`;
  return `${Math.round(seconds / 604800)}w`;
}

// Resolves the plan to show: prefer the live usage plan, fall back to the
// plan inferred from the login id_token.
function usagePlanLabel(acc) {
  const usage = acc.usage;
  if (usage && !usage.error && usage.plan) return planLabel(usage.plan);
  if (acc.plan) return planLabel(acc.plan);
  return null;
}

// The detail lines shown beneath the account list for the selected account:
// status, plan, 5h / weekly usage bars, and last activity time.
function buildDetail(acc, usageLoading) {
  if (!acc) return null;
  const parts = [];
  parts.push(statusOf(acc));

  const plan = usagePlanLabel(acc);
  if (plan) parts.push(`${DIM}${G.sep}${RESET} ${T.accent}${plan}${RESET}`);

  const usage = acc.usage;
  if (usage && !usage.error) {
    const primary = pctOrDash(usage.primary);
    const secondary = pctOrDash(usage.secondary);
    if (primary != null) parts.push(`${DIM}${G.sep} ${windowLabel(usage.primary.windowSeconds)} used${RESET} ${bar(primary)}`);
    if (secondary != null) parts.push(`${DIM}${G.sep} ${windowLabel(usage.secondary.windowSeconds)} used${RESET} ${bar(secondary)}`);
    if (primary == null && secondary == null) parts.push(`${DIM}${G.sep} no usage data${RESET}`);
  } else if (usage && usage.error) {
    parts.push(`${DIM}${G.sep} usage unavailable${RESET}`);
  } else if (usageLoading) {
    parts.push(`${DIM}${G.sep} fetching usage${G.ellipsis}${RESET}`);
  }

  const details = [parts.join(" ")];
  const activity = relativeTime(acc.lastActivity);
  if (activity) details.push(`${DIM}last activity: ${activity}${RESET}`);
  return details;
}

function relativeTime(ms) {
  if (!ms) return null;
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
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
// the answer and re-arms the picker's stdin (raw mode + keypress events). The
// readline interface otherwise leaves stdin in a state where the picker's
// keypress handler stops firing, which can strand the top-level await.
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
      readline.emitKeypressEvents(process.stdin);
      process.stdin.resume();
      resolve(answer);
    });
  });
}

export async function selectAccountInteractive() {
  // Enrich saved accounts with local metadata (email, plan, last activity)
  // and the auth payload needed for live usage lookups.
  const load = () =>
    listAccounts().accounts.map((a) => {
      const meta = accountMeta(a.name) || {};
      return {
        ...a,
        email: meta.email,
        plan: meta.plan,
        lastActivity: meta.lastActivity,
        _auth: meta, // internal; never rendered
        usage: null,
      };
    });
  let full = load();
  let usageLoading = false;
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
    if (finished) return;
    // Move cursor back to the top-left of the previous frame and redraw,
    // erasing any lines that are no longer part of the frame.
    if (prevHeight) process.stdout.write(MOVE_UP.repeat(prevHeight));
    process.stdout.write(GOTO_COL);
    const frame = buildTemplate(visible(), index, { query, mode, hint, version, usageLoading });
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

  let usageAbort = new AbortController();

  // Fetches live usage for every account that has tokens. Runs in the
  // background and re-renders as results come in. Does nothing once the
  // picker has finished, so it can never redraw over the exit message.
  const refreshUsage = async () => {
    if (finished) return;
    const targets = full.filter((a) => a._auth && a._auth.accountId && a._auth.accessToken);
    if (!targets.length) return;
    usageAbort = new AbortController();
    usageLoading = true;
    render();
    const map = await fetchAllUsages(targets, { signal: usageAbort.signal });
    if (finished) return;
    usageLoading = false;
    for (const a of full) {
      if (map[a.name]) a.usage = map[a.name];
    }
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
    // Re-establish the keypress pipeline in case askLine's readline interface
    // disturbed stdin; otherwise the picker stops responding after a prompt.
    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
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
      const dup = duplicateAccountOf(name);
      resume(
        `${T.ok}${G.check}${RESET} Saved '${name}'.${overwritten ? " (overwritten)" : ""}` +
          (dup ? ` ${T.warn}${G.dotStale}${RESET} same ChatGPT account as '${dup}'` : "")
      );
      refreshUsage();
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

  return new Promise((resolvePicker) => {
    let onKeypress;
    const onEnd = () => {
      if (!finished) finish(null);
    };
    const cleanup = () => {
      finished = true;
      usageAbort.abort();
      process.stdout.write(SHOW_CURSOR);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.removeListener("end", onEnd);
    };
    const finish = (name) => {
      cleanup();
      resolvePicker(name);
    };

    const doSwitch = (name) => {
      try {
        switchAccount(name);
        // Keep the frame on screen; print the confirmation below it and stop
        // any background redraw (refreshUsage) from painting over it.
        finished = true;
        usageAbort.abort();
        process.stdout.write(SHOW_CURSOR);
        console.log(`${T.ok}${G.dotActive}${RESET} Switched to '${name}' — restart Codex if it is running.`);
        finish(name);
      } catch (error) {
        hint = error.message;
        render();
      }
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
    process.stdin.on("end", onEnd);
    renderClean();
    refreshUsage();
  });
}
