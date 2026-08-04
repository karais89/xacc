import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

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
  if (matched) return { name: matched, matched: true };
  const recorded = readState();
  if (recorded) return { name: recorded, matched: false };
  return null;
}

export function saveAccount(name) {
  validateName(name);
  const auth = authFile();
  if (!fs.existsSync(auth)) {
    throw new Error(
      `No auth file found at ${auth}. Run 'codex login' first, then save.`
    );
  }
  const target = accountFile(name);
  const overwritten = fs.existsSync(target);
  writeFileAtomic(target, fs.readFileSync(auth));
  writeState(name);
  return { name, overwritten };
}

export function listAccounts() {
  const active = getActiveAccount();
  const accounts = listSnapshots().map((name) => ({
    name,
    active: active ? active.name === name : false,
    matched: active ? active.matched : false,
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

  // Auto-backup: write the live auth back into whichever saved account it
  // belongs to, so freshly refreshed tokens are preserved before switching.
  const matched = matchLiveAuth();
  const backupName = matched || readState();
  if (live && backupName && fs.existsSync(accountFile(backupName))) {
    if (sha256(auth) !== sha256(accountFile(backupName))) {
      writeFileAtomic(accountFile(backupName), live);
    }
  }

  writeFileAtomic(auth, fs.readFileSync(target));
  writeState(name);
  return { name, backedUp: !!backupName };
}

export function removeAccount(name) {
  validateName(name);
  const file = accountFile(name);
  if (!fs.existsSync(file)) {
    throw new Error(`Unknown account '${name}'. Nothing to remove.`);
  }
  fs.unlinkSync(file);
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
  return local && NAME_PATTERN.test(local) ? local : null;
}

// Returns the email tied to a saved account's snapshot, or null.
export function accountEmail(name) {
  const file = accountFile(name);
  if (!fs.existsSync(file)) return null;
  return emailFromAuth(readJson(file));
}

// Canonical per-user identity key for a saved account's snapshot. Prefers the
// individual ChatGPT user id from the id_token, then the SSO subject, then the
// email. It deliberately does NOT use tokens.account_id: that value is the team
// / workspace account id, shared by every member of a team, so two genuinely
// different users in the same team account would otherwise look like one.
function identityKey(data) {
  const claims = claimsFromAuth(data);
  const auth = claims["https://api.openai.com/auth"] || {};
  const userId = auth.chatgpt_user_id || auth.user_id;
  if (userId) return `user:${userId}`;
  if (claims.sub) return `sub:${claims.sub}`;
  const email = emailFromAuth(data);
  if (email) return `email:${email}`;
  return null;
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
    lastActivity,
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

// ── OAuth token refresh ────────────────────────────────────────────────────
// The public client id Codex CLI uses for ChatGPT OAuth. Refresh tokens are
// short-lived (minutes/hours) and require refreshing before they can drive the
// chatgpt.com usage endpoint.
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// Refreshes a saved account's access token using its stored refresh_token and
// persists the refreshed bundle back to the snapshot, keeping the live auth
// file in sync when this is the active account so it does not turn stale.
// Resolves with { refreshed, accessToken }.
export async function refreshSavedAccountTokens(name) {
  validateName(name);
  const file = accountFile(name);
  if (!fs.existsSync(file)) return { refreshed: false };
  const data = readJson(file);
  const refresh = data?.tokens?.refresh_token;
  if (typeof refresh !== "string" || !refresh) return { refreshed: false };
  const wasActiveMatch = matchLiveAuth() === name;

  let response;
  try {
    response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refresh,
      }),
    });
  } catch {
    return { refreshed: false };
  }
  if (!response.ok) return { refreshed: false };
  let json;
  try {
    json = await response.json();
  } catch {
    return { refreshed: false };
  }
  if (typeof json?.access_token !== "string") return { refreshed: false };

  if (typeof json.refresh_token === "string") data.tokens.refresh_token = json.refresh_token;
  data.tokens.access_token = json.access_token;
  if (typeof json.id_token === "string") data.tokens.id_token = json.id_token;
  data.last_refresh = new Date().toISOString();

  const bytes = Buffer.from(JSON.stringify(data, null, 2) + "\n");
  writeFileAtomic(file, bytes);
  if (wasActiveMatch) writeFileAtomic(authFile(), bytes);
  return { refreshed: true, accessToken: json.access_token };
}
