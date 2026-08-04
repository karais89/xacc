# codexsw

Minimal Codex CLI account switcher for Windows / macOS / Linux.

Saves the current `auth.json` as a named snapshot and swaps it back on demand ??nothing else. No network calls, no usage tracking, no OpenAI backend APIs.
Unlike codex-auth, this tool never talks to `chatgpt.com`, so there is no
ToS / account-suspension risk from the tool itself.

## Why

Codex reads a single `~/.codex/auth.json`. Switching accounts normally means
logging out and logging back in. `codexsw` keeps one snapshot per account and
swaps the file instantly.

## Install

```bash
npm install -g .      # from this repo directory
# or after publishing:
npm install -g codexsw
```

## Usage

```bash
# 1. Log into an account with Codex, then save it
codex login
codexsw save personal

# 2. Log into another account, save that too
codex login
codexsw save work

# 3. Switch instantly between them
codexsw switch work
codexsw switch personal

# 4. See saved accounts and which is active
codexsw list
codexsw current
```

Restart Codex after switching if it is already running (Codex reads `auth.json`
only at startup).

## Interactive picker

```bash
codexsw tui
```

Opens a terminal picker: arrow keys to move, `Enter` to switch, `q`/`Esc` to
quit. Useful when you want to confirm which account is which before switching.

## Commands

| Command | Description |
| --- | --- |
| `codexsw tui` | Interactive account picker |
| `codexsw save <name>` | Save the current `auth.json` as a named account |
| `codexsw switch <name>` | Switch to a saved account (auto-backs up current) |
| `codexsw list` | List saved accounts; `*` active, `~` recorded but live auth differs |
| `codexsw current` | Show the active account |
| `codexsw remove <name>` | Delete a saved account |
| `codexsw help` | Show help |

## How it works

- **Auth file**: `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`).
- **Snapshots**: `~/.codex-acc/accounts/<name>.auth.json` (override with
  `CODEX_ACC_HOME`).
- **State**: `~/.codex-acc/current.json` records the last used account.
- **Auto-backup**: before switching, the live `auth.json` is written back to
  whichever saved account it belongs to (matched by hash, or by recorded
  state). This preserves access tokens that Codex refreshed while it was live,
  so saved accounts stay valid.
- **Atomic writes**: snapshots and `auth.json` are written via temp file +
  rename, never corrupting a half-written file.

## Tests

```bash
npm test
```