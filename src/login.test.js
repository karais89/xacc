import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexLogin } from "./login.js";

// Points CODEX_HOME at a throwaway dir so tests never touch a real
// ~/.codex/auth.json, and restores the previous value on teardown.
function withCodexHome(t) {
  const home = join(tmpdir(), `xacc-codex-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function authPath(home) {
  return join(home, "auth.json");
}

test("successful codex login resolves ok", async () => {
  const result = await runCodexLogin(process.execPath, ["-e", "process.exit(0)"], { shell: false });
  assert.equal(result.ok, true);
});

test("failing codex login resolves not ok", async () => {
  const result = await runCodexLogin(process.execPath, ["-e", "process.exit(3)"], { shell: false });
  assert.equal(result.ok, false);
});

test("missing codex binary resolves not ok", async () => {
  const result = await runCodexLogin("definitely-not-a-real-binary-xacc-xyz");
  assert.equal(result.ok, false);
});

test("forwards extra args to the login command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacc-login-"));
  try {
    const fixture = join(dir, "fixture.js");
    await writeFile(
      fixture,
      "process.exit(process.argv.includes('--device-auth') ? 0 : 1);"
    );
    const withFlag = await runCodexLogin(process.execPath, [fixture, "--device-auth"], { shell: false });
    const withoutFlag = await runCodexLogin(process.execPath, [fixture], { shell: false });
    assert.equal(withFlag.ok, true);
    assert.equal(withoutFlag.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A fake 'codex login' that rewrites auth.json (as the real codex does as soon
// as the flow starts) with valid JSON, then exits with the given code.
const NEW_JSON = '{"tokens":{"access_token":"x"}}';
function clobberFixture(dir, exitCode) {
  const fixture = join(dir, "clobber.js");
  writeFileSync(
    fixture,
    `const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), ${JSON.stringify(NEW_JSON)});
process.exit(${exitCode});`
  );
  return fixture;
}

test("cancelled login restores the previous auth so the account stays active", async (t) => {
  const home = withCodexHome(t);
  writeFileSync(authPath(home), "OLD-CONTENT");
  const fixture = clobberFixture(home, 1);

  const result = await runCodexLogin(process.execPath, [fixture], { shell: false });
  assert.equal(result.ok, false);
  assert.equal(readFileSync(authPath(home), "utf-8"), "OLD-CONTENT");
});

test("login that exits 0 but leaves an empty auth is treated as cancelled", async (t) => {
  const home = withCodexHome(t);
  writeFileSync(authPath(home), "OLD-CONTENT");
  const fixture = join(home, "empty.js");
  writeFileSync(
    fixture,
    `const fs = require("node:fs");
fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), "{}");
process.exit(0);`
  );

  const result = await runCodexLogin(process.execPath, [fixture], { shell: false });
  assert.equal(result.ok, false);
  assert.equal(readFileSync(authPath(home), "utf-8"), "OLD-CONTENT");
});

test("successful login keeps the new auth", async (t) => {
  const home = withCodexHome(t);
  writeFileSync(authPath(home), "OLD-CONTENT");
  const fixture = clobberFixture(home, 0);

  const result = await runCodexLogin(process.execPath, [fixture], { shell: false });
  assert.equal(result.ok, true);
  assert.equal(readFileSync(authPath(home), "utf-8"), NEW_JSON);
});

test("failed login with no prior auth removes a leftover partial file", async (t) => {
  const home = withCodexHome(t);
  const fixture = clobberFixture(home, 1);

  const result = await runCodexLogin(process.execPath, [fixture], { shell: false });
  assert.equal(result.ok, false);
  assert.equal(existsSync(authPath(home)), false);
});
