import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  accountEmail,
  accountMeta,
  authFile,
  duplicateAccountOf,
  getActiveAccount,
  isLoggedIn,
  listAccounts,
  normalizePlan,
  planLabel,
  removeAccount,
  renameAccount,
  saveAccount,
  sharedWorkspaceOf,
  suggestAccountName,
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

test("rename renames snapshot and updates state", (t) => {
  setup(t);
  writeAuth("TOKEN-A");
  saveAccount("personal");

  renameAccount("personal", "private");
  const { accounts } = listAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].name, "private");
  assert.equal(getActiveAccount().name, "private");

  assert.throws(() => renameAccount("private", "private"), /already exists/);
  assert.throws(() => renameAccount("nope", "x"), /Unknown account/);
  assert.throws(() => renameAccount("private", "bad name"), /Invalid account name/);
});

test("suggestAccountName derives name from id_token email", (t) => {
  setup(t);
  writeAuth("TOKEN-A");
  assert.equal(suggestAccountName(), null);

  // A minimal, well-formed id_token payload with an email claim.
  const payload = Buffer.from(
    JSON.stringify({ email: "john.doe@example.com" })
  ).toString("base64url");
  writeAuth(JSON.stringify({ tokens: { id_token: `h.${payload}.s` } }));
  assert.equal(suggestAccountName(), "john.doe");

  // Invalid payload must not throw.
  writeAuth(JSON.stringify({ tokens: { id_token: "not-a-jwt" } }));
  assert.equal(suggestAccountName(), null);
});

test("isLoggedIn reflects auth.json presence", (t) => {
  setup(t);
  assert.equal(isLoggedIn(), false);
  writeAuth("TOKEN-A");
  assert.equal(isLoggedIn(), true);
});

test("accountEmail returns the email embedded in a saved account", (t) => {
  setup(t);
  const payload = Buffer.from(
    JSON.stringify({ email: "work@example.com" })
  ).toString("base64url");
  writeAuth(JSON.stringify({ tokens: { id_token: `h.${payload}.s` } }));
  saveAccount("work");

  assert.equal(accountEmail("work"), "work@example.com");
  assert.equal(accountEmail("missing"), null);

  // Saving a fresh, non-JWT login has no email.
  writeAuth("TOKEN-A");
  saveAccount("personal");
  assert.equal(accountEmail("personal"), null);
});

test("accountMeta exposes email, plan, tokens, and last activity", (t) => {
  setup(t);
  const payload = Buffer.from(
    JSON.stringify({
      email: "plus@example.com",
      "https://api.openai.com/auth": { chatgpt_plan_type: "ChatGPTPlus" },
    })
  ).toString("base64url");
  writeAuth(
    JSON.stringify({
      tokens: { id_token: `h.${payload}.s`, account_id: "acc-123", access_token: "tok-abc" },
    })
  );
  saveAccount("work");

  const meta = accountMeta("work");
  assert.equal(meta.email, "plus@example.com");
  assert.equal(meta.plan, "plus");
  assert.equal(meta.accountId, "acc-123");
  assert.equal(meta.accessToken, "tok-abc");
  assert.ok(meta.lastActivity > 0);
  assert.equal(accountMeta("missing"), null);
});

test("duplicateAccountOf distinguishes users by id_token identity, not account_id", (t) => {
  setup(t);
  // id_token payload helper: ChatGPT auth namespace lives under this key.
  const payload = (claims) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  const auth = (chatgpt_user_id, chatgpt_account_id) =>
    JSON.stringify({
      tokens: {
        id_token: payload({
          sub: `google-oauth2|999`,
          email: "u@example.com",
          "https://api.openai.com/auth": { chatgpt_user_id, chatgpt_account_id },
        }),
      },
    });

  // Same user, same team -> duplicate.
  writeAuth(auth("user-1", "team-X"));
  saveAccount("t1");
  writeAuth(auth("user-1", "team-X"));
  saveAccount("t2");
  assert.equal(duplicateAccountOf("t2"), "t1");

  // Same team account_id but a DIFFERENT user -> NOT a duplicate. This is the
  // team-members case that the old account_id key wrongly flagged.
  writeAuth(auth("user-2", "team-X"));
  saveAccount("other");
  assert.equal(duplicateAccountOf("other"), null);

  // No id_token -> cannot determine identity, so never flagged.
  writeAuth("TOKEN-A");
  saveAccount("sans-id");
  assert.equal(duplicateAccountOf("sans-id"), null);
  assert.equal(duplicateAccountOf("does-not-exist"), null);
});

test("sharedWorkspaceOf reports same workspace account_id but a different user", (t) => {
  setup(t);
  const payload = (claims) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  const auth = (chatgpt_user_id, chatgpt_account_id) =>
    JSON.stringify({
      tokens: {
        account_id: chatgpt_account_id,
        id_token: payload({
          sub: `google-oauth2|999`,
          email: "u@example.com",
          "https://api.openai.com/auth": { chatgpt_user_id, chatgpt_account_id },
        }),
      },
    });

  // Different users, same team account -> shared workspace.
  writeAuth(auth("user-1", "team-X"));
  saveAccount("t1");
  writeAuth(auth("user-2", "team-X"));
  saveAccount("t2");
  assert.equal(sharedWorkspaceOf("t2"), "t1");

  // Same user (across the same workspace) is a duplicate, but still has a
  // workspace teammate (t2) that is a different user.
  writeAuth(auth("user-1", "team-X"));
  saveAccount("dup");
  assert.equal(duplicateAccountOf("dup"), "t1");
  assert.equal(sharedWorkspaceOf("dup"), "t2");

  // A genuinely separate account shares nothing.
  writeAuth(auth("user-3", "team-Y"));
  saveAccount("other");
  assert.equal(sharedWorkspaceOf("other"), null);
  assert.equal(sharedWorkspaceOf("does-not-exist"), null);
});

test("normalizePlan maps backend plan strings to canonical keys", () => {
  assert.equal(normalizePlan("free"), "free");
  assert.equal(normalizePlan("plus"), "plus");
  assert.equal(normalizePlan("pro"), "pro");
  assert.equal(normalizePlan("self_serve_business_usage_based"), "business");
  assert.equal(normalizePlan("enterprise_cbp_usage_based"), "enterprise");
  assert.equal(normalizePlan("education"), "edu");
  assert.equal(normalizePlan("nope"), null);
  assert.equal(normalizePlan(42), null);
  assert.equal(planLabel("plus"), "Plus");
  assert.equal(planLabel("enterprise"), "Enterprise");
  assert.equal(planLabel("nope"), null);
});
