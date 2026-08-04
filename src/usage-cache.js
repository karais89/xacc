import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000;
export const FAILED_RETRY_MS = 60 * 60 * 1000;

function storageRoot() {
  return process.env.CODEX_ACC_HOME || path.join(os.homedir(), ".codex-acc");
}

export function usageCacheFile() {
  return path.join(storageRoot(), "usage-cache.json");
}

function emptyCache() {
  return { version: 1, refreshMode: null, entries: {} };
}

function harden(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms where chmod does not map to native ACLs.
  }
}

function writeCache(cache) {
  const file = usageCacheFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
  harden(tmp);
  fs.renameSync(tmp, file);
  harden(file);
  return cache;
}

export function readUsageCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(usageCacheFile(), "utf-8"));
    if (!parsed || parsed.version !== 1 || typeof parsed.entries !== "object") {
      return emptyCache();
    }
    const entries = {};
    for (const [key, value] of Object.entries(parsed.entries || {})) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue;
      const normalized = normalizedEntry(value);
      if (normalized) entries[key] = normalized;
    }
    return {
      version: 1,
      refreshMode:
        parsed.refreshMode === "daily" || parsed.refreshMode === "manual"
          ? parsed.refreshMode
          : null,
      entries,
    };
  } catch {
    return emptyCache();
  }
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cachedWindow(window) {
  if (!window || typeof window !== "object") return null;
  return {
    usedPercent: finiteOrNull(window.usedPercent),
    windowSeconds: finiteOrNull(window.windowSeconds),
    resetAt: finiteOrNull(window.resetAt),
  };
}

// Persist only normalized values rendered by xacc, never tokens, account IDs,
// or the backend's raw response.
function cachedUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const credits = usage.credits && typeof usage.credits === "object"
    ? {
        hasCredits:
          typeof usage.credits.has_credits === "boolean"
            ? usage.credits.has_credits
            : typeof usage.credits.hasCredits === "boolean"
              ? usage.credits.hasCredits
              : null,
        unlimited:
          typeof usage.credits.unlimited === "boolean" ? usage.credits.unlimited : null,
        balance:
          typeof usage.credits.balance === "string" || Number.isFinite(usage.credits.balance)
            ? usage.credits.balance
            : null,
        usedPercent: finiteOrNull(usage.credits.usedPercent),
      }
    : null;
  return {
    plan: typeof usage.plan === "string" ? usage.plan : null,
    primary: cachedWindow(usage.primary),
    secondary: cachedWindow(usage.secondary),
    credits,
  };
}

export function usageCacheEntry(cache, profileKey) {
  if (!profileKey || !cache?.entries || typeof cache.entries !== "object") return null;
  return normalizedEntry(cache.entries[profileKey]);
}

function normalizedEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    usage: cachedUsage(entry.usage),
    fetchedAt: finiteOrNull(entry.fetchedAt),
    lastAttemptAt: finiteOrNull(entry.lastAttemptAt),
  };
}

export function saveUsageResult(profileKey, usage, now = Date.now()) {
  if (!profileKey) return readUsageCache();
  const normalized = cachedUsage(usage);
  if (!normalized) return readUsageCache();
  const cache = readUsageCache();
  cache.entries[profileKey] = {
    usage: normalized,
    fetchedAt: now,
    lastAttemptAt: now,
  };
  return writeCache(cache);
}

export function recordUsageAttempt(profileKey, now = Date.now()) {
  if (!profileKey) return readUsageCache();
  const cache = readUsageCache();
  const previous = usageCacheEntry(cache, profileKey);
  cache.entries[profileKey] = {
    usage: previous?.usage || null,
    fetchedAt: previous?.fetchedAt || null,
    lastAttemptAt: now,
  };
  return writeCache(cache);
}

export function removeUsageResult(profileKey) {
  if (!profileKey) return readUsageCache();
  const cache = readUsageCache();
  if (!(profileKey in cache.entries)) return cache;
  delete cache.entries[profileKey];
  return writeCache(cache);
}

export function setUsageRefreshMode(mode) {
  if (mode !== "manual" && mode !== "daily") {
    throw new Error("Usage refresh mode must be 'manual' or 'daily'.");
  }
  const cache = readUsageCache();
  cache.refreshMode = mode;
  return writeCache(cache);
}

export function shouldAutoRefresh(cache, profileKey, now = Date.now()) {
  if (cache?.refreshMode !== "daily" || !profileKey) return false;
  const entry = usageCacheEntry(cache, profileKey);
  if (entry?.fetchedAt && now - entry.fetchedAt < DAILY_REFRESH_MS) return false;
  if (entry?.lastAttemptAt && now - entry.lastAttemptAt < FAILED_RETRY_MS) return false;
  return true;
}

export function isUsageCacheStale(entry, now = Date.now()) {
  return !entry?.fetchedAt || now - entry.fetchedAt >= DAILY_REFRESH_MS;
}
