---
name: pi-cost
description: >-
  Calculate and display the token usage, turns, and estimated cost for the active session
  and subagent runs by parsing the harness session logs. Use when the user asks for
  token usage, session cost, or types `/pi-cost`.
version: 1.0.0
---

# pi-cost

A utility skill to parse and estimate costs for the active Pi coding agent session, including any subagents called during the run.

## Setup

The Python helper script is pre-installed in the skill folder:
`scripts/pi_cost.py`

No extra dependencies are required.

## Usage

When triggered, execute the helper script using the `bash` tool.

If running from the `pi-config` repository root:
```bash
python3 skills/pi-cost/scripts/pi_cost.py
```

If the skill has been symlinked/installed globally:
```bash
python3 ~/.pi/agent/skills/pi-cost/scripts/pi_cost.py
```
