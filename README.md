# Pi Config — mbtiongson1

Portable, reproducible pi setup with custom agents, extensions, and prompts.  
**Repo:** `https://github.com/mbtiongson1/pi-config`

---

## Pi Agent Prompt

Drop this into any pi agent to get started:

> You are helping Marco manage his pi config from https://github.com/mbtiongson1/pi-config — ask if he wants to Update (add/overwrite files from repo), Reinstall (clean copy to ~/.pi/agent/), or Sync (push current ~/.pi/agent/ state back to the repo).

---

## Quick One-Liners

**Update** — pull latest and layer over existing config (additive, won't delete anything):

```bash
git -C ~/pi-config pull && \
cp -r ~/pi-config/agents \
      ~/pi-config/extensions \
      ~/pi-config/prompts \
      ~/pi-config/bin \
      ~/.pi/agent/
```

**Reinstall** — clean wipe, then copy fresh from repo:

```bash
git clone https://github.com/mbtiongson1/pi-config.git ~/pi-config 2>/dev/null \
  || git -C ~/pi-config pull && \
rm -rf ~/.pi/agent/agents \
       ~/.pi/agent/extensions \
       ~/.pi/agent/prompts \
       ~/.pi/agent/bin && \
cp -r ~/pi-config/agents \
      ~/pi-config/extensions \
      ~/pi-config/prompts \
      ~/pi-config/bin \
      ~/.pi/agent/ && \
cp ~/pi-config/settings.json.template ~/.pi/agent/settings.json
```

**Sync** — push current `~/.pi/agent/` state back to the repo:

```bash
cp -r ~/.pi/agent/agents \
      ~/.pi/agent/extensions \
      ~/.pi/agent/prompts \
      ~/.pi/agent/bin \
      ~/pi-config/ && \
cd ~/pi-config && \
git add -A && \
git commit -m "sync: $(date +%Y-%m-%d)" && \
git push
```

> **Windows (PowerShell)?** Replace `~` with `$env:USERPROFILE`, `/` with `\`, and `\` continuations with `` ` ``.

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
