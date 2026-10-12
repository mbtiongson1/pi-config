---
description: Implement a change with proportional scouting, planning, and verification
---
Implement: $@

Size the task from current repository state, then use the smallest sufficient path:

- **Tiny/localized** (one file or obvious fix): inspect, edit, and verify directly. No subagents.
- **Moderate**: if context is unclear, run one scoped `scout` subagent; then implement and verify in the parent, or hand one `worker` a precise brief.
- **Substantial/high-risk** (cross-cutting, security, data, deployment): run complementary read-only scout tasks in parallel (`tasks` on the default `explore` profile, with `synthesis`), use a `planner-*` agent if the design is non-obvious, keep one responsible lead implementing, and add an independent `reviewer` pass before reporting.

Use Codemode to batch independent tool calls. Children do not see this conversation unless `context:'fork'` is used, so brief them explicitly.

Finish only after targeted verification. Report files changed, verification evidence, and anything left unfinished.
