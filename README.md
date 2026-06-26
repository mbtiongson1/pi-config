# Pi Configuration

Minimal, reproducible pi configuration for vanilla setup with custom extensions and subagents.

**Author:** mbtiongson1  
**Docs:** [pi.dev](https://pi.dev)

## Contents

- **agents/** - Custom subagents (planner, reviewer, scout, worker)
- **extensions/** - Custom extensions
- **prompts/** - Custom prompt templates
- **bin/** - Utility scripts
- **settings.json.template** - Base settings (copy to `~/.pi/agent/settings.json` and customize)
- **trust.json** - Trust configuration

## Installation

1. Clone this repo:
```bash
git clone https://github.com/mbtiongson1/pi-config.git
cd pi-config
```

2. Copy to your pi config directory:
```bash
cp -r agents extensions prompts bin ~/.pi/agent/
cp settings.json.template ~/.pi/agent/settings.json
cp trust.json ~/.pi/agent/trust.json
```

3. Configure `~/.pi/agent/settings.json` with your preferred provider and models

4. Restart pi

## What's NOT Included

- `auth.json` - API keys and authentication (keep local only)
- `models.json` - Provider configuration (set up locally)
- `sessions/` - Session histories
- HAI-proxy custom setup - Use vanilla pi providers
- Any sensitive credentials

## For Pi Agents

When using pi agents to work with this config:
- All core extensions are in `extensions/subagent/`
- All subagents are defined in `agents/`
- Use relative paths within this structure
- Settings should reference only public/configurable aspects

## Platform Support

Works on macOS, Linux, and Windows. Built to be sync-friendly across machines.

---

For more info on pi configuration, see [pi.dev documentation](https://pi.dev).
