import test from "node:test";
import assert from "node:assert/strict";

import { buildTemplate } from "./tui.js";

const ACCOUNTS = [
  { name: "personal", active: true, matched: true },
  { name: "work", active: false, matched: false },
];

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("buildTemplate renders a bordered frame with title and accounts", () => {
  const block = buildTemplate(ACCOUNTS, 0, { version: "0.1.3" });

  assert.match(block[0], /xacc/); // title bar
  assert.match(block[0], /0\.1\.3/); // version
  assert.match(strip(block[block.length - 1]), /^[+└]/); // bottom border
  assert.match(strip(block.join("\n")), /Accounts/);
  assert.match(strip(block.join("\n")), /personal/);
  assert.match(strip(block.join("\n")), /work/);
});

test("buildTemplate highlights the selected account and badges the active one", () => {
  const block = buildTemplate(ACCOUNTS, 1, { version: "0.1.3" });
  const text = block.join("\n");

  const selectedLine = block.find((l) => /work/.test(l));
  assert.match(selectedLine, /[▸>]/); // cursor on the selected row
  assert.doesNotMatch(selectedLine, /active/); // work is not active

  const activeLine = block.find((l) => /personal/.test(l));
  assert.match(activeLine, /active/); // active badge
});

test("buildTemplate search mode shows query and search key hints", () => {
  const block = buildTemplate(ACCOUNTS, 0, { mode: "search", query: "wor", version: "0.1.3" });
  const text = block.join("\n");
  assert.match(text, /search/);
  assert.match(text, /wor/);
  assert.match(text, /apply/);
});

test("buildTemplate shows a toast hint when provided", () => {
  const block = buildTemplate(ACCOUNTS, 0, { hint: "Saved 'work'.", version: "0.1.3" });
  assert.match(block.join("\n"), /Saved 'work'/);
});

test("buildTemplate empty list renders a no-accounts region", () => {
  const block = buildTemplate([], 0, { version: "0.1.3" });
  assert.match(strip(block.join("\n")), /Accounts/);
  assert.ok(block.length > 3);
});

test("buildTemplate shows the account email inline", () => {
  const withEmail = [{ name: "work", active: true, matched: true, email: "work@example.com" }];
  const text = strip(buildTemplate(withEmail, 0, { version: "0.1.3" }).join("\n"));
  assert.match(text, /work@example\.com/);
  assert.match(text, /active/);
});
