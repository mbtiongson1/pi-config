#!/usr/bin/env bash
# Supported Codex launcher: resolve the installed model catalog before starting
# the advisor process, so an outdated or unsupported model cannot receive a turn.
set -euo pipefail

launcher_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -f "$launcher_dir/astra-advisor-preflight.py" ]]; then
    preflight="$launcher_dir/astra-advisor-preflight.py"
else
    preflight="$(cd "$launcher_dir/../skills/astra-advisor" && pwd -P)/preflight.py"
fi

if [[ $# -eq 0 ]]; then
    echo "Usage: $0 \"Situation: ... Constraints: ... Options: ... Goal: ...\"" >&2
    exit 2
fi
preflight_result="$(python3 "$preflight")"
printf '%s\n' "$preflight_result"
prompt="$*"
exec codex exec --ephemeral --profile astra-advisor -- "$preflight_result User brief: $prompt"
