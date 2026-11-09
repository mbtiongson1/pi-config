---
name: open
description: >-
  Open files, directories, or media in the native system viewer or media player
  with device preflights. On Android/Termux, uses termux-open (MX Player, VLC,
  system chooser). On macOS uses open, on Linux uses xdg-open, on Windows/WSL uses
  wslview or explorer.exe. Automatically resolves latest downloaded files when no path
  is specified.
---

# /open — Native Viewer and Player Dispatcher

Cross-platform command and skill to open media, documents, and downloads using
the device's native viewer, media player, or file manager.

## Usage

```bash
# Open specific file or path
python3 ~/.pi/agent/skills/open/scripts/open.py "/path/to/media.mkv"

# Open most recent download automatically
python3 ~/.pi/agent/skills/open/scripts/open.py

# Prompt with system app chooser (Android/Termux)
python3 ~/.pi/agent/skills/open/scripts/open.py --chooser

# Inspect environment and preflight checks
python3 ~/.pi/agent/skills/open/scripts/open.py --preflight --json
```

## Device Preflights

Before dispatching, the opener checks the active platform and environment:

1. **Android (Termux)**:
   - Verifies `termux-open` from `termux-tools`.
   - Checks storage permission (`/storage/emulated/0/Download` and `~/storage/downloads`).
   - Dispatches intent to Android default handler or app chooser (e.g. MX Player Pro, VLC).
2. **macOS (Darwin)**:
   - Verifies `/usr/bin/open`.
   - Targets standard `~/Downloads`.
3. **Linux Desktop**:
   - Verifies `xdg-open` or `gio open`.
   - Checks `$DISPLAY` or `$WAYLAND_DISPLAY` availability.
4. **Windows (WSL2)**:
   - Verifies `wslview` from `wslu` or falls back to `cmd.exe /c start` / `explorer.exe`.
   - Resolves Windows user Downloads mount under `/mnt/c/Users/<user>/Downloads`.

## Resolution Rules

- If an explicit file path is provided, it is opened directly.
- If a filename substring or relative name is provided, it searches the device's downloads directories.
- If no argument is provided, it automatically finds the most recently completed download or media file.
