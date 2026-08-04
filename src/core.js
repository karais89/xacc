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

// Derives a sensible default account name from the logged-in id_token's email
// (e.g. "john.doe@example.com" -> "john.doe"), or null when unavailable.
export function suggestAccountName() {
  const auth = authFile();
  if (!fs.existsSync(auth)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(auth, "utf-8"));
    const idToken = data?.tokens?.id_token;
    if (typeof idToken !== "string" || !idToken.includes(".")) return null;
    const payload = Buffer.from(idToken.split(".")[1], "base64url").toString("utf-8");
    const claims = JSON.parse(payload);
    const email = typeof claims.email === "string" ? claims.email : null;
    if (!email) return null;
    const local = email.split("@")[0];
    return NAME_PATTERN.test(local) ? local : null;
  } catch {
    return null;
  }
}

export function isLoggedIn() {
  return fs.existsSync(authFile());
}

export { authFile };
