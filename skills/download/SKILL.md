---
name: download
description: >-
  Precise media and file downloader with cross-device preflights and torrent queuing system.
  Supports Kura on Android/Termux for episodic anime and BitTorrent, direct URL/torrent
  downloads via aria2c/curl, persistent download queue (/queue <title> [ep] [res], /queue start),
  wake locks, cryptographic piece verification, and automated storage organization into Downloads.
---

# /download & /queue — Precise Media Downloader & Torrent Queue

Cross-platform downloader and queuing system optimized for precise episodic media, torrents,
and files with environment preflights, background queuing, and automated destination organization.

## Torrent Queuing System (/queue)

Queue torrents on metered or mobile data without downloading immediately. When connected to Wi-Fi,
trigger sequential batch downloads:

```bash
# Natural syntax (add title, episode, resolution)
/queue Dark item 06 1080p
/queue "Just Because!" 01-03 1080p
/queue Bleach 15 720p

# Direct torrent/magnet URL queueing
/queue "https://example.com/file.torrent"

# Inspect queued items
/queue list
/queue status

# Start downloads when on Wi-Fi
/queue start

# Clear finished/failed items or remove by ID
/queue clear
/queue remove 1
```

Via CLI directly:

```bash
python3 ~/.pi/agent/skills/download/scripts/queue.py "Dark item 06 1080p"
python3 ~/.pi/agent/skills/download/scripts/queue.py list
python3 ~/.pi/agent/skills/download/scripts/queue.py start
```

## Immediate Download Usage (/download)

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
