---
name: asset-backup
description: Backs up Gaia Research asset files to the configured rclone remote. Use when the user asks to back up assets, generated masters, production exports, asset ledger metadata, or local master backups. Verifies rclone, writes a timestamped backup to GDrive, and records the backup path locally.
---

# Asset Backup

Use this skill to back up Gaia Research visual assets and asset metadata to cloud storage via `rclone`.

## Scope

Default backup source set:

- `assets/` — all repository asset files, including production assets, generated exports, brand SVGs, and workbench review artifacts.
- `content/assets/` — asset ledger, schema, and export recipes.
- `/data/data/com.termux/files/home/gaia-asset-master-backups/2026-07-09-gaia-research/` — local out-of-repo master backup folder, when present.

Default remote destination pattern:

```text
GDrive:gaia-research-asset-backups/YYYY-MM-DD_HH-MM-SS
```

## Preflight

Run:

```bash
command -v rclone
rclone version | head -5
rclone listremotes
```

Requirements:

- `rclone` must be installed.
- `GDrive:` remote must exist, unless the user explicitly provides another remote.
- Do not upload secrets, `.git/`, `node_modules/`, or unrelated home-directory files.

## Backup command

From the Gaia Research repo root:

```bash
set -e
REMOTE="${ASSET_BACKUP_REMOTE:-GDrive:gaia-research-asset-backups/$(date +%Y-%m-%d_%H-%M-%S)}"
echo "Backing up Gaia Research assets to $REMOTE"

rclone mkdir "$REMOTE"

rclone copy assets "$REMOTE/assets" \
  --create-empty-src-dirs \
  --transfers 4 \
  --checkers 8 \
  --progress

rclone copy content/assets "$REMOTE/content-assets" \
  --create-empty-src-dirs \
  --transfers 4 \
  --checkers 8 \
  --progress

if [ -d /data/data/com.termux/files/home/gaia-asset-master-backups/2026-07-09-gaia-research ]; then
  rclone copy /data/data/com.termux/files/home/gaia-asset-master-backups/2026-07-09-gaia-research \
    "$REMOTE/local-master-backup-2026-07-09-gaia-research" \
    --create-empty-src-dirs \
    --transfers 4 \
    --checkers 8 \
    --progress
fi

mkdir -p .asset-cache
echo "$REMOTE" > .asset-cache/last-rclone-backup.txt

echo "BACKUP_REMOTE=$REMOTE"
rclone size "$REMOTE"
```

## Verification

After backup, verify:

```bash
rclone size "$REMOTE"
rclone lsf "$REMOTE" --max-depth 2 | sort | head -100
```

Expected top-level directories:

```text
assets/
content-assets/
local-master-backup-2026-07-09-gaia-research/
```

The local record should exist at:

```text
.asset-cache/last-rclone-backup.txt
```

## Reporting

Final response should include:

- rclone binary/version and remote used.
- destination path.
- object count and total size from `rclone size`.
- whether local master backups were included.
- path to `.asset-cache/last-rclone-backup.txt`.

## Notes

- The `assets/workbench/` directory is intentionally included for full asset recovery unless the user asks for production-only backup.
- To use another remote for one run, set `ASSET_BACKUP_REMOTE`, for example:

```bash
ASSET_BACKUP_REMOTE="OtherRemote:gaia-research-asset-backups/manual" /skill:asset-backup
```
