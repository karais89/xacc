import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { removeUsageResult } from "./usage-cache.js";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function authFile() {
  return path.join(codexHome(), "auth.json");
}

function storageRoot() {
  return process.env.CODEX_ACC_HOME || path.join(os.homedir(), ".codex-acc");
}

function accountsDir() {
  return path.join(storageRoot(), "accounts");
}

function stateFile() {
  return path.join(storageRoot(), "current.json");
}

function accountFile(name) {
  return path.join(accountsDir(), `${name}.auth.json`);
}

function validateName(name) {
  if (!name || typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid account name '${name}'. Use letters, numbers, dots, dashes, or underscores, starting with a letter or number.`
    );
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function harden(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod is effectively a no-op on Windows; ignore.
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, data);
  harden(tmp);
  fs.renameSync(tmp, file);
  harden(file);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function listSnapshots() {
  const dir = accountsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".auth.json"))
    .map((f) => f.replace(/\.auth\.json$/, ""))
    .sort();
}

function readState() {
  const state = readJson(stateFile());
  return state && typeof state.name === "string" ? state.name : null;
}

function writeState(name) {
  writeFileAtomic(stateFile(), JSON.stringify({ name }, null, 2) + "\n");
}

// Returns the name of the saved account whose snapshot matches the live
// auth.json, or null when there is no match.
function matchLiveAuth() {
  const auth = authFile();
  if (!fs.existsSync(auth)) return null;
  const live = sha256(auth);
  for (const name of listSnapshots()) {
    if (sha256(accountFile(name)) === live) return name;
  }
  return null;
}

export function getActiveAccount() {
  const matched = matchLiveAuth();
  if (matched) return { name: matched, matched: true, status: "current" };
  const recorded = readState();
  if (recorded) {
    const saved = accountFile(recorded);
    const auth = authFile();
    if (!fs.existsSync(auth)) {
      return { name: recorded, matched: false, status: "auth-missing" };
    }
    const liveKey = identityKey(readJson(auth));
    const savedKey = fs.existsSync(saved) ? identityKey(readJson(saved)) : null;
    if (liveKey && savedKey && liveKey === savedKey) {
      return { name: recorded, matched: false, status: "session-updated" };
    }
    if (liveKey) {
      const candidates = listSnapshots().filter(
        (name) => identityKey(readJson(accountFile(name))) === liveKey
      );
      if (candidates.length === 1) {
        return { name: candidates[0], matched: false, status: "session-updated" };
      }
    }
    return {
      name: recorded,
      matched: false,
      status: "unsaved-login",
    };
  }
  return null;
}

export function saveAccount(name, { overwrite = false } = {}) {
  validateName(name);
  const auth = authFile();
  if (!fs.existsSync(auth)) {
    throw new Error(
      `No auth file found at ${auth}. Run 'codex login' first, then save.`
    );
  }
  const target = accountFile(name);
  const overwritten = fs.existsSync(target);
  if (overwritten && !overwrite) {
    const same = sha256(auth) === sha256(target);
    if (same) {
      writeState(name);
      return { name, overwritten: false, unchanged: true };
    }
    throw new Error(
      `An account named '${name}' already exists. Choose another name or use --force to replace it.`
    );
  }
  writeFileAtomic(target, fs.readFileSync(auth));
  writeState(name);
  return { name, overwritten, unchanged: false };
}

export function listAccounts() {
  const active = getActiveAccount();
  const accounts = listSnapshots().map((name) => ({
    name,
    active: active ? active.name === name : false,
    matched: active && active.name === name ? active.matched : false,
    status: active && active.name === name ? active.status : "saved",
  }));
  return { accounts, active };
}

export function switchAccount(name) {
  validateName(name);
  const target = accountFile(name);
  if (!fs.existsSync(target)) {
    throw new Error(
      `Unknown account '${name}'. Run 'xacc save ${name}' after logging into it.`
    );
  }

  const auth = authFile();
  const live = fs.existsSync(auth) ? fs.readFileSync(auth) : null;

  // Auto-backup only when the live auth can be tied to a saved profile by an
  // exact hash or the same user + workspace identity. A recorded state name
  // alone is not proof: an out-of-band `codex login` may have replaced the
  // live file with another account, and backing that up would destroy the
  // recorded profile's snapshot.
  const matched = matchLiveAuth();
  let backupName = matched;
  if (live && !backupName) {
    const liveKey = identityKey(readJson(auth));
    const recorded = readState();
    const candidates = liveKey
      ? listSnapshots().filter(
          (candidate) => identityKey(readJson(accountFile(candidate))) === liveKey
        )
      : [];
    backupName =
      recorded && candidates.includes(recorded)
        ? recorded
        : candidates.length === 1
          ? candidates[0]
          : null;

    if (!backupName) {
      throw new Error(
        "Live Codex auth does not match a saved account. Save it under a new name before switching."
      );
    }
  }

  if (matchLiveAuth() === name) {
    writeState(name);
    return { name, backedUp: false, unchanged: true };
  }

  let backedUp = false;
  if (live && backupName && fs.existsSync(accountFile(backupName))) {
    if (sha256(auth) !== sha256(accountFile(backupName))) {
      writeFileAtomic(accountFile(backupName), live);
      backedUp = true;
    }
  }

  writeFileAtomic(auth, fs.readFileSync(target));
  writeState(name);
  return { name, backedUp, unchanged: false };
}

export function removeAccount(name) {
  validateName(name);
  const file = accountFile(name);
  if (!fs.existsSync(file)) {
    throw new Error(`Unknown account '${name}'. Nothing to remove.`);
  }
  const key = profileKey(readJson(file));
  fs.unlinkSync(file);
  try {
    removeUsageResult(key);
  } catch {
    // Removing the credential snapshot is the primary action. A stale,
    // non-secret usage cache entry must not prevent account removal.
  }
  const state = readState();
  if (state === name) {
    fs.rmSync(stateFile(), { force: true });
  }
  return { name };
}

export function renameAccount(oldName, newName) {
  validateName(oldName);
  validateName(newName);
  const src = accountFile(oldName);
  if (!fs.existsSync(src)) {
    throw new Error(`Unknown account '${oldName}'. Nothing to rename.`);
  }
  const dst = accountFile(newName);
  if (fs.existsSync(dst)) {
    throw new Error(`An account named '${newName}' already exists.`);
  }
  writeFileAtomic(dst, fs.readFileSync(src));
  fs.unlinkSync(src);
  const state = readState();
  if (state === oldName) {
    writeState(newName);
  }
  return { name: newName };
}

// Extracts the email from a login entity's id_token, or null when unavailable.
function emailFromAuth(data) {
  const idToken = data?.tokens?.id_token;
  if (typeof idToken !== "string" || !idToken.includes(".")) return null;
  try {
    const payload = Buffer.from(idToken.split(".")[1], "base64url").toString("utf-8");
    const claims = JSON.parse(payload);
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

// Derives a sensible default account name from the logged-in id_token's email
// (e.g. "john.doe@example.com" -> "john.doe"), or null when unavailable.
export function suggestAccountName() {
  const auth = authFile();
  if (!fs.existsSync(auth)) return null;
  const local = emailFromAuth(readJson(auth))?.split("@")[0];
  if (!local || !NAME_PATTERN.test(local)) return null;
  if (!fs.existsSync(accountFile(local))) return local;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${local}-${suffix}`;
    if (!fs.existsSync(accountFile(candidate))) return candidate;
  }
  return null;
}

// Returns the email tied to a saved account's snapshot, or null.
export function accountEmail(name) {
  const file = accountFile(name);
  if (!fs.existsSync(file)) return null;
  return emailFromAuth(readJson(file));
}

// Canonical per-user key. This intentionally excludes workspace identity so it
// can also tell whether two different users share a workspace.
function userIdentityKey(data) {
  const claims = claimsFromAuth(data);
  const auth = claims["https://api.openai.com/auth"] || {};
  const userId = auth.chatgpt_user_id || auth.user_id;
  if (userId) return `user:${userId}`;
  if (claims.sub) return `sub:${claims.sub}`;
  const email = emailFromAuth(data);
  if (email) return `email:${email}`;
  return null;
}

function workspaceIdentity(data) {
  const claims = claimsFromAuth(data);
  const auth = claims["https://api.openai.com/auth"] || {};
  return data?.tokens?.account_id || auth.chatgpt_account_id || null;
}

// A Codex profile is the combination of a ChatGPT user and workspace. The
// workspace component prevents the same user in two workspaces from being
// incorrectly flagged as a duplicate, while the user component keeps team
// members in one workspace distinct.
function identityKey(data) {
  const user = userIdentityKey(data);
  if (!user) return null;
  return `${user}|workspace:${workspaceIdentity(data) || "none"}`;
}

function profileKey(data) {
  const identity = identityKey(data);
  return identity
    ? crypto.createHash("sha256").update(identity).digest("hex")
    : null;
}

// Returns another saved profile matching the live auth's user + workspace,
// before the live auth is stored under a new name.
export function duplicateLiveAccount() {
  const auth = authFile();
  if (!fs.existsSync(auth)) return null;
  const key = identityKey(readJson(auth));
  if (!key) return null;
  return (
    listSnapshots().find(
      (name) => identityKey(readJson(accountFile(name))) === key
    ) || null
  );
}

// Returns the name of another saved account that is the same identity as
// `name` (a duplicate login), or null. A login reuses the same identity when
// the browser still holds the previous ChatGPT/SSO session, so the resulting
// account is actually the same user as an existing one.
export function duplicateAccountOf(name) {
  const file = accountFile(name);
  if (!fs.existsSync(file)) return null;
  const key = identityKey(readJson(file));
  if (!key) return null;
  return (
    listSnapshots().find(
      (n) => n !== name && identityKey(readJson(accountFile(n))) === key
    ) || null
  );
}

// Returns the name of another saved account that shares `name`'s team /
// workspace account_id but is a DIFFERENT user (a workspace teammate), or
// null. Unlike duplicateAccountOf, these are genuinely distinct logins, so
// this is informational ("shared workspace"), never a duplicate warning.
export function sharedWorkspaceOf(name) {
  const file = accountFile(name);
  if (!fs.existsSync(file)) return null;
  const data = readJson(file);
  const accountId = workspaceIdentity(data);
  if (!accountId) return null;
  const userKey = userIdentityKey(data);
  return (
    listSnapshots().find((n) => {
      if (n === name) return false;
      const other = readJson(accountFile(n));
      if (workspaceIdentity(other) !== accountId) return false;
      if (userKey && userIdentityKey(other) === userKey) return false;
      return true;
    }) || null
  );
}

// Canonical plan keys and their display labels, mirroring codex-auth.
const PLAN_LABELS = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  prolite: "Pro Lite",
  pro: "Pro",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

// Normalizes the raw plan_type strings sent by OpenAI's backend (e.g.
// "chatgptplus", "self_serve_business_usage_based") into the canonical keys
// above, or null when unrecognized.
export function normalizePlan(s) {
  if (typeof s !== "string") return null;
  const lower = s.toLowerCase().replace(/^chatgpt/, "");
  if (lower === "team" || lower === "self_serve_business_usage_based") return "business";
  if (lower === "enterprise_cbp_usage_based" || lower === "hc") return "enterprise";
  if (lower === "education") return "edu";
  return PLAN_LABELS[lower] ? lower : null;
}

export function planLabel(plan) {
  return PLAN_LABELS[plan] || null;
}

// Decodes the login id_token's claims (email + plan) plus the live auth
// tokens needed for backend usage lookups. The tokens are returned so they
// can be sent over an HTTPS request, never printed.
function claimsFromAuth(data) {
  const idToken = data?.tokens?.id_token;
  if (typeof idToken !== "string" || !idToken.includes(".")) return {};
  try {
    const payload = Buffer.from(idToken.split(".")[1], "base64url").toString("utf-8");
    return JSON.parse(payload) || {};
  } catch {
    return {};
  }
}

// Enriches a saved account with local metadata: email, id_token plan, the
// timestamp of its last activity (snapshot write time), and the auth payload
// (account id + access token) required for live usage lookups.
export function accountMeta(name) {
  const file = accountFile(name);
  if (!fs.existsSync(file)) return null;
  const data = readJson(file);
  const claims = claimsFromAuth(data);
  const authClaim = claims["https://api.openai.com/auth"] || {};
  let lastActivity = null;
  try {
    lastActivity = fs.statSync(file).mtimeMs;
  } catch {
    // snapshot may have been removed concurrently; leave lastActivity null.
  }
  return {
    email: emailFromAuth(data),
    plan: normalizePlan(authClaim.chatgpt_plan_type),
    accountId: data?.tokens?.account_id || null,
    accessToken: data?.tokens?.access_token || null,
    profileKey: profileKey(data),
    lastActivity,
  };
}

// Local metadata for the live Codex auth, used to preview a completed login
// before saving it. Raw tokens are never returned.
export function liveAccountMeta() {
  const file = authFile();
  if (!fs.existsSync(file)) return null;
  const data = readJson(file);
  if (!data) return null;
  const claims = claimsFromAuth(data);
  const authClaim = claims["https://api.openai.com/auth"] || {};
  return {
    email: emailFromAuth(data),
    plan: normalizePlan(authClaim.chatgpt_plan_type),
    accountId: workspaceIdentity(data),
    profileKey: profileKey(data),
  };
}

// Auth payload used only for a selected-account usage request. Callers must
// keep these values internal and must never render or cache them.
export function liveAccountUsageMeta() {
  const file = authFile();
  if (!fs.existsSync(file)) return null;
  const data = readJson(file);
  if (!data) return null;
  return {
    accountId: workspaceIdentity(data),
    accessToken: data?.tokens?.access_token || null,
    profileKey: profileKey(data),
  };
}

export function isLoggedIn() {
  return fs.existsSync(authFile());
}

// Reads the live auth.json as a Buffer, or null when absent. Used to restore
// the previous login if a `codex login` is cancelled or fails.
export function readAuth() {
  const file = authFile();
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file);
}

// Restores a previously captured auth.json (Buffer), or removes it when null.
// Errors are swallowed so the account list always reflects what is on disk.
export function writeAuth(bytes) {
  const file = authFile();
  if (bytes == null) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
    return;
  }
  try {
    writeFileAtomic(file, bytes);
  } catch {
    // ignore
  }
}

export { authFile };
