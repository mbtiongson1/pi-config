#!/usr/bin/env bash
# Install the mandatory pi-cost skill from this pi-config checkout.
# Called by both Update and Reinstall; never installs optional packages.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_dir="$repo_root/skills/pi-cost"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
target="$agent_dir/skills/pi-cost"
version="$(tr -d '\r\n' < "$repo_root/VERSION")"

if [[ "$version" != "1.10.0" ]]; then
    echo "pi-cost installer: expected pi-config v1.10.0; got $version" >&2
    exit 2
fi
if ! grep -Fxq "version: $version" "$source_dir/SKILL.md"; then
    echo "pi-cost installer: skill version does not match pi-config $version" >&2
    exit 2
fi
for file in SKILL.md LICENSE NOTICE scripts/pi_cost.py scripts/prices.json; do
    if [[ ! -s "$source_dir/$file" ]]; then
        echo "pi-cost installer: required file missing or empty: $file" >&2
        exit 2
    fi
done
if [[ -L "$target" || -L "$target/scripts" ]]; then
    echo "pi-cost installer: refusing to overwrite symlink in managed skill: $target" >&2
    exit 2
fi
mkdir -p "$target"
cp -R "$source_dir/." "$target/"
for file in SKILL.md LICENSE NOTICE scripts/pi_cost.py scripts/prices.json; do
    if ! cmp -s "$source_dir/$file" "$target/$file"; then
        echo "pi-cost installer: verification failed: $file" >&2
        exit 2
    fi
done
# Pi discovers user skills from <agent-dir>/skills; no settings/packages edit.
echo "pi-cost $version installed and verified at $target"
