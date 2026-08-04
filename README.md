# xacc

Minimal Codex CLI account switcher for Windows / macOS / Linux.

The core save, list, and switch commands work locally by storing named
`auth.json` snapshots. The TUI can optionally request live usage for the
selected account when you press `u`; see [Usage lookup and privacy](#usage-lookup-and-privacy).

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

A bordered terminal UI to pick and manage accounts, with a persistent status
line and an incremental filter:

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection |
| `Enter` | Switch to the selected account |
| `/` | Search / filter accounts by name |
| `u` | Request live usage for the selected account |
| `a` | Add an account (runs `codex login`, suggests a name from the logged-in email) |
| `r` | Rename the selected account |
| `d` | Delete the selected account (asks for confirmation) |
| `q` / `Esc` / `Ctrl-C` | Quit |

The active account is marked with a colored badge (`active` / `stale` when the
live auth has drifted from the saved snapshot). If you are logged in but have
no saved accounts, the TUI lets you save the current login as your first
profile instead of bailing out.

## Commands

| Command | Description |
| --- | --- |
| `xacc tui` | Interactive management UI (pick / add / rename / delete) |
| `xacc login [<name>] [flags] [--force]` | Run `codex login` (plus flags like `--device-auth`), then save the account. Existing names are replaced only with `--force` |
| `xacc save <name> [--force]` | Legacy alias: save the current `auth.json` without logging in. Existing names are replaced only with `--force` |
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
- **Identity**: profiles are compared using both the ChatGPT user identity and
  workspace/account ID. The same user in two workspaces remains two profiles,
  and two users in one workspace remain separate accounts.
- **Safe auto-backup**: before switching, changed live credentials are written
  back only when they match a saved profile's user and workspace. If the live
  login cannot be identified, xacc refuses to switch and asks you to save it
  under a new name instead of risking an incorrect overwrite.
- **Overwrite protection**: saving to an existing name is rejected unless the
  content is already identical or `--force` was explicitly passed.
- **Atomic writes**: snapshots and `auth.json` are written via temp file +
  rename, never corrupting a half-written file.

## Usage lookup and privacy

Opening the TUI does not request usage. Pressing `u` sends the selected
account's access token and workspace/account ID over HTTPS to
`https://chatgpt.com/backend-api/wham/usage`. xacc uses the response only for
the on-screen usage panel; it does not send analytics or request usage for
other saved accounts.

The lookup is read-only. An expired token produces `usage unavailable`; xacc
does not use refresh tokens or rewrite saved credentials as part of a usage
lookup. This backend endpoint is an implementation dependency and may change
independently of xacc.

## Tests

```bash
npm test
```
