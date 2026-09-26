#!/usr/bin/env bash
# Optional installer and health-check runner for Codex Computer Use in Pi.
# Managed by pi-config as an optional integration.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
python_tool="$script_dir/codex-computer-use.py"

if ! command -v python3 >/dev/null 2>&1; then
    echo "Error: python3 is required to run the Codex Computer Use installer/doctor." >&2
    exit 1
fi

action="install"
extra_args=()

for arg in "$@"; do
    case "$arg" in
        --doctor|doctor|--check|check)
            action="doctor"
            ;;
        --smoke-test|smoke-test|--test|test)
            action="smoke-test"
            ;;
        --disable|disable|--uninstall|uninstall)
            action="disable"
            ;;
        --install|install)
            action="install"
            ;;
        --json)
            extra_args+=("--json")
            ;;
        --agent-dir=*)
            extra_args+=("$arg")
            ;;
        *)
            extra_args+=("$arg")
            ;;
    esac
done

exec python3 "$python_tool" "$action" "${extra_args[@]+"${extra_args[@]}"}"
