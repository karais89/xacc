import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DAILY_REFRESH_MS,
  FAILED_RETRY_MS,
  readUsageCache,
  recordUsageAttempt,
  removeUsageResult,
  saveUsageResult,
  setUsageRefreshMode,
  shouldAutoRefresh,
  usageCacheEntry,
  usageCacheFile,
} from "./usage-cache.js";

const PROFILE = "a".repeat(64);

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xacc-usage-cache-"));
  const previous = process.env.CODEX_ACC_HOME;
  process.env.CODEX_ACC_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_ACC_HOME;
    else process.env.CODEX_ACC_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test("usage cache stores normalized display data without credentials", (t) => {
  setup(t);
  const now = 1_700_000_000_000;
  saveUsageResult(
    PROFILE,
    {
      plan: "plus",
      primary: { usedPercent: 32, windowSeconds: 18_000, resetAt: now + 10_000 },
      secondary: null,
      credits: { balance: "12", unlimited: false },
      accessToken: "must-not-be-written",
      rawResponse: { secret: true },
    },
    now
  );

  const cache = readUsageCache();
  const entry = usageCacheEntry(cache, PROFILE);
  assert.equal(entry.usage.plan, "plus");
  assert.equal(entry.usage.primary.usedPercent, 32);
  assert.equal(entry.usage.credits.balance, "12");
  assert.equal(entry.fetchedAt, now);

  const raw = fs.readFileSync(usageCacheFile(), "utf-8");
  assert.doesNotMatch(raw, /must-not-be-written|rawResponse|secret/);
});

test("daily refresh waits 24 hours and throttles failed retries", (t) => {
  setup(t);
  const now = 1_700_000_000_000;
  setUsageRefreshMode("daily");
  let cache = readUsageCache();
  assert.equal(shouldAutoRefresh(cache, PROFILE, now), true);

  saveUsageResult(PROFILE, { plan: "plus", primary: null, secondary: null }, now);
  cache = readUsageCache();
  assert.equal(shouldAutoRefresh(cache, PROFILE, now + DAILY_REFRESH_MS - 1), false);
  assert.equal(shouldAutoRefresh(cache, PROFILE, now + DAILY_REFRESH_MS), true);

  recordUsageAttempt(PROFILE, now + DAILY_REFRESH_MS);
  cache = readUsageCache();
  assert.equal(shouldAutoRefresh(cache, PROFILE, now + DAILY_REFRESH_MS + FAILED_RETRY_MS - 1), false);
  assert.equal(shouldAutoRefresh(cache, PROFILE, now + DAILY_REFRESH_MS + FAILED_RETRY_MS), true);
});

test("manual mode never performs an automatic refresh", (t) => {
  setup(t);
  setUsageRefreshMode("manual");
  assert.equal(shouldAutoRefresh(readUsageCache(), PROFILE), false);
});

test("removing a profile also removes its cached usage", (t) => {
  setup(t);
  saveUsageResult(PROFILE, { plan: "plus", primary: null, secondary: null });
  assert.ok(usageCacheEntry(readUsageCache(), PROFILE));
  removeUsageResult(PROFILE);
  assert.equal(usageCacheEntry(readUsageCache(), PROFILE), null);
});
