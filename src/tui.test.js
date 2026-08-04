import test from "node:test";
import assert from "node:assert/strict";

import { buildTemplate } from "./tui.js";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const text = (block) => block.map(strip);
const join = (block) => text(block).join("\n");
const maxWidth = (block) => Math.max(...text(block).map((l) => l.length));

function acc(name, over = {}) {
  const account = { name, active: false, matched: false, email: null, plan: null, lastActivity: null, usage: null, ...over };
  account.status ??= account.active ? (account.matched ? "current" : "unsaved-login") : "saved";
  return account;
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

test("a small account list stays compact instead of filling a tall terminal", () => {
  const accounts = [acc("personal"), acc("work")];
  const wide = buildTemplate(accounts, 0, { columns: 90, rows: 40 });
  const mid = buildTemplate(accounts, 0, { columns: 60, rows: 40 });
  assert.ok(wide.length < 20, `wide frame should be compact, got ${wide.length} rows`);
  assert.ok(mid.length < 20, `mid frame should be compact, got ${mid.length} rows`);
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

test("email renders on a quiet second line at 48+ cols and moves to detail below 48", () => {
  const accounts = [acc("personal", { email: "me@example.com" })];
  const wide = text(buildTemplate(accounts, 0, { columns: 90, rows: 24 }));
  const wideNameLine = wide.find((l) => l.includes("personal"));
  const wideEmailLine = wide.find((l) => l.includes("me@example.com"));
  assert.ok(wideEmailLine && !wideEmailLine.includes("personal"), "email gets its own line at wide widths");
  assert.equal(wideEmailLine.indexOf("me@example.com"), wideNameLine.indexOf("personal"));

  const mid = text(buildTemplate(accounts, 0, { columns: 60, rows: 24 }));
  const midNameLine = mid.find((l) => l.includes("personal"));
  const midEmailLine = mid.find((l) => l.includes("me@example.com"));
  assert.ok(midEmailLine && !midEmailLine.includes("personal"), "email on its own line at mid widths");
  assert.equal(
    midEmailLine.indexOf("me@example.com"),
    midNameLine.indexOf("personal"),
    "second-line email aligns with the account name"
  );

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
test("status badges distinguish current, updated, and unsaved logins", () => {
  const accounts = [
    acc("current", { active: true, matched: true, status: "current" }),
    acc("updated", { active: true, matched: false, status: "session-updated" }),
    acc("changed", { active: true, matched: false, status: "unsaved-login" }),
    acc("saved", { active: false, matched: false }),
  ];
  const joinAll = join(buildTemplate(accounts, 0, { columns: 90, rows: 24 }));
  assert.match(joinAll, /CURRENT/);
  assert.match(joinAll, /SESSION UPDATED/);
  assert.match(joinAll, /UNSAVED LOGIN/);
  const savedLine = text(buildTemplate(accounts, 0, { columns: 90, rows: 24 }))
    .find((line) => line.includes("saved"));
  assert.doesNotMatch(savedLine, /CURRENT|UPDATED|LOGIN/);
});

test("unsaved login state replaces usage with a recovery action", () => {
  const account = acc("personal", { active: true, status: "unsaved-login" });
  const all = join(buildTemplate([account], 0, {
    columns: 90,
    rows: 24,
    liveEmail: "other@example.com",
  }));
  assert.match(all, /Account status · personal/);
  assert.match(all, /Unsaved login detected/);
  assert.match(all, /other@example.com/);
  assert.match(all, /Press A to save it/);
});

test("plan label moves from the account row into the selected detail heading", () => {
  const accounts = [acc("personal", { plan: "plus" })];
  const block = buildTemplate(accounts, 0, { columns: 90, rows: 24 });
  const lines = text(block);
  assert.doesNotMatch(lines.find((line) => line.includes("personal")), /PLUS/);
  assert.match(lines.find((line) => line.includes("Usage")), /Usage · personal · Plus/);
});

test("selected account has a left rail and a subtle full-row background", () => {
  const block = buildTemplate([acc("personal"), acc("work")], 0, { columns: 60, rows: 24 });
  const selected = block.find((line) => line.includes("personal"));
  assert.match(strip(selected), /[▌>]/);
  if (process.env.NO_COLOR === undefined) assert.match(selected, /\x1b\[48;5;23m/);
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

test("empty usage panel explains manual lookup and stale cached data", () => {
  const empty = join(buildTemplate([acc("work")], 0, { columns: 90, rows: 24 }));
  assert.match(empty, /Press U to load usage/);
  assert.match(empty, /Only this account/);

  const stale = join(buildTemplate([
    acc("work", { usage: { plan: "plus", primary: { usedPercent: 10, windowSeconds: 3600 }, secondary: null, credits: null } }),
  ], 0, { columns: 90, rows: 24, usageUpdatedAt: Date.now() - 2 * 86400 * 1000, usageStale: true }));
  assert.match(stale, /Last known/);
  assert.match(stale, /U refresh/);
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
  assert.match(all, /navigate/);
  assert.match(all, /switch/);
  assert.doesNotMatch(all, /apply/);
});

test("navigation toast reuses the footer instead of adding an empty top row", () => {
  const accounts = [acc("personal")];
  const normal = buildTemplate(accounts, 0, { columns: 60, rows: 24 });
  const toasted = buildTemplate(accounts, 0, { columns: 60, rows: 24, hint: "Switched to personal" });
  assert.equal(toasted.length, normal.length);
  const lines = text(toasted);
  assert.ok(lines.findIndex((line) => line.includes("Switched to personal")) > lines.findIndex((line) => line.includes("Usage")));
});

test("navigation footer keeps core actions and moves secondary actions to help", () => {
  const all = join(buildTemplate([acc("personal")], 0, { columns: 90, rows: 24 }));
  assert.match(all, /Enter|↵/);
  assert.match(all, /search/);
  assert.match(all, /help/);
  assert.doesNotMatch(all, /rename.*delete/);
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
  const all = join(buildTemplate([acc("a")], 0, {
    columns: 90,
    rows: 24,
    mode: "add",
    addStep: 2,
    input: "work",
    detectedEmail: "work@example.com",
    detectedWorkspace: "…space-01",
  }));
  assert.match(all, /Step 2 of 2/);
  assert.match(all, /work@example.com/);
  assert.match(all, /Workspace/);
  assert.match(all, /Save this login as/);
  assert.ok(all.includes("work"));
});

test("add step 2 blocks a duplicate before creating another profile", () => {
  const all = join(buildTemplate([acc("a")], 0, {
    columns: 90,
    rows: 24,
    mode: "add",
    addStep: 2,
    duplicateName: "personal",
    detectedEmail: "me@example.com",
  }));
  assert.match(all, /Already saved as 'personal'/);
  assert.doesNotMatch(all, /Save this login as/);
});

test("empty, help, and daily-refresh consent screens stay inside the frame", () => {
  const empty = join(buildTemplate([], 0, { columns: 60, rows: 24, mode: "empty" }));
  assert.match(empty, /No accounts saved yet/);
  assert.match(empty, /Add your first Codex account/);

  const help = join(buildTemplate([acc("a")], 0, { columns: 60, rows: 24, mode: "help" }));
  assert.match(help, /Keyboard help/);
  assert.match(help, /Shift\+U/);

  const consent = join(buildTemplate([acc("a")], 0, { columns: 60, rows: 24, mode: "usage-consent" }));
  assert.match(consent, /Daily usage refresh/);
  assert.match(consent, /manual only/);
});

test("rename and delete modals render their prompts and confirm", () => {
  const renameText = join(buildTemplate([acc("a")], 0, { columns: 90, rows: 24, mode: "rename", input: "b" }));
  assert.match(renameText, /Rename account/);
  assert.match(renameText, /New name:/);

  const deleteText = join(buildTemplate([acc("a")], 0, { columns: 90, rows: 24, mode: "delete", confirmName: "a" }));
  assert.match(deleteText, /Delete account/);
  assert.match(deleteText, /Delete 'a'\?/);
});
