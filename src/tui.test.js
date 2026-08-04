import test from "node:test";
import assert from "node:assert/strict";

import { buildTemplate } from "./tui.js";

test("buildTemplate renders header, accounts, cursor, and state", () => {
  const accounts = [
    { name: "personal", active: true, matched: true },
    { name: "work", active: false, matched: false },
  ];
  const block = buildTemplate(accounts, 1);

  assert.match(block[0], /codexsw/);
  assert.equal(block.length, 5); // header + blank + 2 accounts + blank
  assert.match(block[3], />/); // cursor on work (second account)
  assert.match(block[3], /work/);
  assert.doesNotMatch(block[3], /active/); // work is not active
  assert.match(block[2], /personal/);
  assert.match(block[2], /\(active\)/);
});

test("buildTemplate first line has no cursor when selected is not first", () => {
  const accounts = [
    { name: "personal", active: true, matched: true },
    { name: "work", active: false, matched: false },
  ];
  const block = buildTemplate(accounts, 1);
  assert.doesNotMatch(block[2], />/); // personal not selected
});
