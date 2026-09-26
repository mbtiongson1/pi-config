# Codex Computer Use for Pi

This guide describes how to optionally enable OpenAI Codex native macOS Computer Use inside Pi using `pi-codex-computer-use`.

## Overview

Codex Computer Use enables Pi agents to inspect and operate native macOS desktop applications. Pi agents can read accessibility trees, take screenshots, click UI elements, type text, scroll, and send keyboard shortcuts.

### Architecture

```text
Pi (Agent Harness)
└── OpenAI / Codex agent
    └── pi-codex-computer-use (Pi extension)
        └── Codex app-server (stdio JSONL protocol)
            └── computer-use MCP server (SkyComputerUseClient)
                └── Codex Computer Use service (SkyComputerUseService)
                    └── macOS GUI / Desktop
```

Pi remains the agent harness; Codex supplies the Computer Use execution layer and safety rails.

## Why It Is Optional

Computer Use is intentionally an **opt-in component**:
1. **Platform-specific**: Codex Computer Use is native to macOS and requires macOS Accessibility and Screen Recording permissions. Non-macOS systems (Linux, Windows, Termux) cannot run it.
2. **Heavyweight desktop bridge**: Regular Pi usage for coding, file editing, and command execution does not require desktop GUI control.
3. **Safety & permissions**: GUI automation interacts with live user windows. It requires deliberate user authorization and macOS security grants.

The default Pi installation remains 100% functional without Codex Computer Use.

## Supported Platforms & Prerequisites

- **Operating System**: macOS 12+ (Apple Silicon or Intel).
- **Pi**: Pi Coding Agent CLI (`pi`) installed and configured.
- **Codex CLI**: `codex` command available on `PATH` (`npm install -g @openai/codex`).
- **Codex.app / ChatGPT.app**: Installed at `/Applications/Codex.app` or `/Applications/ChatGPT.app` (bundle ID `com.openai.codex`). If ChatGPT.app is installed, `pi-config` automatically sets up the `/Applications/Codex.app` symlink.
- **macOS Permissions**:
  - **Accessibility**: Required to inspect accessibility trees and synthesize clicks/keystrokes.
  - **Screen Recording**: Required to capture app window screenshots (`get_app_state`).
  - **Automation (AppleEvents)**: Required for the terminal/parent process to communicate with `SkyComputerUseService`.

## Installation via `pi-config`

### 1. Interactive Prompt
When running `/pi-config` Update or Reinstall, `optional-packages.json` will prompt:

```text
Optional Integrations

[ ] Codex Computer Use
    Give Pi agents access to Codex's native macOS
    computer-use capabilities.

    Requires:
    • macOS
    • Codex CLI
    • Codex.app
    • Accessibility permission
    • Screen Recording permission
```

### 2. Direct CLI Installer
You can also run the installer directly from this repository:

```bash
bash bin/install-codex-computer-use.sh
```

The installer:
- Verifies macOS environment.
- Detects existing Pi and Codex CLI installations.
- Locates or links Codex.app / ChatGPT.app.
- Registers `npm:pi-codex-computer-use` in `~/.pi/agent/settings.json`.
- Safely configures `[mcp_servers.computer-use]` in `~/.codex/config.toml` without overwriting other settings.
- Runs the built-in doctor check.

## macOS Permissions Setup

If permissions have not yet been granted, macOS will block GUI automation. Configure them in macOS:

1. **Accessibility**:
   - Open **System Settings > Privacy & Security > Accessibility**.
   - Ensure your terminal (e.g. `Terminal`, `iTerm2`), `Codex`, and `ChatGPT` are toggled **ON**.
2. **Screen Recording**:
   - Open **System Settings > Privacy & Security > Screen Recording**.
   - Ensure your terminal and `Codex` / `ChatGPT` are toggled **ON**.
3. **Automation**:
   - Open **System Settings > Privacy & Security > Automation**.
   - Under your terminal, verify access to `Codex Computer Use` (or `com.openai.sky.CUAService`) is allowed.

## Verification & Doctor

Check the health of the entire stack at any time:

```bash
bash bin/install-codex-computer-use.sh --doctor
```

Expected output when fully ready:

```text
Codex Computer Use

Pi                         ✓ (0.87.1)
Codex CLI                  ✓ (codex-cli 0.157.1)
Codex.app                  ✓ (Codex.app -> ChatGPT.app)
Pi Codex CU extension      ✓ (npm:pi-codex-computer-use)
Codex app-server           ✓
Computer Use service       ✓ (10 tools active)
Accessibility permission   ✓
Screen Recording           ✓

Status: READY
```

### Status Classifications

- `READY`: All prerequisites, configurations, services, and permissions are verified.
- `INSTALLED — HUMAN PERMISSION REQUIRED`: Stack is installed and configured, but macOS Accessibility or Screen Recording permission requires human approval in System Settings.
- `NOT CONFIGURED`: Software exists, but the extension or Codex MCP server is not yet enabled.
- `NOT INSTALLED`: Pi, Codex CLI, or Codex.app is missing.
- `UNAVAILABLE ON THIS OS`: The current OS is not macOS.
- `INCOMPATIBLE`: Component version mismatch or communication failure.

JSON machine-readable output is available via:

```bash
bash bin/install-codex-computer-use.sh --doctor --json
```

## End-to-End Smoke Test

Run a live test that queries running desktop apps through the full Pi → Codex CU → macOS chain:

```bash
bash bin/install-codex-computer-use.sh --smoke-test
```

Inside Pi interactive sessions, you can also run:

```text
/computer-use status
```

Or ask the agent:

```text
Use computer_use_list_apps to list running apps.
```

## Disabling or Uninstalling

To disable Computer Use without affecting any other Pi packages or configuration:

```bash
bash bin/install-codex-computer-use.sh --disable
```

This removes `npm:pi-codex-computer-use` from `~/.pi/agent/settings.json` and uninstalls the npm extension. Normal Pi operations remain completely unaffected.

## Troubleshooting

| Issue | Cause | Resolution |
|---|---|---|
| `Status: UNAVAILABLE ON THIS OS` | Non-macOS machine | Computer Use is macOS-only. Run Pi normally without this integration. |
| `Status: NOT INSTALLED` (Codex.app missing) | Desktop app not found | Install ChatGPT / Codex Desktop: `brew install --cask chatgpt`. |
| `Status: NOT CONFIGURED` | Extension or MCP block omitted | Run `bash bin/install-codex-computer-use.sh`. |
| `bootstrapTimedOut` or `Sender process is not authenticated` | macOS Automation / AppleEvents blocked | In System Settings > Privacy & Security > Automation, enable Terminal access to Codex Computer Use. Reset stale entries with `tccutil reset AppleEvents com.apple.Terminal`. |
| `INSTALLED — HUMAN PERMISSION REQUIRED` | Accessibility or Screen Recording disabled | Grant permissions in System Settings > Privacy & Security. |
| Elicitation prompt rejected in headless/print mode | No UI available to confirm | Interactive Pi prompts via UI; for test/dev scripts set `PI_CUA_DEV_AUTO_ACCEPT_APPS="Calculator,Finder"`. |

## Upstream Integration Reference

- Primary integration: [`pi-codex-computer-use`](https://github.com/danecando/pi-codex-computer-use) by Dane Grant.
- npm package: [`pi-codex-computer-use`](https://www.npmjs.com/package/pi-codex-computer-use).
