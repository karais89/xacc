import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  authFile,
  getActiveAccount,
  listAccounts,
  removeAccount,
  saveAccount,
  switchAccount,
} from "./core.js";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acc-test-"));
  const codexHome = path.join(root, "codex");
  const accHome = path.join(root, "codex-acc");
  fs.mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_ACC_HOME = accHome;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { codexHome, accHome };
}

function writeAuth(content) {
  fs.writeFileSync(authFile(), content);
}

test("save/list/current round trip", (t) => {
  setup(t);
  writeAuth("TOKEN-A");

  saveAccount("personal");
  assert.equal(getActiveAccount().name, "personal");
  assert.equal(getActiveAccount().matched, true);

  const { accounts } = listAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].name, "personal");
  assert.equal(accounts[0].active, true);
  assert.equal(accounts[0].matched, true);
});

test("switch swaps auth and records current", (t) => {
  setup(t);
  writeAuth("TOKEN-A");
  saveAccount("personal");

  writeAuth("TOKEN-B");
  saveAccount("work");

  switchAccount("personal");
  assert.equal(fs.readFileSync(authFile(), "utf-8"), "TOKEN-A");
  assert.equal(getActiveAccount().name, "personal");
  assert.equal(getActiveAccount().matched, true);
});

test("switch auto-backs up refreshed live auth into the matching account", (t) => {
  setup(t);

  // Log into account A and save it.
  writeAuth("TOKEN-A");
  saveAccount("personal");

  // Log into account B and save it, then return to A.
  writeAuth("TOKEN-B");
  saveAccount("work");
  switchAccount("personal");

  // Account A's access token is refreshed by Codex while live; the live file
  // no longer matches the personal snapshot, but the recorded state still
  // points at personal.
  writeAuth("TOKEN-A-REFRESHED");

  // Switching away must write the refreshed token back into 'personal'.
  switchAccount("work");
  const personalPath = path.join(process.env.CODEX_ACC_HOME, "accounts", "personal.auth.json");
  assert.equal(fs.readFileSync(personalPath, "utf-8"), "TOKEN-A-REFRESHED");
  assert.equal(fs.readFileSync(authFile(), "utf-8"), "TOKEN-B");
});

test("switch to unknown account fails", (t) => {
  setup(t);
  writeAuth("TOKEN-A");
  assert.throws(() => switchAccount("nope"), /Unknown account/);
});

test("invalid account names rejected", (t) => {
  setup(t);
  writeAuth("TOKEN-A");
  for (const bad of ["../evil", "a b", "-dash", "x/y", ""]) {
    assert.throws(() => saveAccount(bad), /Invalid account name/);
  }
});

test("remove deletes snapshot and state", (t) => {
  setup(t);
  writeAuth("TOKEN-A");
  saveAccount("personal");
  removeAccount("personal");
  assert.equal(listAccounts().accounts.length, 0);
  assert.equal(getActiveAccount(), null);
});

test("save without auth file fails", (t) => {
  setup(t);
  assert.throws(() => saveAccount("personal"), /codex login/);
});
