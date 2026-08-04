import readline from "node:readline";
import { createRequire } from "node:module";

import {
  accountMeta,
  duplicateAccountOf,
  isLoggedIn,
  listAccounts,
  planLabel,
  readAuth,
  removeAccount,
  renameAccount,
  saveAccount,
  sharedWorkspaceOf,
  suggestAccountName,
  switchAccount,
  writeAuth,
} from "./core.js";
import { runCodexLogin } from "./login.js";
import { fetchUsage } from "./usage.js";

const require = createRequire(import.meta.url);
const version = require("../package.json").version;

// ── ANSI control sequences ────────────────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
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
    selectionBg: c("\x1b[48;5;23m"), // subtle selected-account row
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
      tl: "┌", tr: "┐", bl: "└", br: "┘", lt: "├", rt: "┤", h: "─", v: "│",
      cursor: "▸", select: "▌", dotActive: "●", dotStale: "◐", dotIdle: "•",
      up: "↑", down: "↓", enter: "↵", back: "←", sep: "·", check: "✓",
      barFull: "▓", barEmpty: "░", ellipsis: "…",
    };
  }
  return {
    tl: "+", tr: "+", bl: "+", br: "+", lt: "+", rt: "+", h: "-", v: "|",
    cursor: ">", select: ">", dotActive: "*", dotStale: "~", dotIdle: "o",
    up: "^", down: "v", enter: "Enter", back: "Bksp", sep: "-", check: "ok",
    barFull: "#", barEmpty: ".", ellipsis: "...",
  };
}

const G = pickGlyphs();

const cur = `${T.accent}${G.cursor}${RESET}`;
const rail = `${T.faint}${G.v}${RESET}`;

function selectedAccount(accounts, index) {
  return accounts.length ? accounts[index] : null;
}

// ── Pure renderer ───────────────────────────────────────────────────────────
// Geometry is passed in explicitly ({ columns, rows }) instead of reading
// process.stdout directly, so frames can be snapshot-tested at any size.

const MAX_FRAME_WIDTH = 80;
const MIN_FRAME_WIDTH = 24;
const MAX_VISIBLE_ACCOUNTS = 6;

function computeLayout(columns, rows) {
  const width = Math.max(MIN_FRAME_WIDTH, Math.min(columns - 2, MAX_FRAME_WIDTH));
  const inner = width - 2; // minus rail columns
  // Keep account rows visually quiet at every width: email gets a dedicated
  // second line from 48 cols upward, and moves into the detail panel below 48.
  const showListEmail = columns >= 48;
  // Narrow layouts need one extra detail row because the selected account's
  // email moves out of the list and into the usage panel.
  const detailRows = showListEmail ? 3 : 4;
  return { width, inner, columns, rows, showListEmail, detailRows };
}

function statusLabel(acc) {
  if (!acc.active) return { text: "", color: "" };
  if (acc.matched) return { text: `${G.dotActive} CURRENT`, color: T.ok };
  return { text: `${G.dotStale} AUTH CHANGED`, color: T.warn };
}

// Returns the scroll offset that keeps `index` visible inside a `pageSize`
// window, centered when possible. Pure so it is easily unit-tested.
function scrollStart(accounts, index, pageSize) {
  if (!accounts.length || pageSize <= 0) return 0;
  const maxStart = Math.max(0, accounts.length - pageSize);
  return Math.max(0, Math.min(index - Math.floor((pageSize - 1) / 2), maxStart));
}

// Renders one account as a quiet name/status row plus a dedicated email row
// when space permits. Below 48 columns the email moves to the detail panel.
function renderAccountRow(acc, isSelected, ctx) {
  const { inner, showListEmail } = ctx;
  const avail = inner - 2;
  const cursor = isSelected ? `${T.accent}${G.select}${RESET}` : " ";
  const nameColor = isSelected ? T.bright : acc.active ? T.bright : DIM;
  const name = `${nameColor}${acc.name}${RESET}`;
  const badge = statusLabel(acc);
  const badgeText = badge.text ? `${badge.color}${badge.text}${RESET}` : "";
  const left = `${cursor} ${name}`;
  const badgeGap = badgeText ? 1 + displayWidth(badgeText) : 0;
  const pad = Math.max(0, avail - displayWidth(left) - badgeGap);
  const line1 = `${left}${spaceN(pad)}${badgeText ? ` ${badgeText}` : ""}`;
  if (showListEmail && acc.email) {
    // Align the email with the account name, regardless of name length.
    const indent = 2;
    const line2 = `${" ".repeat(indent)}${DIM}${acc.email}${RESET}`;
    return [line1, line2];
  }
  return [line1];
}

// The usage / detail panel: a labeled divider plus a fixed-height content area
// so the frame height never jumps between selections.
function renderDetailPanel(acc, ctx, opts) {
  const { inner, showListEmail, detailRows } = ctx;
  const line = ctx.line;
  const blank = ctx.blank;
  const lines = [];
  const divider = (label) => {
    const visibleLabel = label ? clip(label, Math.max(0, inner - 4)) : "";
    const body = visibleLabel ? `${G.h} ${visibleLabel} ` : "";
    const fill = Math.max(0, inner - displayWidth(body));
    return `${T.faint}${G.lt}${body}${G.h.repeat(fill)}${G.rt}${RESET}`;
  };

  const content = [];
  if (acc) {
    // Below 48 cols the email is hidden from the list, so surface it here.
    if (!showListEmail && acc.email) content.push(`${DIM}${acc.email}${RESET}`);
    const usage = acc.usage;
    if (usage && !usage.error) {
      const primary = pctOrDash(usage.primary);
      const secondary = pctOrDash(usage.secondary);
      const credits =
        usage.credits && typeof usage.credits.usedPercent === "number"
          ? usage.credits.usedPercent
          : null;
      if (primary != null)
        content.push(`${DIM}${windowLabel(usage.primary.windowSeconds)}${RESET}  ${bar(primary)} ${DIM}used${RESET}`);
      if (secondary != null)
        content.push(`${DIM}${windowLabel(usage.secondary.windowSeconds)}${RESET}  ${bar(secondary)} ${DIM}used${RESET}`);
      if (credits != null)
        content.push(`${DIM}credits${RESET}  ${bar(credits)} ${DIM}used${RESET}`);
      if (primary == null && secondary == null && credits == null)
        content.push(`${DIM}no usage data${RESET}`);
    } else if (usage && usage.error) {
      content.push(`${DIM}usage unavailable${RESET}`);
    } else if (opts.usageLoading) {
      content.push(`${DIM}fetching usage${G.ellipsis}${RESET}`);
    } else {
      content.push(`${DIM}no usage data yet${RESET}`);
    }
    if (opts.usageUpdatedAt) {
      content.push(`${DIM}Updated${RESET}  ${relativeTime(opts.usageUpdatedAt)}`);
    } else if (acc.lastActivity) {
      content.push(`${DIM}last activity${RESET}  ${relativeTime(acc.lastActivity)}`);
    }
  }

  const plan = acc ? usagePlanLabel(acc) : null;
  lines.push(divider(acc ? ["Usage", acc.name, plan].filter(Boolean).join(" · ") : ""));
  for (let i = 0; i < detailRows; i++) {
    lines.push(content[i] ? line(content[i]) : blank());
  }
  lines.push(blank());
  return lines;
}

// The two key-hint footer lines for list (nav / search) modes.
function renderFooter(mode, ctx, hint = "") {
  const { inner } = ctx;
  const line = ctx.line;
  const compact = inner < 44;
  const sep = compact ? `${DIM}  ${RESET}` : `${T.faint} ${G.sep} ${RESET}`;
  const D = (s) => `${DIM}${s}${RESET}`;
  if (mode === "search") {
    return [
      line(`${D(G.up)}/${D(G.down)} ${compact ? "move" : "navigate"}${sep}${D(G.enter)} switch${sep}${D("Esc")} close`),
      line(`${D("type")} filter${sep}${D(G.back)} erase${sep}${D("u")} usage`),
    ];
  }
  if (hint) {
    return [
      line(hint),
      line(`${D("u")} usage${sep}${D("a")} add${sep}${D("r")} rename${sep}${D("d")} delete${sep}${D("q")} quit`),
    ];
  }
  return [
    line(`${D(G.up)}/${D(G.down)} ${compact ? "move" : "navigate"}${sep}${D(G.enter)} switch${sep}${D("/")} search`),
    line(`${D("u")} usage${sep}${D("a")} add${sep}${D("r")} rename${sep}${D("d")} delete${sep}${D("q")} quit`),
  ];
}

export function buildTemplate(accounts, index, opts = {}) {
  const {
    query = "",
    mode = "nav",
    hint = "",
    version = "",
    usageLoading = false,
    usageUpdatedAt = null,
    columns = process.stdout.columns || 80,
    rows = process.stdout.rows || 24,
    input = "",
    addStep = 1,
    addMethod = "browser",
    confirmName = "",
    suggested = "default",
    totalCount = accounts.length,
  } = opts;

  const layout = computeLayout(columns, rows);
  const { width, inner, showListEmail, detailRows } = layout;
  // Clips to inner-2 so the appended ellipsis still fits within the frame.
  const text = (s) => clip(s, inner - 2);
  // A fully-padded content line: rail + content + fill + rail, always `width` wide.
  const line = (s, selected = false) => {
    const t = text(s);
    const content = ` ${t}${spaceN(Math.max(0, inner - 1 - displayWidth(t)))}`;
    if (selected && T.selectionBg) {
      // Inline foreground resets would otherwise cancel the row background;
      // reapply it after each reset until the content cell is complete.
      const painted = content.replaceAll(RESET, `${RESET}${T.selectionBg}`);
      return `${rail}${T.selectionBg}${painted}${RESET}${rail}`;
    }
    return `${rail}${content}${rail}`;
  };
  const blank = () => `${rail} ${" ".repeat(inner - 1)}${rail}`;
  const ctx = { ...layout, text, line, blank, sep: `${T.faint} ${G.sep} ${RESET}` };
  const lines = [];

  // ── Title bar ────────────────────────────────────────────────────────────
  const countLabel =
    mode === "search" && query.trim() ? `${accounts.length}/${totalCount}` : String(totalCount);
  const left = `${T.faint}${G.tl}${G.h} ${RESET}`;
  const right = `${T.faint} ${G.tr}${RESET}`;
  let titleText = `${BOLD}xacc${RESET}${T.faint} ${G.sep} Accounts ${countLabel}${RESET}`;
  const budget = width - displayWidth(left + right);
  // Drop the version suffix, then clip, so the top border never exceeds the frame.
  if (version && displayWidth(titleText + `${T.faint}  v${version}${RESET}`) <= budget) {
    titleText = `${titleText}${T.faint}  v${version}${RESET}`;
  }
  if (displayWidth(titleText) > budget) titleText = clip(titleText, Math.max(0, budget - 1));
  lines.push(`${left}${titleText}${spaceN(budget - displayWidth(titleText))}${right}`);

  const isModal = mode === "add" || mode === "rename" || mode === "delete";
  // Search needs a visible input row. Modal validation errors stay near their
  // prompt; navigation toasts reuse the footer instead of reserving empty
  // space beneath the title.
  if (mode === "search") {
    lines.push(line(`${T.accent}search${RESET}${T.faint}|${RESET} ${query}${T.faint}_${RESET}`));
  } else if (isModal && hint) {
    lines.push(line(hint));
  }
  if (isModal) {
    renderModal(lines, ctx, { mode, input, addStep, addMethod, confirmName, suggested });
    lines.push(`${T.faint}${G.bl}${G.h.repeat(inner)}${G.br}${RESET}`);
    return lines;
  }

  // ── Account list (paginated to the terminal height) ──────────────────────
  const lpa = showListEmail ? 2 : 1; // lines per account
  // Keep the dashboard compact when only a few accounts exist, while still
  // reserving a stable number of rows during filtering. Larger collections
  // scroll inside a six-account viewport instead of stretching the frame to
  // fill the terminal.
  const fixed = 1 + (mode === "search" ? 1 : 0) + (1 + detailRows + 1) + 2 + 1;
  const capacity = Math.max(1, Math.floor((rows - fixed) / lpa));
  const pageSize = Math.max(
    1,
    Math.min(totalCount || accounts.length || 1, MAX_VISIBLE_ACCOUNTS, capacity)
  );
  const selected = selectedAccount(accounts, index);

  if (accounts.length === 0) {
    lines.push(line(`${DIM}no matches for '${query}'${RESET}`));
  } else {
    const start = scrollStart(accounts, index, pageSize);
    let rendered = 0;
    let shown = 0;
    for (let i = start; i < accounts.length && shown < pageSize; i++) {
      const isSelected = i === index;
      const rowLines = renderAccountRow(accounts[i], isSelected, ctx);
      for (const rl of rowLines) {
        lines.push(line(rl, isSelected));
        rendered++;
      }
      while (rendered < (shown + 1) * lpa) {
        lines.push(line("", isSelected));
        rendered++;
      }
      shown++;
    }
    while (rendered < pageSize * lpa) {
      lines.push(blank());
      rendered++;
    }
  }

  // ── Detail / usage panel ─────────────────────────────────────────────────
  for (const d of renderDetailPanel(selected, ctx, { usageLoading, usageUpdatedAt, query })) {
    lines.push(d);
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  for (const f of renderFooter(mode, ctx, hint)) {
    lines.push(f);
  }
  lines.push(`${T.faint}${G.bl}${G.h.repeat(inner)}${G.br}${RESET}`);

  return lines;
}

// Inline modal frames for add / rename / delete that replace the old
// suspend()/askLine() flow with in-frame prompts.
function renderModal(lines, ctx, o) {
  const line = ctx.line;
  const blank = ctx.blank;
  const D = (s) => `${DIM}${s}${RESET}`;

  if (o.mode === "add") {
    if (o.addStep === 1) {
      lines.push(line(`${T.accent}Add account · Step 1 of 2${RESET}`));
      lines.push(blank());
      for (const m of ["browser", "device"]) {
        const sel = m === o.addMethod;
        const label = m === "browser" ? "Browser login" : "Device-code login";
        const detail = m === "browser" ? "interactive, opens your browser" : "headless, paste a code on another device";
        lines.push(line(`${sel ? cur : " "} ${sel ? T.accent : DIM}${label}${RESET}${D(`  ${detail}`)}`));
        lines.push(blank());
      }
      lines.push(line(`${D(G.enter)} continue${ctx.sep}${D("Esc")} cancel`));
      lines.push(line(`${D(G.up)}/${D(G.down)} choose method`));
    } else {
      lines.push(line(`${T.accent}Add account · Step 2 of 2${RESET}`));
      lines.push(blank());
      lines.push(line(`${DIM}Save this login as:${RESET}`));
      lines.push(blank());
      const shown = o.input ? o.input : D(`(default: ${o.suggested})`);
      lines.push(line(`${T.accent}>${RESET} ${shown}${T.accent}_${RESET}`));
      lines.push(blank());
      lines.push(line(`${D(G.enter)} save${ctx.sep}${D("Esc")} back to method`));
    }
    return;
  }

  if (o.mode === "rename") {
    lines.push(line(`${T.accent}Rename account${RESET}`));
    lines.push(blank());
    lines.push(line(`${DIM}New name:${RESET}`));
    lines.push(blank());
    lines.push(line(`${T.accent}>${RESET} ${o.input}${T.accent}_${RESET}`));
    lines.push(blank());
    lines.push(line(`${D(G.enter)} rename${ctx.sep}${D("Esc")} cancel`));
    return;
  }

  // delete
  lines.push(line(`${T.accent}Delete account${RESET}`));
  lines.push(blank());
  lines.push(line(`${DIM}Delete '${o.confirmName}'?${RESET}`));
  lines.push(blank());
  lines.push(line(`${DIM}Removes the saved auth snapshot. The live login is untouched.${RESET}`));
  lines.push(blank());
  lines.push(line(`${T.ok}y${RESET} yes${ctx.sep}${D("n")} no${ctx.sep}${D("Esc")} cancel`));
}

// A 12-cell usage bar. The fill color follows the limit: healthy, high, then
// near-limit. `NO_COLOR` (via T) keeps the cells readable, dropping the % tint.
function bar(percent) {
  const cells = 12;
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
        usageUpdatedAt: null,
      };
    });
  let full = load();
  let usageLoadingName = null;
  let query = "";
  let mode = "nav";
  let hint = "";
  let prevHeight = 0;
  let finished = false;

  // Inline-prompt (modal) state for the add / rename / delete flows.
  let input = "";
  let addStep = 1;
  let addMethod = "browser";
  let confirmName = "";
  let suggested = "default";
  let addPriorAuth = null;
  let addHasAuthenticated = false;

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
    const renderedAccounts = visible();
    const selected = selectedAccount(renderedAccounts, index);
    const frame = buildTemplate(renderedAccounts, index, {
      query,
      mode,
      hint,
      version,
      usageLoading: selected?.name === usageLoadingName,
      usageUpdatedAt: selected?.usageUpdatedAt || null,
      input,
      addStep,
      addMethod,
      confirmName,
      suggested,
      totalCount: full.length,
    });
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

  // Usage is an explicit, selected-account action. Opening the TUI, moving the
  // selection, saving, and switching remain local-only operations.
  const refreshUsage = async () => {
    if (finished) return;
    const target = list[index];
    if (!target?._auth?.accountId || !target?._auth?.accessToken) {
      hint = "Usage is unavailable for this account.";
      render();
      return;
    }
    usageAbort.abort();
    const controller = new AbortController();
    usageAbort = controller;
    usageLoadingName = target.name;
    target.usage = null;
    target.usageUpdatedAt = null;
    hint = "";
    render();
    try {
      const usage = await fetchUsage(target._auth, { signal: controller.signal });
      if (finished || usageAbort !== controller) return;
      const current = full.find((account) => account.name === target.name);
      if (current) {
        current.usage = usage;
        current.usageUpdatedAt = Date.now();
      }
    } catch (error) {
      if (finished || usageAbort !== controller) return;
      const current = full.find((account) => account.name === target.name);
      if (current) current.usage = { error: error?.message || "usage unavailable" };
    } finally {
      if (!finished && usageAbort === controller) {
        usageLoadingName = null;
        render();
      }
    }
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

  // ── Flows that leave the picker (external process) ───────────────────────
  const suspend = () => {
    clearFrame();
    process.stdout.write(SHOW_CURSOR);
    process.stdin.setRawMode(false);
  };
  const backToPicker = (msg) => {
    hint = msg || "";
    process.stdin.setRawMode(true);
    renderClean();
    process.stdout.write(HIDE_CURSOR);
    // Re-establish the keypress pipeline after an external process disturbed
    // stdin; otherwise the picker stops responding.
    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
  };

  // Add · step 1 → run the real 'codex login' (browser or device-code), then
  // advance to the in-frame name prompt.
  const runLogin = async () => {
    suspend();
    const device = addMethod === "device";
    console.log(
      device
        ? "Running 'codex login --device-auth'... open the shown URL on any device."
        : "Running 'codex login'... complete the login in your browser."
    );
    const { ok } = await runCodexLogin("codex", ["login", ...(device ? ["--device-auth"] : [])]);
    if (!ok) {
      addStep = 1;
      backToPicker(`Could not run 'codex login' (is Codex installed? did the login succeed?).`);
      return;
    }
    addHasAuthenticated = true;
    full = load();
    suggested = suggestAccountName() || "default";
    input = suggested === "default" ? "" : suggested;
    addStep = 2;
    backToPicker();
  };

  const saveNewAccount = () => {
    const name = (input.trim() || suggested || "default").trim();
    try {
      saveAccount(name);
      full = load();
      const dup = duplicateAccountOf(name);
      const ws = sharedWorkspaceOf(name);
      addHasAuthenticated = false;
      addPriorAuth = null;
      mode = "nav";
      refreshList();
      backToPicker(
        `${T.ok}${G.check}${RESET} Saved '${name}'.` +
          (dup ? ` ${T.warn}${G.dotStale}${RESET} Already saved as '${dup}'.` : "") +
          (ws ? ` ${T.warn}${G.dotStale}${RESET} Shared workspace with '${ws}'.` : "")
      );
    } catch (error) {
      hint = error.message;
      render();
    }
  };

  const doRename = () => {
    const current = list[index];
    const newName = input.trim();
    if (!newName || newName === current.name) {
      mode = "nav";
      backToPicker();
      return;
    }
    try {
      renameAccount(current.name, newName);
      full = load();
      mode = "nav";
      refreshList();
      backToPicker(`${T.ok}${G.check}${RESET} Renamed '${current.name}' -> '${newName}'.`);
    } catch (error) {
      hint = error.message;
      render();
    }
  };

  const doDelete = () => {
    try {
      removeAccount(confirmName);
      full = load();
      mode = "nav";
      refreshList();
      backToPicker(`${T.ok}${G.check}${RESET} Deleted '${confirmName}'.`);
    } catch (error) {
      mode = "nav";
      refreshList();
      backToPicker(error.message);
    }
  };

  const moveIndex = (delta) => {
    if (!list.length) return;
    index = (index + delta + list.length) % list.length;
    hint = "";
    render();
  };

  return new Promise((resolvePicker) => {
    let onKeypress;
    const onEnd = () => {
      if (!finished) finish(null);
    };
    const cleanup = () => {
      if (mode === "add" && addHasAuthenticated) {
        writeAuth(addPriorAuth);
        addHasAuthenticated = false;
      }
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
        // Stay in the picker so the user can switch again in the same session.
        // Reload the list to repaint the new active account. Usage remains an
        // explicit `u` action and is never fetched merely because of a switch.
        full = load();
        if (!query.trim()) {
          const newActive = full.findIndex((a) => a.active);
          if (newActive >= 0) index = newActive;
        }
        refreshList();
        backToPicker(`${T.ok}${G.dotActive}${RESET} Switched to '${name}' — restart Codex if it is running.`);
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

      // ── Modal modes (add / rename / delete) ─────────────────────────────
      if (mode === "add") {
        if (addStep === 1) {
          if (key.name === "up" || key.name === "down") {
            addMethod = addMethod === "browser" ? "device" : "browser";
            render();
          } else if (key.name === "return" || key.name === "enter") {
            runLogin();
          } else if (key.name === "escape") {
            if (addHasAuthenticated) writeAuth(addPriorAuth);
            addHasAuthenticated = false;
            addPriorAuth = null;
            mode = "nav";
            render();
          }
        } else {
          if (key.name === "escape") {
            writeAuth(addPriorAuth);
            addHasAuthenticated = false;
            full = load();
            refreshList();
            addStep = 1;
            hint = "";
            render();
          } else if (key.name === "return" || key.name === "enter") {
            saveNewAccount();
          } else if (key.name === "backspace") {
            input = input.slice(0, -1);
            render();
          } else if (str && /^[\x20-\x7e]$/.test(str)) {
            input += str;
            render();
          }
        }
        return;
      }
      if (mode === "rename") {
        if (key.name === "escape") {
          mode = "nav";
          render();
        } else if (key.name === "return" || key.name === "enter") {
          doRename();
        } else if (key.name === "backspace") {
          input = input.slice(0, -1);
          render();
        } else if (str && /^[\x20-\x7e]$/.test(str)) {
          input += str;
          render();
        }
        return;
      }
      if (mode === "delete") {
        if (key.name === "y") {
          doDelete();
        } else if (key.name === "n" || key.name === "escape") {
          mode = "nav";
          render();
        }
        return;
      }

      if (mode === "search") {
        if (key.name === "escape") {
          mode = "nav";
          refreshList();
          render();
        } else if (key.name === "up") {
          moveIndex(-1);
        } else if (key.name === "down") {
          moveIndex(1);
        } else if (key.name === "return" || key.name === "enter") {
          const current = list[index];
          if (current) doSwitch(current.name);
        } else if (key.name === "u") {
          refreshUsage();
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
          moveIndex(-1);
          break;
        case "down":
          moveIndex(1);
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
          if (full.length) {
            addPriorAuth = readAuth();
            addHasAuthenticated = false;
            mode = "add";
            addStep = 1;
            addMethod = "browser";
            hint = "";
            render();
          }
          break;
        case "r": {
          const current = list[index];
          if (current) {
            mode = "rename";
            input = current.name;
            hint = "";
            render();
          }
          break;
        }
        case "d": {
          const current = list[index];
          if (current) {
            mode = "delete";
            confirmName = current.name;
            hint = "";
            render();
          }
          break;
        }
        case "u":
          refreshUsage();
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
  });
}
