# Agent Deployment, Update & Development Guide

This repository is the **family-customized fork** of Antigravity Context & Token Viewer (`https://github.com/CaspianW/antigravity-family-context-viewer`).

> **CRITICAL REPOSITORY RULE**:
> Always clone and pull updates from `https://github.com/CaspianW/antigravity-family-context-viewer`.
> **NEVER** trigger the plugin's built-in in-app online updater for upgrades—it points to upstream `elviscjn-cjn/antigravity-context-viewer` and will overwrite family customizations.

---

## 1. Runtime & Environment Rules

- **Zero external dependencies**: Pure Node.js + bundled ASAR engine (`asar-engine.js`). Do **NOT** run `npm install`.
- **Node.js requirement**: Node.js `>= 22.4.0`. Python is optional (only used for deep attachment scanning).
- **Windows fallback if `node` is not in `PATH`**: Check these locations (run with `-v` to confirm `>= 22.4.0`):
  - `%ProgramFiles%\nodejs\node.exe`
  - `%LOCALAPPDATA%\Programs\nodejs\node.exe`
  - `%APPDATA%\Antigravity\bin\agy-node.cmd`
  - Or Antigravity's bundled binary with env `ELECTRON_RUN_AS_NODE=1` (`%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe` or `%ProgramFiles%\Antigravity\Antigravity.exe`).
- **NEVER run `.bat` scripts (`install.bat`, `setup-family.bat`, `uninstall.bat`) from an Agent shell**: they end with `pause` and will block non-interactive shells waiting for keypresses. Always invoke `node deploy.js`, `node cli.js`, or `node setup-family.js` directly.

---

## 2. Standard Automated Workflows (All OS: Windows / macOS / Linux)

Use `deploy.js` as the primary entry point. It automatically verifies Node.js `>= 22.4.0`, enables the meter module (`--enable-meter`), preserves existing local configuration (`family_sync_config.json`, `modules.json`, `pricing_ledger_v1.json`), verifies ASAR checksums, runs `cli.js status`, and calculates whether an Antigravity restart is required.

### A. Fresh Deployment (New Machine)

```sh
git clone https://github.com/CaspianW/antigravity-family-context-viewer.git
cd antigravity-family-context-viewer
node deploy.js --json
```

*(Omit `--json` if human-readable Chinese terminal output is preferred; `--json` outputs a single machine-parseable JSON object.)*

### B. Updating an Existing Installation

Run from the existing repository directory:

```sh
node deploy.js --pull --json
```

What `--pull` does safely:
1. Checks tracked files with `git status --porcelain -uno` (untracked files such as `family-join.json` are **allowed** and left untouched).
2. Runs `git pull --ff-only`.
3. If `deploy.js` itself was updated by the pull, automatically re-execs the updated `deploy.js` without re-pulling.
4. Deploys to `app.asar` while **preserving** the user's `family_sync_config.json`, `modules.json`, and local usage ledger.

If `errorCode` is `GIT_DIRTY`: **STOP** and report the modified tracked files to the user. **NEVER** run `git reset --hard`, `git checkout --`, or discard uncommitted changes without explicit user approval.

### C. First-Time Family Sync Join (Only When Explicitly Requested)

Only run this if the user asks to join a machine to the family dashboard and provides `family-join.json`:

```sh
node setup-family.js --join "<path-to-family-join.json>" --member "<member-name>" --account "<email-or-acct-key>"
```

- Always pass `--member` and `--account` so `setup-family.js` runs non-interactively (`setup-family.js` automatically calls `cli.js install --enable-meter` internally).
- Keep existing `family_sync_config.json` intact during normal version updates (do NOT re-run `setup-family.js` for routine updates).

### D. Preflight Only (No Disk Changes)

```sh
node deploy.js --dry-run --json
```

---

## 3. Handling `ASAR_NOT_FOUND` (Custom Install Paths)

If `deploy.js` fails with `errorCode: "ASAR_NOT_FOUND"`, locate `app.asar` manually and pass `--path "<path-to-app.asar>"`:

- **Windows** (PowerShell / cmd):
  - `%LOCALAPPDATA%\Programs\antigravity\resources\app.asar`
  - `C:\Program Files\antigravity\resources\app.asar`
  - `C:\Program Files\Google Antigravity\resources\app.asar`
  - Search running processes or start menu shortcuts if installed elsewhere.
- **macOS**:
  - `/Applications/Antigravity.app/Contents/Resources/app.asar`
  - `~/Applications/Antigravity.app/Contents/Resources/app.asar`
  - `/Applications/Google Antigravity.app/Contents/Resources/app.asar`
- **Linux**:
  - `~/.local/share/applications/antigravity.desktop` (`Exec=...` parent -> `resources/app.asar`)
  - `~/Antigravity/**/resources/app.asar`
  - `/opt/antigravity/resources/app.asar`, `/usr/lib/antigravity/resources/app.asar`

Retry with:

```sh
node deploy.js --path "<actual-path-to-app.asar>" --json
```

---

## 4. Process & Lock Boundaries (`ASAR_LOCKED`)

- **NEVER kill or force-restart Antigravity** (`Antigravity.exe`, `Antigravity`, electron host processes) from an Agent session running inside Antigravity.
- On **Windows** especially, a running Antigravity instance locks `app.asar` (`EBUSY` / `EPERM` -> `errorCode: "ASAR_LOCKED"`).
- When `ASAR_LOCKED` occurs:
  1. Do **NOT** terminate the process yourself.
  2. Tell the user to completely quit all Antigravity windows (including the system tray icon -> Quit / Exit).
  3. Re-run `node deploy.js --json` (without `--pull` if already pulled) once the user confirms Antigravity is closed.

---

## 5. Verification Contract After Deploy

Before reporting success to the user, verify the `node deploy.js --json` (or `node cli.js status`) output:

1. `ok === true` and `asarPatched === true`.
2. Note both `version` and `commit` (short SHA).
3. Check `restartRequired` and `restartReason`:
   - `true`: Explicitly tell the user that `app.asar` on disk is updated, **and they must completely quit and reopen Antigravity** so main-process/backend updates take effect (`restartReason` e.g. `backend_code_updated`, `stale_main_process_version`, `live_hot_inject_unavailable`).
   - `false`: Report whether hot-reload succeeded immediately or Antigravity was closed (`client_not_running`) and will load on next launch.
   - Never treat CDP live renderer hot-injection (`node cli.js live`) as sufficient when `restartRequired` is `true`: `live` only injects renderer UI and does not reload `meter-main.js`, preload hooks, or backend sync modules inside Electron IPC.
4. Check `familySync.configured` / `familySync.enabled` (only report counts/booleans).

---

## 6. Privacy & Secret Handling Rules

- **NEVER** read into public diffs, commit, push, or echo in logs/reports:
  - `family-join.json`
  - `family_sync_config.json` (in `%LOCALAPPDATA%\AntigravityContextMeter\`, `~/Library/Application Support/AntigravityContextMeter/`, or `~/.local/state/AntigravityContextMeter/`)
  - Private `serverUrl` (`*.pages.dev`), `familySecret`, `memberId`, `deviceId`, OAuth tokens, or personal email addresses.

---

## 7. Source Development & Tests

- Edit renderer sources under `src/renderer/`, then rebuild `meter-renderer.js`:
  ```sh
  npm run build:renderer
  ```
- Only pass `--build` to `deploy.js` when developing renderer changes locally; routine user updates use the pre-built `meter-renderer.js` committed in the repo.
- Run tests after source changes (tests isolate state in system temp dirs and never touch real ledgers/settings):
  ```sh
  npm test
  ```
- On Linux, `meter-context-unlock.test.js` reports `PLATFORM_UNSUPPORTED` (expected); if shell proxy env vars break local loopback tests, unset `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` before running `node --test`.
- Keep all local transcripts, installation manifests, backups, and capture files outside the repository.
