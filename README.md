# Pi Config — mbtiongson1

Portable, reproducible pi setup with custom agents, extensions, and prompts.  
**Repo:** `https://github.com/mbtiongson1/pi-config`

---

## Pi Agent Prompt

```
You are helping manage a pi config
from https://github.com/mbtiongson1/pi-config.

Ask if the user wants to:
- Update (pull latest and layer over existing config)
- Reinstall (clean wipe, then copy fresh from repo)
- Sync (push current ~/.pi/agent/ state back to the repo)
- Diff (compare local to remote before making changes)

Then carry out whichever they choose.

After an Update or Reinstall, check the `optional-packages.json` file in the repo.
If any packages listed there are not currently installed in `~/.pi/agent/settings.json`,
ask the user if they would like to install them.
```

---

## Quick One-Liners

**Update** — pull latest and layer over existing config (additive, won't delete anything):

```
Pull the latest from https://github.com/mbtiongson1/pi-config
and copy agents, extensions, prompts, and bin
into ~/.pi/agent/ without removing anything already there.
Then check optional-packages.json in the repo and ask
if I want to install any listed packages that are missing from ~/.pi/agent/settings.json.
```

**Reinstall** — clean wipe, then copy fresh from repo:

```
Clone https://github.com/mbtiongson1/pi-config (or pull if already cloned),
wipe ~/.pi/agent/agents, extensions, prompts, and bin,
then copy them fresh from the repo.
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

**Diff** — preview what will change:

```
Clone https://github.com/mbtiongson1/pi-config into a temp dir and compare
it with ~/.pi/agent/ to show what will be added, removed, or changed.
```

---

## Environment Variables

For the best caching behavior (1-hour cache retention), add the following to your `~/.bashrc` or `~/.profile`:

```bash
export PI_CACHE_RETENTION=long
```

---

## What's in the Repo

| Path | Purpose |
|------|---------|
| `agents/` | Custom subagents — declare `role:` instead of model strings |
| `extensions/` | Custom pi extensions (subagent extension with role-template support) |
| `prompts/` | Prompt templates |
| `bin/` | Utility scripts |
| `agent-templates.json` | Role → model + thinking-level map. Copy to `~/.pi/agent/` |
| `settings.json.template` | Base settings — fill in your provider + models |
| `optional-packages.json` | List of optional packages/extensions to prompt for installation |

## Subagent Role Templates

Agents declare a  (planner, worker, scout, reviewer) instead of a hardcoded model.
The role resolves model + thinking level from .

Built-in thinking-level defaults (no config needed just for thinking):

| Role     | Thinking level |
|----------|----------------|
| planner  |          |
| worker   |        |
| scout    |       |
| reviewer |           |

Copy  to  and fill in your model strings.
Full guide: [docs/subagent-thinking-levels.md](docs/subagent-thinking-levels.md)

---

## What's NOT Committed (stays local)

`auth.json` · `models.json` · `trust.json` · `sessions/` · any API keys or proxy config

---

For provider/model setup, see [pi.dev docs](https://pi.dev).
