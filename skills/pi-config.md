---
name: pi-config
description: Manages the local ~/.pi/agent/ configuration using the remote git repository https://github.com/mbtiongson1/pi-config. Supports Update, Reinstall, and Sync workflows.
---

# Pi Config Skill

This skill helps manage the pi agent's global configuration (`~/.pi/agent/`) from the git repository `https://github.com/mbtiongson1/pi-config`.

## Execution Workflows

When the user invokes this skill (or asks to manage, update, reinstall, or sync their pi configuration), follow these instructions step-by-step.

### 1. Initial Prompt
Ask the user to choose one of the following operations:
- **Update**: Pull the latest configuration from the repo and layer it over the existing local configuration.
- **Reinstall**: Clean wipe the local configuration directories, then copy fresh configurations from the repo.
- **Sync**: Push the current local configuration state back to the repo.

---

### 2. Update Workflow
If the user selects **Update**:
1. **Clone the Repo**: Run `git clone https://github.com/mbtiongson1/pi-config /data/data/com.termux/files/home/pi-config-temp` to clone the configuration to a temporary directory.
2. **Layer over Config**: Copy files from the temporary repository directories into the respective local `~/.pi/agent/` directories:
   - Copy contents of `agents/`, `bin/`, `extensions/`, `prompts/`, `skills/`, and `themes/` to `~/.pi/agent/` (e.g., using `cp -r`).
   - Do NOT overwrite existing local-only configuration files like `auth.json`, `trust.json`, or the `sessions/` directory.
3. **Optional Packages Check**: Before deleting the temp folder, run the **Check Optional Packages** step described below.
4. **Clean Up**: Remove the temporary directory `/data/data/com.termux/files/home/pi-config-temp`.
5. **Report**: Confirm to the user that the configuration has been updated successfully.

---

### 3. Reinstall Workflow
If the user selects **Reinstall**:
1. **Clone the Repo**: Run `git clone https://github.com/mbtiongson1/pi-config /data/data/com.termux/files/home/pi-config-temp` to clone the configuration to a temporary directory.
2. **Clean Wipe**: Delete the following standard directories inside `~/.pi/agent/` to ensure a clean wipe:
   - `agents/`
   - `bin/`
   - `extensions/`
   - `prompts/`
   - `skills/`
   - `themes/`
   - *CRITICAL*: Do NOT delete `auth.json`, `trust.json`, or the `sessions/` directory, as this will destroy the active agent credentials and sessions.
3. **Copy Fresh Config**: Copy the directories `agents/`, `bin/`, `extensions/`, `prompts/`, `skills/`, and `themes/` from the temporary repository to `~/.pi/agent/`.
4. **Initialize Settings**: Check if `~/.pi/agent/settings.json` exists. If the user wants a completely fresh start or it's missing, copy `settings.json.template` from the cloned repo to `~/.pi/agent/settings.json`.
5. **Optional Packages Check**: Before deleting the temp folder, run the **Check Optional Packages** step described below.
6. **Clean Up**: Remove the temporary directory `/data/data/com.termux/files/home/pi-config-temp`.
7. **Report**: Confirm to the user that the configuration has been cleanly reinstalled.

---

### 4. Sync Workflow
If the user selects **Sync**:
1. **Clone the Repo**: Run `git clone https://github.com/mbtiongson1/pi-config /data/data/com.termux/files/home/pi-config-temp` to clone the repository to a temporary directory.
2. **Copy Local State**:
   - For each standard directory (`agents/`, `bin/`, `extensions/`, `prompts/`, `skills/`, `themes/`), delete its contents in the temporary clone directory and copy the contents from `~/.pi/agent/<directory>` into the clone.
   - Do NOT copy sensitive credential/session files (e.g., `auth.json`, `trust.json`, `sessions/`) into the clone.
   - Copy `~/.pi/agent/settings.json` into the temporary clone as `settings.json.template` (remove/redact any sensitive api keys or personal information if any exist in it).
3. **Commit Changes**:
   - Run `git status` inside the clone to verify changes.
   - Ask the user for a commit message. If none is provided, use a default like: `Sync current local ~/.pi/agent state`.
   - Run `git add -A` and `git commit -m "<message>"`.
4. **Push to Remote**: Run `git push origin main` (or the active branch) to push the local changes to GitHub.
5. **Clean Up**: Remove the temporary directory `/data/data/com.termux/files/home/pi-config-temp`.
6. **Report**: Confirm to the user that the local state has been synchronized and pushed to the repository.

---

### 5. Check Optional Packages Step
After completing an **Update** or **Reinstall**, do the following:
1. **Locate `optional-packages.json`**: Read the file `/data/data/com.termux/files/home/pi-config-temp/optional-packages.json`.
2. **Check Local Settings**: Read `~/.pi/agent/settings.json`.
3. **Compare Packages**:
   - Parse the `"packages"` array from `settings.json`.
   - Iterate through each package defined in `optional-packages.json`.
   - Identify any package that is not present in the local `"packages"` list.
4. **Ask User**: If there are missing packages, ask the user:
   - "The following optional packages from the repo are not currently installed:
     - `[package-name]` - `[description]`
     Would you like to install them?"
5. **Install Packages**: If the user approves, run `pi install <package>` for each approved package to install it and update `settings.json`.
