#!/usr/bin/env bash
# Device-scoped model catalog and Bunny routing for Pi.
# Thin wrapper around bin/device-models.py so the documented command surface
# stays `bash bin/device-models.sh <command>`.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "device-models: python3 is required" >&2
  exit 2
fi

exec python3 "$repo_root/bin/device-models.py" "$@"
