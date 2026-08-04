import { normalizePlan, refreshSavedAccountTokens } from "./core.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function windowOf(w) {
  if (!w || typeof w !== "object") return null;
  const usedPercent = Number(w.used_percent);
  return {
    usedPercent: Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, usedPercent)) : null,
    windowSeconds: Number.isFinite(Number(w.limit_window_seconds)) ? Number(w.limit_window_seconds) : null,
    resetAt: w.reset_at ? new Date(w.reset_at).getTime() : null,
  };
}

// Parses the chatgpt.com/backend-api/wham/usage response into a compact,
// normalized snapshot. Unknown fields are ignored.
export function parseUsage(json) {
  if (!json || typeof json !== "object") return null;
  const rateLimit = json.rate_limit || {};
  return {
    plan: normalizePlan(json.plan_type),
    primary: windowOf(rateLimit.primary_window),
    secondary: windowOf(rateLimit.secondary_window),
    credits: json.credits || null,
  };
}

// Fetches the live usage snapshot for a single account. `meta` must be an
// accountMeta() result carrying accountId + accessToken. When the backend
// rejects the token with 401 and `refreshName` is given, the token is
// refreshed via the stored refresh_token and the request is retried once.
// `signal` (optional) lets the caller abort the request early.
export function fetchUsage(meta, { timeoutMs = 8000, refreshName, signal } = {}) {
  const { accountId } = meta || {};
  if (!accountId || !meta?.accessToken) {
    return Promise.reject(new Error("account has no ChatGPT auth tokens"));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  const request = (token, s) =>
    fetch(USAGE_URL, {
      method: "GET",
      signal: s,
      headers: {
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-Id": accountId,
        Accept: "application/json",
        "User-Agent": "xacc",
      },
    });
  return (async () => {
    try {
      let res = await request(meta.accessToken, controller.signal);
      if (res.status === 401 && refreshName) {
        const { refreshed, accessToken } = await refreshSavedAccountTokens(refreshName);
        if (refreshed && accessToken) {
          res = await request(accessToken, controller.signal);
        }
      }
      if (!res.ok) throw new Error(`usage request failed (HTTP ${res.status})`);
      const usage = parseUsage(await res.json());
      if (!usage) throw new Error("unexpected usage response");
      return usage;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  })();
}

// Fetches usage for many accounts concurrently. Always resolves: each account
// maps to either a parsed usage snapshot or `{ error: message }`. Accounts with
// an expired token are auto-refreshed via their refresh_token.
export async function fetchAllUsages(accounts, options = {}) {
  const settled = await Promise.allSettled(
    accounts.map((a) =>
      fetchUsage(a._auth, {
        ...options,
        refreshName: typeof a.name === "string" ? a.name : undefined,
      })
    )
  );
  return Object.fromEntries(
    accounts.map((a, i) => [
      a.name,
      settled[i].status === "fulfilled" ? settled[i].value : { error: settled[i].reason?.message || "usage unavailable" },
    ])
  );
}
