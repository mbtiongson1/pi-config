#!/usr/bin/env bash
# Install the pi-config engineering-discipline contract into Pi's native
# global system-prompt append file. Idempotent; preserves user content outside
# the managed marker block. Never touches SYSTEM.md or project .pi overrides.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_file="$repo_root/APPEND_SYSTEM.md"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
target="$agent_dir/APPEND_SYSTEM.md"
begin='<!-- pi-config:begin -->'
end='<!-- pi-config:end -->'

[[ -s "$source_file" ]] || { echo "append-system installer: missing $source_file" >&2; exit 2; }
[[ -L "$target" ]] && { echo "append-system installer: refusing to overwrite symlink $target" >&2; exit 2; }
mkdir -p "$agent_dir"

block="$(printf '%s\n%s\n%s' "$begin" "$(cat "$source_file")" "$end")"
tmp="$(mktemp "$agent_dir/.APPEND_SYSTEM.md.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

if [[ -f "$target" ]] && grep -Fxq "$begin" "$target"; then
    if ! grep -Fxq "$end" "$target"; then
        echo "append-system installer: unterminated managed block in $target" >&2; exit 2
    fi
    # Replace only the managed block, keep everything else byte-for-byte.
    BLOCK="$block" awk -v b="$begin" -v e="$end" '
        $0 == b { print ENVIRON["BLOCK"]; skip = 1; next }
        $0 == e && skip { skip = 0; next }
        !skip { print }' "$target" > "$tmp"
elif [[ -s "$target" ]]; then
    { cat "$target"; printf '\n%s\n' "$block"; } > "$tmp"
else
    printf '%s\n' "$block" > "$tmp"
fi

if [[ -f "$target" ]] && cmp -s "$tmp" "$target"; then
    echo "append-system contract already current at $target"
else
    chmod 0644 "$tmp"
    mv "$tmp" "$target"
    echo "append-system contract installed at $target"
fi
grep -Fq "$(head -n1 "$source_file")" "$target" || { echo "append-system installer: verification failed" >&2; exit 2; }
