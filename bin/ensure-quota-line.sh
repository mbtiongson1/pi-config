#!/usr/bin/env bash
# Ensure Pi Quota defaults to the compact "quota line" surface instead of the multi-line box.
# Called by pi-config Update, Reinstall, and Sync to guarantee persistent line-mode preference.
set -euo pipefail

agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
settings_file="$agent_dir/settings.json"
quota_dir="$agent_dir/git/github.com/J3fp/piQuota"
quota_panel="$quota_dir/extensions/quota-panel.ts"

# 1. Ensure ~/.pi/agent/settings.json contains "quota": { "surface": "line" }
if [[ -f "$settings_file" ]]; then
    node -e '
      const fs = require("fs");
      const path = process.argv[1];
      try {
        const data = JSON.parse(fs.readFileSync(path, "utf-8"));
        if (!data.quota || data.quota.surface !== "line") {
          data.quota = Object.assign({}, data.quota, { surface: "line" });
          fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
          console.log("Configured quota surface to line in " + path);
        } else {
          console.log("Quota surface already set to line in " + path);
        }
      } catch (err) {
        console.error("Failed to update settings.json:", err.message);
      }
    ' "$settings_file"
fi

# 2. Patch quota-panel.ts if present and defaulting to box
if [[ -f "$quota_panel" ]]; then
    node -e '
      const fs = require("fs");
      const path = process.argv[1];
      let content = fs.readFileSync(path, "utf-8");
      let changed = false;

      // Ensure default variables do not default to boxVisible = true
      if (content.includes("let boxVisible = true;") || content.includes("let explicitBox = true;")) {
        content = content.replace("let boxVisible = true;", "let boxVisible = false;");
        content = content.replace("let explicitBox = true;", "let explicitBox = false;");
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(path, content, "utf-8");
        console.log("Patched quota-panel.ts to default to compact line");
      } else {
        console.log("quota-panel.ts already configured for compact line default");
      }
    ' "$quota_panel"
fi

echo "pi-quota line default verified."
