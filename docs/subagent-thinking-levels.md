# Subagent Thinking Levels — End-to-End Setup Guide

Agents in pi dispatch work via the **subagent extension**. This guide shows how to
wire up **role templates** so every agent automatically runs with the right model
and thinking level — without hardcoding anything in the agent `.md` files themselves.

---

## How It Works

```
agent file            agent-templates.json        subagent extension
──────────────        ────────────────────        ──────────────────
role: planner   →  { model: "...", thinkingLevel: "high" }  →  pi --model X --thinking-level high
```

1. **Agent files** declare a `role:` (planner, worker, scout, reviewer, or custom).
2. **`agent-templates.json`** maps each role to a model string and thinking level.
3. The **subagent extension** reads the templates at call time, resolves the effective
   config, and passes `--model` and `--thinking-level` to the spawned `pi` process.
4. The **TUI call header** renders the role label and thinking level tag so you can
   see at a glance what's running.

Agent files can still override with explicit `model:` or `thinking_level:` frontmatter —
those always win over the template.

---

## Step 1 — Install the extension

Copy `extensions/subagent/` into `~/.pi/agent/extensions/`:

```bash
cp -r extensions/subagent ~/.pi/agent/extensions/subagent
```

Or let the repo's install flow handle it (Update / Reinstall from the README).

Add it to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["extensions/subagent/index.ts"]
}
```

---

## Step 2 — Configure your role templates

Copy the template file and fill in your model strings:

```bash
cp agent-templates.json ~/.pi/agent/agent-templates.json
```

Edit `~/.pi/agent/agent-templates.json`:

```json
{
  "planner": {
    "model": "anthropic--claude-opus-4-5",
    "thinkingLevel": "high"
  },
  "worker": {
    "model": "anthropic--claude-sonnet-4-5",
    "thinkingLevel": "medium"
  },
  "scout": {
    "model": "anthropic--claude-haiku-4-5",
    "thinkingLevel": "minimal"
  },
  "reviewer": {
    "model": "anthropic--claude-sonnet-4-5",
    "thinkingLevel": "low"
  }
}
```

Use whatever models your provider exposes. The model string format is
`provider--model-id` (same as the `--model` CLI flag). You can also use the
combined `provider--model-id:thinking-level` shorthand in the `model` field —
the extension passes it straight through to the CLI.

**Built-in thinking-level defaults** (apply when `thinkingLevel` is absent from
your template):

| Role     | Default thinking level |
|----------|------------------------|
| planner  | `high`                 |
| worker   | `medium`               |
| scout    | `minimal`              |
| reviewer | `low`                  |

The extension always loads these as a fallback — `agent-templates.json` is only
needed when you want to set (or override) the `model`.

---

## Step 3 — Write agent files with `role:`

Agent files live in `~/.pi/agent/agents/`. The minimum required frontmatter is
`name:`, `description:`, and `role:`. Everything else is optional.

```markdown
---
name: my-planner
description: Turns scout findings into a numbered implementation plan
role: planner
tools: read, grep, find, ls
---

You are a planning specialist...
```

You can define as many variants as you like — `my-planner-fast.md`,
`my-planner-thorough.md` — all wearing the same `role: planner` template.

### Overriding the template

Set `model:` or `thinking_level:` directly in the frontmatter to override:

```markdown
---
name: my-experimental-planner
description: Planner variant using max thinking
role: planner
thinking_level: max          # overrides the template's "high"
---
```

---

## Step 4 — Reload and verify

In pi, run `/reload` to pick up the extension changes. Then invoke a subagent:

```
Use the my-planner agent to draft a plan for adding dark mode.
```

You should see the call header:

```
subagent my-planner [user] [planner] [high]
  Draft a plan for adding dark mode.
```

The `[planner]` label comes from the `role:` field; `[high]` comes from the
template (or built-in default).

For parallel and chain modes:

```
subagent parallel (2 tasks) [user]
  my-scout  [scout] [minimal]  Map out the theme system...
  my-worker [worker] [medium]  Implement the colour tokens...

subagent chain (2 steps) [user]
  1. my-scout  [scout] [minimal]  Map out the theme system...
  2. my-planner [planner] [high]  Turn findings into a plan...
```

---

## Template file reference

`~/.pi/agent/agent-templates.json`

```jsonc
{
  // Built-in roles — override any field you need.
  "planner":  { "model": "...", "thinkingLevel": "high"    },
  "worker":   { "model": "...", "thinkingLevel": "medium"  },
  "scout":    { "model": "...", "thinkingLevel": "minimal" },
  "reviewer": { "model": "...", "thinkingLevel": "low"     },

  // Custom roles — any name works.
  "architect": { "model": "...", "thinkingLevel": "xhigh" },
  "fast-fixer": { "model": "...", "thinkingLevel": "off"  }
}
```

Valid thinking levels: `off` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max`

---

## Agent frontmatter reference

| Field           | Required | Description |
|-----------------|----------|-------------|
| `name`          | ✓        | Agent identifier used in subagent calls |
| `description`   | ✓        | Shown in agent listings |
| `role`          |          | Template name; resolves model + thinkingLevel |
| `model`         |          | Explicit model override (beats template) |
| `thinking_level`|          | Explicit thinking-level override (beats template) |
| `tools`         |          | Comma-separated tool allowlist |
