# xacc

Minimal Codex CLI account switcher for Windows / macOS / Linux.

Saves the current `auth.json` as a named snapshot and swaps it back on demand ??nothing else. No network calls, no usage tracking, no OpenAI backend APIs.
Unlike codex-auth, this tool never talks to `chatgpt.com`, so there is no
ToS / account-suspension risk from the tool itself.

## Why

Codex reads a single `~/.codex/auth.json`. Switching accounts normally means
logging out and logging back in. `xacc` keeps one snapshot per account and
swaps the file instantly.

## Install

```bash
npm install -g @karais89/xacc
```

The `xacc` command is then available globally. To build from source
instead:

```bash
npm install -g .      # from this repo directory
```

## Usage

```bash
# 1. Log into an account, then save it (name is suggested from your email)
xacc login personal

# 2. Log into another account
xacc login work

# 3. Switch instantly between them (pick from a list if you omit the name)
xacc switch work
xacc switch

# 4. See saved accounts and which is active
xacc list
xacc list --active
xacc current
```

Restart Codex after switching if it is already running (Codex reads `auth.json`
only at startup).

## Interactive management TUI

```bash
xacc tui
```

A terminal UI to pick and manage accounts:

| Key | Action |
| --- | --- |
| `^` / `v` | Move selection |
| `Enter` | Switch to the selected account |
| `a` | Add an account (runs `codex login`, suggests a name from the logged-in email) |
| `r` | Rename the selected account |
| `d` | Delete the selected account (asks for confirmation) |
| `q` / `Esc` / `Ctrl-C` | Quit |

If you are logged in but have no saved accounts, the TUI lets you save the
current login as your first profile instead of bailing out.

## Commands

| Command | Description |
| --- | --- |
| `xacc tui` | Interactive management UI (pick / add / rename / delete) |
| `xacc login [<name>] [flags]` | Run `codex login` (plus any flags like `--device-auth`), then save the account. Name is suggested from your email, or set it directly |
| `xacc save <name>` | Legacy alias: save the current `auth.json` without logging in |
| `xacc switch [<name>]` | Switch to a saved account; with no name, pick interactively |
| `xacc list [--active]` | List saved accounts; `*` active, `~` recorded but live auth differs |
| `xacc current` | Show the active account |
| `xacc remove <name>` | Delete a saved account |
| `xacc --version` | Show the installed version |
| `xacc help` | Show help |

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