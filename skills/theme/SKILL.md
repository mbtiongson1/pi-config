---
name: theme
description: Switch or cycle Pi interface color themes. Supports next, previous, random, specific theme name (e.g. favor-dark, favor-cream, favor-indigo, favor-events, favor-finance-green, favor-watershed, finance-editorial, gaia-research, gaia-skill-tree), or opening the interactive theme picker.
---

# /theme — Pi Theme Switcher & Random Cycle

Universal theme management skill and slash command for Pi.

## Overview

Pi automatically cycles through installed custom themes randomly upon startup.
The `/theme` command and `set_theme` tool allow operators and agents to switch, cycle, or interactively pick themes at any time.

## Commands

- `/theme` — Open the interactive theme picker with live preview and fuzzy search (like a model picker).
- `/theme next` — Cycle to the next custom theme in the catalog.
- `/theme prev` or `/theme previous` — Cycle to the previous custom theme.
- `/theme random` — Pick a random custom theme immediately.
- `/theme <name>` — Switch directly to a theme by name (e.g., `/theme favor-dark`, `/theme favor-cream`, `/theme favor-indigo`, `/theme favor-events`, `/theme favor-finance-green`, `/theme favor-watershed`, `/theme finance-editorial`, `/theme gaia-research`, `/theme gaia-skill-tree`, `/theme dark`, `/theme light`).
  Fuzzy matching is supported (e.g., `/theme indigo` matches `favor-indigo`).

## Available Custom Themes (Favor Design System)

1. **favor-dark** (Dark) — Near-black chart ground (`#070b0e`), Favor orange accent (`#ff7a33`), cyan secondary (`#56c2e8`), gold warnings (`#ffc24d`), ice text (`#e2edf2`). Inspired by the Pathways island dashboard.
2. **favor-cream** (Light) — Warm cream parchment ground (`#fef1e8`), deep Favor orange accent (`#c23f00` / `#f45500`), ocean blue secondary (`#0077a4`), forest green (`#34735a`), dark charcoal text (`#121411`). Default executive overview palette.
3. **favor-indigo** (Dark) — Midnight indigo console ground (`#0f111c`), bright periwinkle indigo accent (`#8796fc`), lavender secondary (`#b1bdfc`), warm paper ink (`#f4efe6`). Inspired by Connect Health.
4. **favor-events** (Dark) — Near-black stage violet ground (`#0b0a10`), stage-gel tangerine accent (`#ff5b3a`), ultraviolet secondary (`#8f7bff`), spotlight programme ink (`#f5f1e8`).
5. **favor-finance-green** (Light) — Ruled worksheet ledger-paper ground (`#eef3ea`), bottle green accent (`#1c6f4a`), ledger-pen blue secondary (`#1f5f8b`), deep spruce ink (`#0f1a12`).
6. **favor-watershed** (Light) — Crisp river-water tinted ground (`#f6fbfd`), river blue accent (`#0077a4`), sky blue secondary (`#35b0dc`), dark text (`#121411`).
7. **finance-editorial** (Light) — Parchment beige ground (`#f5eee5`), dark olive accent (`#303722`), oxblood secondary (`#882f2a`), warm brass gold (`#b18852`), espresso ink (`#211b15`).
8. **gaia-research** (Dark) — Deep obsidian ground (`#05060a`), Milim pink accent (`#ec4899`), Rimuru cyan (`#38bdf8`), ice text (`#f0f1f5`).
9. **gaia-skill-tree** (Dark) — Obsidian ground (`#05060a`), Honor red accent (`#ef4444`), Apex gold secondary (`#fbbf24`), ice text (`#f0f1f5`).

## How Bootup Random Cycling Works

When Pi boots up:
1. The theme extension hooks `session_start`.
2. Unless an explicit `--use-theme` CLI flag is set, it selects a random custom theme distinct from the current one.
3. The selected theme is applied immediately in-memory and saved to `settings.json`.
4. A subtle notification (`🎨 Theme: <name>`) and footer status are displayed.
