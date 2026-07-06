---
name: pi-config
description: Manage the pi configuration from https://github.com/mbtiongson1/pi-config. Run when the user mentions "/pi-config", asks to update/sync/reinstall their pi configuration, or manage the pi config.
version: 1.0.0
---

# pi-config

Help the user manage their pi configuration from the local `pi-config` repository `/Users/marcotiongson/Documents/pi-config`.

## Action flow

When this skill is invoked:
1. Ask the user if they want to:
   - **Update** (pull latest and layer over existing config)
   - **Reinstall** (clean wipe, then copy fresh from repo)
   - **Sync** (push current `~/.pi/agent/` state back to the repo)
   - **Diff** (show differences between ~/.pi/agent/ and the repo)
2. Carry out whichever they choose by running the commands below.

### Action 1: Update
Pull the latest from https://github.com/mbtiongson1/pi-config and copy agents, extensions, prompts, and bin into `~/.pi/agent/` without removing anything already there.

Steps to execute:
1. Navigate to `/Users/marcotiongson/Documents/pi-config` and run:
   ```bash
   git pull origin main
   ```
2. Copy files additively (do not delete any existing files in destination):
   ```bash
   cp -R /Users/marcotiongson/Documents/pi-config/agents/ ~/.pi/agent/agents/
   cp -R /Users/marcotiongson/Documents/pi-config/extensions/ ~/.pi/agent/extensions/
   cp -R /Users/marcotiongson/Documents/pi-config/prompts/ ~/.pi/agent/prompts/
   cp -R /Users/marcotiongson/Documents/pi-config/bin/ ~/.pi/agent/bin/
   ```
3. Run the **Post-Action Check** to prompt for missing optional packages.

### Action 2: Reinstall
Clean wipe and copy fresh from the repository, then reset settings.

Steps to execute:
1. Navigate to `/Users/marcotiongson/Documents/pi-config` and run:
   ```bash
   git pull origin main
   ```
2. Wipe the existing folders:
   ```bash
   rm -rf ~/.pi/agent/agents ~/.pi/agent/extensions ~/.pi/agent/prompts ~/.pi/agent/bin
   ```
3. Copy them fresh from the repository:
   ```bash
   cp -R /Users/marcotiongson/Documents/pi-config/agents/ ~/.pi/agent/agents/
   cp -R /Users/marcotiongson/Documents/pi-config/extensions/ ~/.pi/agent/extensions/
   cp -R /Users/marcotiongson/Documents/pi-config/prompts/ ~/.pi/agent/prompts/
   cp -R /Users/marcotiongson/Documents/pi-config/bin/ ~/.pi/agent/bin/
   ```
4. Reset `settings.json` from the template:
   ```bash
   cp /Users/marcotiongson/Documents/pi-config/settings.json.template ~/.pi/agent/settings.json
   ```
5. Run the **Post-Action Check** to prompt for missing optional packages.

### Action 3: Sync
Push the current `~/.pi/agent/` state back to the repository.

Steps to execute:
1. Copy folders from `~/.pi/agent/` into the local repository:
   ```bash
   cp -R ~/.pi/agent/agents/ /Users/marcotiongson/Documents/pi-config/agents/
   cp -R ~/.pi/agent/extensions/ /Users/marcotiongson/Documents/pi-config/extensions/
   cp -R ~/.pi/agent/prompts/ /Users/marcotiongson/Documents/pi-config/prompts/
   cp -R ~/.pi/agent/bin/ /Users/marcotiongson/Documents/pi-config/bin/
   ```
   *(Note: Skip auth.json, models.json, trust.json, and sessions/)*
2. Commit and push the changes:
   ```bash
   cd /Users/marcotiongson/Documents/pi-config
   git add agents/ extensions/ prompts/ bin/
   git commit -m "Sync: update pi-config configuration"
   git push origin main
   ```

### Action 4: Diff
Show differences between the installed files in `~/.pi/agent/` and the local repository `/Users/marcotiongson/Documents/pi-config/`.

Steps to execute:
1. Compare agents, extensions, prompts, and bin:
   ```bash
   for dir in agents extensions prompts bin; do
     echo "=== Diff for $dir ==="
     diff -ru ~/.pi/agent/$dir/ /Users/marcotiongson/Documents/pi-config/$dir/ || true
   done
   ```

---

## Post-Action Check

After completing an **Update** or **Reinstall**:
1. Check the `optional-packages.json` file in the repo `/Users/marcotiongson/Documents/pi-config/optional-packages.json`.
2. Read the packages listed in `~/.pi/agent/settings.json`.
3. If any packages listed in `optional-packages.json` are not currently installed in `~/.pi/agent/settings.json`, ask the user if they would like to install them.
4. If they agree to install a package, append it to the `"packages"` array in `~/.pi/agent/settings.json`.
