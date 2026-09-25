---
name: pi-cost
description: >-
  Report cost and token usage for the active Pi session, direct worker runs and
  nested workers. The main orchestrator retains its harness-recorded cost;
  worker inference uses current Gaia skill-cost/LiteLLM public model and cache rates.
version: 1.10.0
---

# /pi-cost — Pi session and worker cost

```bash
python3 ~/.pi/agent/skills/pi-cost/scripts/pi_cost.py
python3 ~/.pi/agent/skills/pi-cost/scripts/pi_cost.py --json
python3 ~/.pi/agent/skills/pi-cost/scripts/pi_cost.py --session /path/to/session.jsonl
python3 ~/.pi/agent/skills/pi-cost/scripts/pi_cost.py --refresh-prices
python3 ~/.pi/agent/skills/pi-cost/scripts/pi_cost.py --offline
```

By default `PI_SESSION_FILE` selects the **current** Pi session; otherwise the
newest Pi session is used. `--json` reports price components and every direct
and nested worker for auditing.

## Scope and pricing

- **Orchestrator/main cost is unchanged**: sum Pi's own nonzero `usage.cost.total`
  records. Missing price on nonzero main usage is reported as unavailable.
- **Only non-orchestration worker inference is repriced**: every result of a
  parallel/single subagent invocation and nested worker (once per tool-call ID).
  Never substitute the worker's potentially underpriced harness `usage.cost`.
- Worker prices come from the bundled `prices.json`, imported from
  [`gaia-research/skill-cost`](https://github.com/gaia-research/skill-cost),
  sourced from [BerriAI/LiteLLM](https://github.com/BerriAI/litellm)'s MIT
  catalog. Match known provider/effort names to **exact** model keys; never
  guess a substring or silently substitute another model/region.
- Price `input`, `output`, `cacheRead`, **and** `cacheWrite` separately at catalog
  per-token rates. Missing required model or cache rates make that worker and
  the mixed-method total **unavailable**, not artificially cheap. The final
  number is a mixed-method public-rate **estimate**, not provider billing.

## Freshness, including seven idle days

Every invocation checks the catalog's embedded `_meta.fetched_at` timestamp
(**not file mtime**). At age **≥7 days**, it fetches, validates and atomically
replaces `prices.json` before calculating—even if the skill was unused for the
entire week. Refresh failure keeps the dated cache with an explicit warning;
missing/corrupt prices fail closed. `--refresh-prices` forces a refresh and fails
on network/schema errors; `--offline` never fetches. Optional environment:
`PI_COST_MAX_AGE_DAYS` (default 7), `PI_COST_NO_AUTO_REFRESH=1`.

No background refresh is claimed while the command is **never invoked**; a
scheduler would be needed for that. Cost calculation and freshness do not
change Rock data, orchestrator workflows, or model deployments.
