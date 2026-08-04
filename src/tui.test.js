import test from "node:test";
import assert from "node:assert/strict";

import { buildTemplate } from "./tui.js";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const text = (block) => block.map(strip);
const join = (block) => text(block).join("\n");
const maxWidth = (block) => Math.max(...text(block).map((l) => l.length));

function acc(name, over = {}) {
  return { name, active: false, matched: false, email: null, plan: null, lastActivity: null, usage: null, ...over };
}

const many = (n) => Array.from({ length: n }, (_, i) => acc(`account-${String(i).padStart(2, "0")}`));

// ── Responsive layout ──────────────────────────────────────────────────────
test("every frame row fits within the requested width at 40, 60, and 90 cols", () => {
  const accounts = [acc("personal", { active: true, matched: true, email: "me@example.com" }), acc("work", { email: "me+work@example.com" })];
  for (const columns of [40, 60, 90]) {
    const block = buildTemplate(accounts, 0, { columns, rows: 24, version: "0.1.16" });
    assert.ok(maxWidth(block) <= columns, `columns=${columns} overflow (max ${maxWidth(block)})`);
  }
});

test("frame never exceeds the requested terminal height", () => {
  const accounts = many(30);
  for (const rows of [16, 24, 40]) {
    const block = buildTemplate(accounts, 0, { columns: 90, rows, version: "0.1.16" });
    assert.ok(block.length <= rows, `rows=${rows} overflow: ${block.length}`);
  }
});

test("account list is paginated: not all accounts render when space is tight", () => {
  const accounts = many(50);
  const block = buildTemplate(accounts, 0, { columns: 90, rows: 16, version: "0.1.16" });
  const visible = join(block);
  assert.ok(visible.includes("account-00"));
  const rendered = accounts.filter((a) => visible.includes(a.name)).length;
  assert.ok(rendered < accounts.length, "all 50 accounts should not fit in 16 rows");
});

test("scroll keeps the selected account visible when index is past the page", () => {
  const accounts = many(50);
  const block = buildTemplate(accounts, 45, { columns: 90, rows: 16, version: "0.1.16" });
  assert.ok(join(block).includes("account-45"), "selected account must be visible");
});

test("email renders inline at 76+ cols, on a second line at 48-75, and is hidden below 48", () => {
  const accounts = [acc("personal", { email: "me@example.com" })];
  const wide = text(buildTemplate(accounts, 0, { columns: 90, rows: 24 }));
  const wideLine = wide.find((l) => l.includes("personal"));
  assert.ok(wideLine.includes("me@example.com"), "inline email at wide widths");

  const mid = text(buildTemplate(accounts, 0, { columns: 60, rows: 24 }));
  const midEmailLine = mid.find((l) => l.includes("me@example.com"));
  assert.ok(midEmailLine && !midEmailLine.includes("personal"), "email on its own line at mid widths");

  const narrow = text(buildTemplate(accounts, 0, { columns: 40, rows: 24 }));
  const narrowNameLine = narrow.find((l) => l.includes("personal"));
  assert.ok(narrowNameLine && !narrowNameLine.includes("me@example.com"), "email not inline at narrow width");
  assert.ok(narrow.some((l) => l.includes("me@example.com")), "email shown only in the detail panel below 48");
});

test("a long email is clipped to the frame width instead of overflowing", () => {
  const accounts = [acc("personal", { email: "very.long.email.address.that.never.fits@example.com" })];
  for (const columns of [40, 60, 90]) {
    const block = buildTemplate(accounts, 0, { columns, rows: 24 });
    assert.ok(maxWidth(block) <= columns, `long email overflow at ${columns}`);
  }
});

// ── Status semantics ───────────────────────────────────────────────────────
test("status badges reflect active/matched: CURRENT, AUTH CHANGED, SAVED", () => {
  const accounts = [
    acc("current", { active: true, matched: true }),
    acc("changed", { active: true, matched: false }),
    acc("saved", { active: false, matched: false }),
  ];
  const joinAll = join(buildTemplate(accounts, 0, { columns: 90, rows: 24 }));
  assert.match(joinAll, /CURRENT/);
  assert.match(joinAll, /AUTH CHANGED/);
  assert.match(joinAll, /SAVED/);
});

test("plan label appears on the account row", () => {
  const accounts = [acc("personal", { plan: "plus" })];
  assert.match(join(buildTemplate(accounts, 0, { columns: 90, rows: 24 })), /PLUS/);
});

// ── Detail / usage panel ───────────────────────────────────────────────────
test("usage items each render on their own line with the used percent", () => {
  const accounts = [
    acc("work", {
      plan: "pro",
      lastActivity: Date.now() - 2 * 3600 * 1000,
      usage: {
        plan: "pro",
        primary: { usedPercent: 94, windowSeconds: 604800 },
        secondary: null,
        credits: null,
      },
    }),
  ];
  const all = join(buildTemplate(accounts, 0, { columns: 90, rows: 24 }));
  assert.match(all, /94%/);
  assert.match(all, /1w/);
  assert.match(all, /2 hours ago/);
});

test("fetching indicator shows while usage loads", () => {
  const accounts = [acc("work", { plan: "free" })];
  const all = join(buildTemplate(accounts, 0, { columns: 90, rows: 24, usageLoading: true }));
  assert.match(all, /fetching usage/);
});

test("usage panel height stays fixed whether or not data is present", () => {
  const withData = buildTemplate([acc("a", { usage: { plan: "plus", primary: { usedPercent: 50, windowSeconds: 3600 }, secondary: null, credits: null } })], 0, { columns: 90, rows: 24 });
  const without = buildTemplate([acc("b")], 0, { columns: 90, rows: 24 });
  // Two columns render identically sized detail panels (fixed DETAIL_ROWS).
  assert.equal(withData.length, without.length);
});

// ── Search mode ────────────────────────────────────────────────────────────
test("search mode shows the query and a filter status line", () => {
  const accounts = [acc("personal"), acc("work"), acc("hobby")];
  const all = join(buildTemplate(accounts, 0, { columns: 90, rows: 24, mode: "search", query: "wor" }));
  assert.match(all, /search/);
  assert.match(all, /wor/);
});

// ── Modal modes ────────────────────────────────────────────────────────────
test("add step 1 lists login methods and a keyboard footer", () => {
  const block = buildTemplate([acc("a")], 0, { columns: 90, rows: 24, mode: "add", addStep: 1, addMethod: "browser" });
  const all = join(block);
  assert.match(all, /Step 1 of 2/);
  assert.match(all, /Browser login/);
  assert.match(all, /Device-code login/);
  assert.match(all, /Esc/);
});

test("add step 2 shows a name prompt", () => {
  const all = join(buildTemplate([acc("a")], 0, { columns: 90, rows: 24, mode: "add", addStep: 2, input: "work"}));
  assert.match(all, /Step 2 of 2/);
  assert.match(all, /Save this login as/);
  assert.ok(all.includes("work"));
});

test("rename and delete modals render their prompts and confirm", () => {
  const renameText = join(buildTemplate([acc("a")], 0, { columns: 90, rows: 24, mode: "rename", input: "b" }));
  assert.match(renameText, /Rename account/);
  assert.match(renameText, /New name:/);

  const deleteText = join(buildTemplate([acc("a")], 0, { columns: 90, rows: 24, mode: "delete", confirmName: "a" }));
  assert.match(deleteText, /Delete account/);
  assert.match(deleteText, /Delete 'a'\?/);
});