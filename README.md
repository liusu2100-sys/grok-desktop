# Grok Build Desktop

Codex-style desktop client for [Grok Build](https://github.com/kuishou/grok-build).

The window is an Electron + React command center. The agent is the official `grok` CLI, spoken to over [ACP](https://agentclientprotocol.com) (`grok agent stdio`). Same models, tools, sessions, and `~/.grok` credentials as the TUI.

```
apps/desktop/
  src/main/       Electron host: spawn grok, ACP JSON-RPC, git, persistence
  src/preload/    contextBridge API
  src/renderer/   project / thread / chat / diff UI
  src/shared/     shared TypeScript types
```

## What you get

- Project sidebar — open any folder as a workspace
- Threads per project, including sessions already stored under `~/.grok/sessions`
- Streaming chat: agent text, reasoning, tool cards, plans
- Permission cards when the agent needs approval
- Right-hand changes panel: git status + diffs
- Delete threads (sidebar × or thread bar), including `~/.grok/sessions`
- Model picker in the thread bar and composer (`grok models` / ACP)
- Sign in with grok.com, or connect with an API key / custom OpenAI-compatible endpoint

## Prerequisites

1. **Node.js 20+**
2. **Grok CLI** on this machine (`grok` on `PATH`, `%USERPROFILE%\.grok\bin\grok.exe` on Windows, or `~/.grok/bin/grok` on macOS)
3. Signed in: `grok login`

Install the CLI if needed:

```powershell
irm https://x.ai/cli/install.ps1 | iex
```

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

## Develop

```powershell
cd apps/desktop
npm install
# If Electron's binary did not download (npm script policy):
#   npm approve-scripts electron esbuild electron-winstaller
#   node node_modules/electron/install.js
npm run dev
```

Optional: `GROK_DESKTOP_AGENT_PATH` points at a custom `grok` / `xai-grok-pager` binary.

## Package

Windows, from `apps/desktop`:

```powershell
npm run dist
```

Artifacts in `apps/desktop/release/`:

- `Grok Build-Portable-0.1.0.exe`
- `Grok Build-Setup-0.1.0.exe`
- `win-unpacked/Grok Build.exe`

macOS (Apple silicon and Intel) must be packaged on a Mac. electron-builder refuses a macOS target on Windows.

```bash
cd apps/desktop
npm install
npm run dist:mac
```

Artifacts:

- `Grok Build-0.1.0-mac-arm64.dmg` and `.zip`
- `Grok Build-0.1.0-mac-x64.dmg` and `.zip`

The build is unsigned (`identity: null`). The first launch needs Right Click → Open, or `xattr -dr com.apple.quarantine` on the app. Closing the window leaves the process running; use the app menu to quit.

The packaged app does **not** bundle the agent. It launches the Grok CLI already installed on the machine (or the path set in Settings).

## First run

1. Open a project folder
2. Click **New thread** (or type and press Enter)
3. Ask Grok to inspect, edit, or run commands in that folder

Auth and config stay in `~/.grok`, so the desktop app and the TUI share login, MCP servers, and session history.
