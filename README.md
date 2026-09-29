# Pi Config — mbtiongson1 (v1.10.0)

Portable, reproducible pi setup with custom agents, extensions, prompts, and a **mandatory pi-cost skill**.
**Repo:** `https://github.com/mbtiongson1/pi-config`

---

## Pi Agent Prompt

```
You are helping manage a pi config
from https://github.com/mbtiongson1/pi-config.

Ask if the user wants to:
- Update (pull latest and layer over existing config, including mandatory pi-cost)
- Reinstall (clean wipe of managed folders, then copy fresh from repo and install mandatory pi-cost)
- Sync (push current ~/.pi/agent/ state back to the repo)
- Diff (show differences between ~/.pi/agent/ and the repo)

Then carry out whichever they choose.

After **every Update or Reinstall**, run `bash bin/install-pi-cost.sh` from this checkout. It copies and verifies the versioned skill, script, license/notice, and Gaia/LiteLLM price catalog into `${PI_CODING_AGENT_DIR:-~/.pi/agent}/skills/pi-cost`; installation failure blocks completion. Pi discovers this user skill without a `settings.json` package entry. `pi-cost` is **mandatory**, not an optional package.

Then check `optional-packages.json`. If any optional package is missing from `~/.pi/agent/settings.json`, ask whether to install it. Never treat `pi-cost` as optional.
```

---

## Quick One-Liners

**Update** — pull latest and layer over existing config (additive, won't delete anything):

```
Pull the latest from https://github.com/mbtiongson1/pi-config
and copy agents, extensions, prompts, and bin
into ~/.pi/agent/ without removing anything already there.
Run bash bin/install-pi-cost.sh from the repo and verify its success (mandatory).
Then check optional-packages.json in the repo and ask
if I want to install any listed packages that are missing from ~/.pi/agent/settings.json.
```

**Reinstall** — clean wipe, then copy fresh from repo:

```
Clone https://github.com/mbtiongson1/pi-config (or pull if already cloned),
wipe ~/.pi/agent/agents, extensions, prompts, and bin,
then copy them fresh from the repo.
Run bash bin/install-pi-cost.sh from the repo and verify its success (mandatory).
Also reset settings.json from the template.
Then check optional-packages.json in the repo and ask
if I want to install any listed packages that are missing from ~/.pi/agent/settings.json.
```

**Sync** — push current `~/.pi/agent/` state back to the repo:

```
Copy agents, extensions, prompts, and bin
from ~/.pi/agent/ into the local pi-config repo,
then commit and push to https://github.com/mbtiongson1/pi-config.
Skip auth.json, models.json, trust.json, and sessions/.
```

**Diff** — show differences between `~/.pi/agent/` and the repo:

```
Show differences between the installed files in ~/.pi/agent/
and the local repository /Users/marcotiongson/Documents/pi-config/
by diffing agents, extensions, prompts, and bin.
```

---

## What's in the Repo

| Path | Purpose |
|------|---------|
| `agents/` | Custom subagents (planner, reviewer, scout, worker) |
| `extensions/` | Custom pi extensions (including the last-message/cache status) |
| `prompts/` | Prompt templates |
| `bin/` | Utility scripts |
| `settings.json.template` | Base settings — fill in your provider + models |
| `skills/pi-cost/` | Mandatory v1.10.0 skill, cost calculator, license/notice, and auto-refreshing Gaia/LiteLLM price catalog |
| `bin/install-pi-cost.sh` | Required idempotent, verified install step on Update and Reinstall |
| `VERSION` | pi-config release version (`1.10.0`) |
| `bin/install-codex-computer-use.sh` | Optional installer & health-check runner for Codex Computer Use on macOS |
| `docs/codex-computer-use.md` | Guide for Codex Computer Use integration, doctor, and permissions |
| `optional-packages.json` | List of *other* optional packages/extensions to prompt for installation |

## What's NOT Committed (stays local)

`auth.json` · `models.json` · `trust.json` · `sessions/` · any API keys or proxy config

---

## Optional Integrations

### Codex Computer Use (macOS)
Give Pi agents native access to macOS desktop inspection and control using `pi-codex-computer-use`.

- **Platform**: macOS only
- **Prerequisites**: Pi CLI, Codex CLI, Codex.app / ChatGPT.app (`com.openai.codex`), Accessibility and Screen Recording permissions.
- **Install / Verify**:
  ```bash
  bash bin/install-codex-computer-use.sh          # Idempotent install
  bash bin/install-codex-computer-use.sh --doctor # Status check
  bash bin/install-codex-computer-use.sh --smoke-test # Live tool verification
  ```
- **Disable**:
  ```bash
  bash bin/install-codex-computer-use.sh --disable
  ```
- Full guide: [`docs/codex-computer-use.md`](docs/codex-computer-use.md)

---

For provider/model setup, see [pi.dev docs](https://pi.dev).
