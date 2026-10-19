#!/usr/bin/env bash
# Install Astra Advisor as a portable skill and/or native agent profile.
# Supports Pi CLI and Codex CLI independently.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
skill_source="$repo_root/skills/astra-advisor"
agent_source="$repo_root/agents/advisor-astra.md"
codex_profile_source="$skill_source/codex.config.toml"

pi_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
codex_home_dir="${CODEX_HOME:-$HOME/.codex}"

target_env="all"

if [[ $# -gt 0 ]]; then
    case "$1" in
        --pi) target_env="pi" ;;
        --codex) target_env="codex" ;;
        --all) target_env="all" ;;
        -h|--help)
            echo "Usage: $0 [--pi | --codex | --all]"
            echo ""
            echo "Installs Astra Advisor:"
            echo "  --pi     Install into Pi (~/.pi/agent/skills/astra-advisor and ~/.pi/agent/agents/)"
            echo "  --codex  Install into Codex (~/.codex/skills/astra-advisor and ~/.codex/astra-advisor.config.toml)"
            echo "  --all    Install into both Pi and Codex environments (default)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Run '$0 --help' for usage." >&2
            exit 1
            ;;
    esac
fi

installed_any=0

# Install to Pi
if [[ "$target_env" == "pi" || "$target_env" == "all" ]]; then
    pi_skill_target="$pi_agent_dir/skills/astra-advisor"
    mkdir -p "$pi_skill_target"
    cp "$skill_source/SKILL.md" "$pi_skill_target/SKILL.md"
    
    if [[ -f "$agent_source" ]]; then
        mkdir -p "$pi_agent_dir/agents"
        cp "$agent_source" "$pi_agent_dir/agents/advisor-astra.md"
    fi
    echo "✓ Astra Advisor installed for Pi at $pi_skill_target"
    installed_any=1
fi

# Install to Codex
if [[ "$target_env" == "codex" || "$target_env" == "all" ]]; then
    codex_skill_target="$codex_home_dir/skills/astra-advisor"
    mkdir -p "$codex_skill_target"
    cp "$skill_source/SKILL.md" "$codex_skill_target/SKILL.md"

    if [[ -f "$codex_profile_source" && ! -e "$codex_home_dir/astra-advisor.config.toml" ]]; then
        mkdir -p "$codex_home_dir"
        cp "$codex_profile_source" "$codex_home_dir/astra-advisor.config.toml"
    fi
    cp "$repo_root/bin/astra-advisor-preflight.py" "$codex_skill_target/preflight.py"
    cp "$repo_root/bin/run-astra-advisor.sh" "$codex_skill_target/run-astra-advisor.sh"
    chmod +x "$codex_skill_target/run-astra-advisor.sh"
    echo "✓ Astra Advisor installed for Codex at $codex_skill_target and $codex_home_dir/astra-advisor.config.toml"
    echo "  Launch with: $codex_skill_target/run-astra-advisor.sh \"Situation: ... Constraints: ... Options: ... Goal: ...\""
    installed_any=1
fi

if [[ "$installed_any" -eq 1 ]]; then
    echo ""
    echo "Invocation examples:"
    echo "  Pi (Skill):         /skill astra-advisor"
    echo "  Pi (Agent):         subagent({ agent: 'advisor-astra', task: '...' })"
    echo "  Codex (Agent CLI):  codex -p astra-advisor"
    echo "  Codex (Headless):   codex exec -p astra-advisor \"Situation: ... Constraints: ... Options: ... Goal: ...\""
fi
