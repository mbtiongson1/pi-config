#!/usr/bin/env bash
# Ensure Pi Quota defaults to the compact "quota line" surface instead of the multi-line box.
# Called by pi-config Update, Reinstall, Sync, and the Pi launcher to guarantee persistent line-mode preference.
# Pi quota box should never be on by default. Default is quota line.
set -euo pipefail

agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
settings_file="$agent_dir/settings.json"

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

# 2. Collect all quota-panel.ts candidates under $agent_dir
panels=()
if [[ -d "$agent_dir" ]]; then
  while IFS= read -r p; do
    [[ -n "$p" ]] && panels+=("$p")
  done < <(find "$agent_dir" -type f -name "quota-panel.ts" 2>/dev/null || true)
fi

known_panel="$agent_dir/git/github.com/J3fp/piQuota/extensions/quota-panel.ts"
if [[ -f "$known_panel" ]]; then
  found=false
  for p in "${panels[@]:-}"; do
    if [[ "$p" == "$known_panel" ]]; then
      found=true
      break
    fi
  done
  if [[ "$found" == false ]]; then
    panels+=("$known_panel")
  fi
fi

# 3. Patch quota-panel.ts to guarantee compact line default and reset on session start
for panel in "${panels[@]:-}"; do
  [[ -f "$panel" ]] || continue
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    let content = fs.readFileSync(path, "utf-8");
    let changed = false;

    // Ensure default variables do not default to boxVisible = true
    if (/let\s+boxVisible\s*=\s*true\s*;/.test(content)) {
      content = content.replace(/let\s+boxVisible\s*=\s*true\s*;/g, "let boxVisible = false;");
      changed = true;
    }
    if (/let\s+explicitBox\s*=\s*true\s*;/.test(content)) {
      content = content.replace(/let\s+explicitBox\s*=\s*true\s*;/g, "let explicitBox = false;");
      changed = true;
    }
    if (/let\s+lineVisible\s*=\s*false\s*;/.test(content)) {
      content = content.replace(/let\s+lineVisible\s*=\s*false\s*;/g, "let lineVisible = true;");
      changed = true;
    }
    // Clean up any double semicolons
    if (/let\s+boxVisible\s*=\s*false\s*;\s*;/.test(content)) {
      content = content.replace(/let\s+boxVisible\s*=\s*false\s*;\s*;/g, "let boxVisible = false;");
      changed = true;
    }
    if (/let\s+explicitBox\s*=\s*false\s*;\s*;/.test(content)) {
      content = content.replace(/let\s+explicitBox\s*=\s*false\s*;\s*;/g, "let explicitBox = false;");
      changed = true;
    }

    // Ensure session_start resets back to line default
    if (content.includes("pi.on(\"session_start\"") && !content.includes("boxVisible = false; // default quota line")) {
      content = content.replace(
        /(pi\.on\("session_start"[^{]+\{[\s\S]*?if\s*\(!ui\.hasUI\)\s*return;\s*\n\s*disposed\s*=\s*false;)/,
        "$1\n    boxVisible = false; // default quota line\n    explicitBox = false;\n    lineVisible = true;"
      );
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(path, content, "utf-8");
      console.log("Patched " + path + " to default to compact line");
    } else {
      console.log(path + " already configured for compact line default");
    }
  ' "$panel"
done

echo "pi-quota line default verified."
