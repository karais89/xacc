import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexLogin } from "./login.js";

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