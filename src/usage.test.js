import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseUsage, fetchUsage, fetchAllUsages } from "./usage.js";

const SAMPLE = {
  plan_type: "chatgptplus",
  credits: { has_credits: true, unlimited: false, balance: "1200" },
  rate_limit_reset_credits: { available_count: 0 },
  rate_limit: {
    primary_window: {
      used_percent: 52.5,
      limit_window_seconds: 18000,
      reset_at: "2026-08-04T15:00:00Z",
    },
    secondary_window: {
      used_percent: 17,
      limit_window_seconds: 604800,
      reset_at: "2026-08-10T15:00:00Z",
    },
  },
};

test("parseUsage normalizes plan, windows, and credits", () => {
  const usage = parseUsage(SAMPLE);
  assert.equal(usage.plan, "plus");
  assert.equal(usage.primary.usedPercent, 52.5);
  assert.equal(usage.primary.windowSeconds, 18000);
  assert.equal(usage.secondary.usedPercent, 17);
  assert.equal(usage.credits.balance, "1200");
  assert.ok(usage.primary.resetAt > 0);
});

test("parseUsage clamps out-of-range percentages and tolerates sparse responses", () => {
  const sparse = parseUsage({ plan_type: "free", rate_limit: { primary_window: { used_percent: 130 } } });
  assert.equal(sparse.plan, "free");
  assert.equal(sparse.primary.usedPercent, 100);
  assert.equal(sparse.secondary, null);

  const bare = parseUsage({});
  assert.equal(bare.plan, null);
  assert.equal(bare.primary, null);

  assert.equal(parseUsage(null), null);
  assert.equal(parseUsage("nope"), null);
});

test("fetchUsage rejects when the account has no auth tokens", async () => {
  await assert.rejects(fetchUsage({}), /no ChatGPT auth tokens/);
  await assert.rejects(fetchUsage({ accountId: "a" }), /no ChatGPT auth tokens/);
  await assert.rejects(fetchUsage(null), /no ChatGPT auth tokens/);
});

test("fetchAllUsages reports per-account errors instead of throwing", async () => {
  const result = await fetchAllUsages([
    { name: "alpha", _auth: {} },
    { name: "broken", _auth: { accountId: "a" } },
    { name: "none", _auth: null },
  ]);
  assert.equal(result.alpha.error, "account has no ChatGPT auth tokens");
  assert.equal(result.broken.error, "account has no ChatGPT auth tokens");
  assert.equal(result.none.error, "account has no ChatGPT auth tokens");
});

test("fetchUsage refreshes an expired token via refresh_token and retries", async (t) => {
  const accHome = mkdtempSync(join(tmpdir(), "xacc-usage-"));
  const prev = process.env.CODEX_ACC_HOME;
  process.env.CODEX_ACC_HOME = accHome;
  mkdirSync(join(accHome, "accounts"), { recursive: true });
  writeFileSync(
    join(accHome, "accounts", "t.auth.json"),
    JSON.stringify({ tokens: { access_token: "expired", refresh_token: "rt-1", account_id: "acc" } })
  );
  const origFetch = globalThis.fetch;
  t.after(() => {
    if (prev === undefined) delete process.env.CODEX_ACC_HOME;
    else process.env.CODEX_ACC_HOME = prev;
    rmSync(accHome, { recursive: true, force: true });
    globalThis.fetch = origFetch;
  });

  let whamCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/oauth/token")) {
      return Response.json({ access_token: "fresh-x", refresh_token: "rt-2", id_token: "id-x" });
    }
    whamCalls += 1;
    if (init?.headers?.Authorization === "Bearer expired") {
      return new Response("unauthorized", { status: 401 });
    }
    return Response.json({
      plan_type: "team",
      rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 604800 } },
    });
  };

  const usage = await fetchUsage({ accountId: "acc", accessToken: "expired" }, { refreshName: "t" });
  assert.equal(usage.plan, "business"); // plan_type "team" normalizes to "business"
  assert.equal(whamCalls, 2); // original + retry with the refreshed token

  // The refreshed bundle is persisted back to the snapshot.
  const persisted = JSON.parse(readFileSync(join(accHome, "accounts", "t.auth.json"), "utf-8"));
  assert.equal(persisted.tokens.access_token, "fresh-x");
  assert.equal(persisted.tokens.refresh_token, "rt-2");
});

test("fetchUsage keeps the snapshot untouched when the token is still valid", async (t) => {
  const origFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  globalThis.fetch = async () =>
    Response.json({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 10 } },
    });

  const usage = await fetchUsage({ accountId: "acc", accessToken: "ok-token" });
  assert.equal(usage.plan, "plus");
});
