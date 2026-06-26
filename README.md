# Pi Configuration

Minimal, reproducible pi configuration for vanilla setup with custom extensions and subagents.

**Author:** mbtiongson1  
**Docs:** [pi.dev](https://pi.dev)

## Contents

- **agents/** - Custom subagents (planner, reviewer, scout, worker)
- **extensions/** - Custom extensions
- **prompts/** - Custom prompt templates
- **bin/** - Utility scripts
- **settings.json.template** - Base settings (customize with your provider and models)

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

3. Edit `~/.pi/agent/settings.json` to add your provider/models config (see [pi.dev docs](https://pi.dev))

4. Restart pi

## What's NOT Included

- `auth.json` - API keys and authentication (local only)
- `models.json` - Provider configuration (local setup)
- `sessions/` - Session histories  
- `trust.json` - Local trust allowlist
- Any sensitive credentials or custom proxy configs

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
