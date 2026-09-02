---
description: Report token usage and USD cost from harness JSONL session logs (skill-cost)
argument-hint: "[--all|--today|--since DATE|--harness <id>|--session ID|--cwd PATH|--by-model|--list|--json|--refresh-prices]"
---
Load the `cost` skill and follow its instructions.

Run:

```bash
python3 "$(dirname "$(find ~/.pi/agent/skills ~/.claude/skills ~/.codex/skills ~/.agents/skills .agents/skills .claude/skills -type f -name 'cost.py' 2>/dev/null | head -1)")/cost.py" $ARGUMENTS
```

Then:
- Show the script's stdout verbatim in a fenced block.
- Summarize the grand-total cost and which harness/session it covers.
- If unpriced models are listed, suggest `--refresh-prices`.
- Do not invent numbers beyond what the script prints.
