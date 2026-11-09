---
name: download
description: >-
  Precise media and file downloader with cross-device preflights. Supports Kura
  on Android/Termux for episodic anime and BitTorrent, direct URL/torrent downloads via
  aria2c/curl, wake locks, cryptographic piece verification, and automated storage
  organization into Downloads.
---

# /download — Precise Media and File Downloader

Cross-platform downloader optimized for precise episodic media, torrents, and files
with environment preflights and automated destination organization.

## Usage

```bash
# Precise anime/episodic download via Kura (1080p by default)
python3 ~/.pi/agent/skills/download/scripts/download.py "Just Because!" --episode 1-3

# Dry-run inspection
python3 ~/.pi/agent/skills/download/scripts/download.py "Just Because!" --episode 1 --dry-run --json

# Direct URL or torrent download
python3 ~/.pi/agent/skills/download/scripts/download.py "https://example.com/file.zip"

# Preflight checks (disk space, downloaders, wake locks)
python3 ~/.pi/agent/skills/download/scripts/download.py --preflight --json
```

## Device Preflights

The downloader inspects the host device before starting transfers:

1. **Storage & Capacity**:
   - Android/Termux: Checks write access to shared storage `/storage/emulated/0/Download` and Termux local `~/Downloads`.
   - Linux/macOS/WSL: Checks `~/Downloads` or `$XDG_DOWNLOAD_DIR`.
   - Free disk space check: Verifies at least 1 GB free space before starting.
2. **Power Management**:
   - Android: Acquires `termux-wake-lock` during transfers and releases via `termux-wake-unlock` on exit.
   - macOS: Leverages `caffeinate`.
   - Linux: Uses `systemd-inhibit` when available.
3. **Engines**:
   - `kura`: Dedicated CLI engine for anime and BitTorrent on Termux/Linux with piece-by-piece cryptographic verification and release group filtering.
   - `aria2c` / `curl`: Fallback engines for direct links, torrents, and magnets.
4. **Post-Download Organization**:
   - Android: Copies verified media directly to `/storage/emulated/0/Download/`, symlinks into `~/Downloads/`, and triggers `termux-media-scan` for instant gallery/player discovery.

## Precise Release Matching Rules

- **Airing Date vs Release Group**: Releases requested under modern groups (like `SubsPlease`, founded late 2020) for older shows (e.g. 2017) are mapped to the legitimate historical release group (such as `HorribleSubs`).
- **Resolution**: Respects requested resolution (1080p, 720p, etc.).
- **Sequential Transfers**: For multi-episode batches, acquires episodes sequentially with automatic resume on transient network stalls.
