#!/usr/bin/env bash
# Ensure Pi Subagent & Codemode reliability preferences and extensions.
# Called by pi-config Update, Reinstall, and Sync to guarantee persistent settings across upgrades.
set -euo pipefail

KNOWN_WORKING_SUBAGENT_VERSION="0.8.0"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
subagent_config="$HOME/.pi/subagent.json"
statusline_config="$agent_dir/statusline.json"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

echo "=== Pi Subagent & Codemode Reliability Check ==="

# 1. Ensure ~/.pi/subagent.json
node -e '
const fs = require("fs");
const file = process.argv[1];
const desired = {
  defaultTimeoutMs: 1800000,
  stallAfterMs: 300000,
  stallKillAfterMs: 0,
  maxActiveProcesses: 4,
  maxGlobalActive: 16,
  maxQueuedTasks: 32,
  graceTurns: 2
};
let current = {};
if (fs.existsSync(file)) {
  try {
    current = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    current = {};
  }
}
let changed = false;
for (const [k, v] of Object.entries(desired)) {
  if (current[k] !== v) {
    current[k] = v;
    changed = true;
  }
}
if (changed || !fs.existsSync(file)) {
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n", "utf-8");
  console.log("✓ Updated subagent config: " + file);
} else {
  console.log("✓ Subagent config verified: " + file);
}
' "$subagent_config"

# 2. Ensure statusline.json allows subagent & subagent-monitor
node -e '
const fs = require("fs");
const file = process.argv[1];
let current = {
  showExtensions: false,
  hideAll: false,
  blockedKeys: [],
  allowedKeys: ["last-message", "jev-cost", "subagent", "subagent-monitor"]
};
if (fs.existsSync(file)) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    current = Object.assign(current, raw);
  } catch (e) {}
}
const mustAllow = ["subagent", "subagent-monitor"];
let changed = false;
for (const key of mustAllow) {
  if (!current.allowedKeys.includes(key)) {
    current.allowedKeys.push(key);
    changed = true;
  }
}
if (changed || !fs.existsSync(file)) {
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n", "utf-8");
  console.log("✓ Updated statusline allowed keys in: " + file);
} else {
  console.log("✓ Statusline allowed keys verified: " + file);
}
' "$statusline_config"

# 3. Ensure extensions are deployed
mkdir -p "$agent_dir/extensions"
if [[ -f "$repo_root/extensions/subagent-monitor.ts" ]]; then
  cp "$repo_root/extensions/subagent-monitor.ts" "$agent_dir/extensions/subagent-monitor.ts"
  echo "✓ Deployed extensions/subagent-monitor.ts"
fi
if [[ -f "$repo_root/extensions/statusline.ts" ]]; then
  cp "$repo_root/extensions/statusline.ts" "$agent_dir/extensions/statusline.ts"
  echo "✓ Deployed extensions/statusline.ts"
fi

# 4. Verify upstream package version & compatibility
subagent_pkg="$agent_dir/npm/node_modules/@parke.dev/pi-subagent/package.json"
if [[ -f "$subagent_pkg" ]]; then
  installed_ver=$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).version || "unknown"); } catch (e) { console.log("unknown"); }' "$subagent_pkg")
  echo "✓ @parke.dev/pi-subagent installed version: $installed_ver (last verified: $KNOWN_WORKING_SUBAGENT_VERSION)"
else
  echo "! @parke.dev/pi-subagent package not found in npm packages"
fi

# 5. Ensure Antigravity Gemini 4 Argon
if [[ -x "$script_dir/ensure-antigravity-argon.sh" ]]; then
  "$script_dir/ensure-antigravity-argon.sh"
fi

# 6. Ensure Pi Quota line default (box should never be on by default)
if [[ -x "$script_dir/ensure-quota-line.sh" ]]; then
  "$script_dir/ensure-quota-line.sh"
fi

echo "All reliability preferences verified."
