# Pi Config — mbtiongson1

Portable, reproducible pi setup with custom agents, extensions, and prompts.  
**Repo:** `https://github.com/mbtiongson1/pi-config`

---

## Pi Agent Prompt

Drop this into any pi agent to get started:

> You are helping Marco manage his pi config from https://github.com/mbtiongson1/pi-config — ask if he wants to Update (add/overwrite files from repo), Reinstall (clean copy to ~/.pi/agent/), or Sync (push current ~/.pi/agent/ state back to the repo).

---

## Quick Agent One-Liners

**Update** — pull latest and layer it over your existing config (additive, won't delete anything):

> Pull the latest from https://github.com/mbtiongson1/pi-config and copy agents, extensions, prompts, and bin over to ~/.pi/agent/ without removing anything that's already there.

**Reinstall** — clean wipe of agents/extensions/prompts/bin, then copy fresh from repo:

> Clone https://github.com/mbtiongson1/pi-config (or pull if already cloned), wipe ~/.pi/agent/agents, extensions, prompts, and bin, then copy them fresh from the repo. Also reset settings.json from the template.

**Sync** — push your current `~/.pi/agent/` state back up to the repo:

> Copy the current agents, extensions, prompts, and bin from ~/.pi/agent/ into the local pi-config repo, then commit and push to https://github.com/mbtiongson1/pi-config. Skip auth.json, models.json, trust.json, and sessions/.

---

## What's in the Repo

| Path | Purpose |
|------|---------|
| `agents/` | Custom subagents (planner, reviewer, scout, worker) |
| `extensions/` | Custom pi extensions |
| `prompts/` | Prompt templates |
| `bin/` | Utility scripts |
| `settings.json.template` | Base settings — fill in your provider + models |

## What's NOT Committed (stays local)

`auth.json` · `models.json` · `trust.json` · `sessions/` · any API keys or proxy config

---

For provider/model setup, see [pi.dev docs](https://pi.dev).
