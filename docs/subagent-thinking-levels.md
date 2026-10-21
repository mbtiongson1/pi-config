# Pi Subagent & Thinking Levels — Architecture, Reliability, & Visibility Guide

In Pi, agents dispatch isolated child work via the `@parke.dev/pi-subagent` package combined with the `subagent-monitor` extension. This guide documents how agent models, thinking levels, execution budgets, stall detection, active visibility, and recovery work.

---

## Architecture Overview

```
Parent Pi Agent
  │
  ├─► ~/.pi/subagent.json               (Reliability & timeout defaults)
  ├─► ~/.pi/agent/agents/<agent>.md    (Agent persona, model, thinking, profile)
  ├─► npm:@parke.dev/pi-subagent       (Child process orchestrator & isolation)
  └─► extensions/subagent-monitor.ts   (Active statusline visibility & codemode guard)
```

1. **Agent Definitions** (`~/.pi/agent/agents/*.md`) declare the agent's name, role, tools, model, and thinking level.
2. **Global Policy** (`~/.pi/subagent.json`) defines process concurrency limits, execution timeouts, stall detection, and budget grace turns.
3. **Execution Runtime** (`@parke.dev/pi-subagent`) spawns isolated `pi` CLI processes with `--mode json`, pipes events, and isolates worktrees when requested.
4. **Visibility & TUI** (`extensions/subagent-monitor.ts`) hooks Pi tool execution events to surface running agents directly on the statusline with actual resolved models, effort levels, elapsed time, and terminal receipts.

---

## Timeout & Stall Policy Defaults

Configuration lives outside `node_modules` in `~/.pi/subagent.json`, surviving package updates:

```json
{
  "defaultTimeoutMs": 1800000,
  "stallAfterMs": 300000,
  "stallKillAfterMs": 0,
  "maxActiveProcesses": 4,
  "maxGlobalActive": 16,
  "maxQueuedTasks": 32,
  "graceTurns": 2
}
```

| Setting | Default Value | Purpose |
|---|---|---|
| `defaultTimeoutMs` | `1800000` (30m) | Total execution budget ceiling per task. Prevents unbounded unattended runs while giving heavy subagents ample time. |
| `stallAfterMs` | `300000` (5m) | Non-destructive stall probe. If child process emits no events for 5 minutes, it is marked `stalled` and sent a liveness probe (`get_state`). |
| `stallKillAfterMs` | `0` (Disabled) | Automatic stall termination window. Set to `0` to prevent premature process termination during long shell commands or slow model reasoning. |
| `maxActiveProcesses`| `4` | Maximum concurrent child processes running in parallel in this session. |
| `maxGlobalActive` | `16` | Machine-wide concurrent process limit across all Pi sessions. |
| `maxQueuedTasks` | `32` | Maximum tasks queued before backpressure rejection. |
| `graceTurns` | `2` | Number of wrap-up turns allowed after hitting a turn or cost budget to produce a final answer before termination. |

---

## Active-Agent Visibility

Subagents are visible directly in the Pi statusline without requiring repeated `/subagents` commands:

### Compact Status Format
```
worker-flash-high · Gemini 3.8 Flash · high · running · 2m14s
```

When multiple tasks run concurrently:
```
worker-flash-high · Gemini 3.8 Flash · high · running · 2m14s (+1 more)
```

### State Distinctions
- **`queued`**: Waiting for concurrency slot.
- **`running`**: Actively executing and producing events.
- **`stalled`**: Silent for >5 minutes without emitting output (statusline highlights in warning color).
- **`completed`**: Finished successfully.
- **`failed`**: Exited with fatal error or non-zero code.
- **`interrupted`**: Cancelled by operator or parent agent.
- **`timed_out`**: Exceeded task execution budget.
- **`partial`**: Reached turn/cost ceiling and concluded gracefully within grace turns.

### Lifecycle Behavior
- The duration ticks every second while tasks are active.
- When all tasks finish, a terminal receipt (e.g. `completed · 2m14s` or `failed · 45s`) remains visible for 5 seconds.
- After 5 seconds, the statusline entry clears completely. No background timers or permanent clutter remain.
- `/subagents` remains available for deep inspection (inspecting worktrees, live output, steering, diffs).

---

## Agent Configuration & Thinking Levels

Agent definitions live in `~/.pi/agent/agents/<name>.md`. Frontmatter controls the model, effort, and tool profile:

```markdown
---
name: worker-flash-high
description: High-effort 3.8 flash subagent, isolated context
model: antigravity/gemini-3.8-flash:high
role: worker
profile: general
tools: read, edit, write, bash
---
```

### Model & Thinking Level Resolution
1. **Explicit Call Arguments**: Passing `model` or `thinking` in the `subagent({...})` tool call always takes highest precedence.
2. **Combined Shorthand**: Frontmatter can specify `model: provider/model-id:thinkingLevel` (e.g., `antigravity/gemini-3.8-flash:high`).
3. **Explicit Frontmatter**: `model:` and `thinking:` fields in the frontmatter.
4. **Parent Fallback**: If unspecified, inherits the parent session's active model and thinking level.

Valid thinking levels: `off` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max`.

### The Bunny family — a stable identity with a routed provider

The Bunny agents pin the stable identity `bunny/minimax-m3.1-flash`, which is
a Pi **virtual model** registered by `extensions/bunny-router.ts`. The physical
provider behind it is resolved per request, so the published OpenRouter-free →
Vercel AI Gateway transition never requires renaming or editing an agent file.

```markdown
---
name: worker-bunny-high
description: Bunny worker (MiniMax M3.1 Flash) at high effort
role: worker
model: bunny/minimax-m3.1-flash:high
thinking: high
---
```

Rules for this family:

- Every invocation pins an explicit level. `off` and `minimal` are not part of
  the family: the OpenRouter free route maps both to `null`, and MiniMax
  requires a reasoning budget.
- An unsupported level fails with an explicit diagnostic; it is never
  silently downgraded.
- No Bunny agent sets `max_turns` or `max_cost`.
- Continuation and retry requests stay on the provider that already served the
  turn, so a route change never interrupts an in-flight job.
- The route fails closed when a credential, the model, or the credit
  authorization is missing. There is no automatic paid fallback.

Full guide: [`docs/bunny-routing.md`](bunny-routing.md).

---

## Partial Completion & Recovery Receipts

When subagents conclude, wrap up under a budget limit, or are interrupted, they must provide structured receipts rather than generic success or failure claims.

All worker agents follow this standard receipt structure:

```markdown
Output format when finished or wrapping up:

## Status
[completed | partial | blocked]

## Completed
What was done.

## Files Changed
- `path/to/file.ext` - what changed

## Pending Work (if partial/blocked)
What remains to be done.

## Verification
What checks/tests were run and results.

## Resume Instructions (if partial/blocked)
Next steps or commands to continue.
```

### Outcome Handling
- **`completed`**: All tasks executed, verified, and finalized.
- **`partial`**: Task hit a budget limit (`max_turns` or `max_cost`) and concluded during `graceTurns`. Partial work is preserved, and resume session ID is available.
- **`interrupted` / `cancelled`**: Preserves worktree branch for manual inspection (`subagent { action: 'diff' }` or `apply`).
- **`timed_out`**: Budget elapsed. Phase reported (e.g., `execution` vs `queue`).

---

## Codemode Reliability

Codemode runs scripts in a QuickJS sandbox without an execution timeout by default.
- The `subagent-monitor` extension automatically eliminates the cargo-culted `60000ms` timeout header copied by LLMs from older documentation examples.
- Scripts run without artificial timeouts unless the user explicitly requests an execution deadline.
- QuickJS memory safety (256 MB) and output limits remain fully enforced.

---

## Upgrade, Verification, and Rollback Procedures

All reliability preferences are isolated from installed `node_modules`.

### Verification
Run the verification script:
```bash
bash ~/pi-config/bin/ensure-subagent-config.sh
```
This ensures:
1. `~/.pi/subagent.json` matches the 30-minute budget, 5-minute stall probe, and disabled stall kill.
2. `~/.pi/agent/statusline.json` allows `subagent` and `subagent-monitor`.
3. `extensions/subagent-monitor.ts` and `extensions/statusline.ts` are active.
4. Reports the installed version of `@parke.dev/pi-subagent` (last verified: `0.8.0`).

### Upgrading Subagent
When upgrading `@parke.dev/pi-subagent`:
1. Update via Pi or npm.
2. Run `bash ~/pi-config/bin/ensure-subagent-config.sh` to confirm configuration compatibility.
3. Reload Pi with `/reload`.
All settings (`~/.pi/subagent.json`) and extensions (`extensions/subagent-monitor.ts`) persist automatically without patching `node_modules`.

### Rollback
If an upstream update introduces breaking changes:
```bash
npm install -C ~/.pi/agent/npm @parke.dev/pi-subagent@0.8.0
bash ~/pi-config/bin/ensure-subagent-config.sh
```
Then reload Pi.
