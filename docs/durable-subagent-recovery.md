# Durable Subagent Recovery Architecture

## Overview
Durable Subagent Recovery is an additive, crash-resilient job ledger and session preservation subsystem for `@parke.dev/pi-subagent` in Pi 1.4.0+.

It uses Node.js 24's native `node:sqlite` module (zero npm native dependencies) in Write-Ahead Logging (`WAL`) mode with `synchronous = FULL` to guarantee durability against hard OS terminations (Android Low Memory Killer, Termux kill -9, power loss).

---

## The Core Design Gaps & Solutions

### 1. Vendor Orphan Killing & Distillation Protection
- **The Problem**: `@parke.dev/pi-subagent`'s `scheduleMaintenance` runs `reconcileOrphans` on session startup. If a subagent process was still alive across parent restarts, native subagent assumed it was an orphan and issued `SIGTERM` followed by `SIGKILL`. Furthermore, `sweepSessionsLifecycle` pruned unreferenced session files older than 1 hour into `.digest.json`, deleting the `.jsonl` transcript.
- **The Solution**:
  1. **Lock Record Shielding (`protectVendorOrphanRecords`)**: On startup, our extension checks active processes in `~/.pi/subagent-locks/runs/`. If a worker is verifiably alive via Linux kernel ticks, its vendor lock record is marked `terminalState: "detached-protected"`. Native `reconcileOrphans` skips it completely and **never** sends SIGTERM or SIGKILL.
  2. **Session Preservation (`preserveSessionFile`)**: Active child `.jsonl` files are immediately preserved in `~/.pi/durable/sessions/<id>.jsonl` with `0600` permissions. Even if the vendor directory distills or purges transcripts, the durable transcript is intact and ready for resumption.

### 2. Async Launch Receipt vs. Worker Completion
- **The Problem**: For `async: true` subagent runs, the initial `tool_execution_end` represents only the launch receipt (`"Started run <id>"`), not actual subagent completion. Marking a job complete on initial tool return corrupts status tracking.
- **The Solution**: Async tasks remain in `state: 'running'` after the launch receipt. Completion is only recorded when native completion messages arrive (`customType: 'subagent_completion'`), when `action: 'wait'` concludes, or when process termination is verified.

### 3. Absolute Path Resumption Across CWDs
- **The Problem**: Resuming by raw UUID fails when Pi's current working directory differs from the subagent's worktree CWD, because Pi's `findLocalSessionByExactId` checks `sessionCwdMatches`. Cross-directory matching may also trigger interactive fork prompts.
- **The Solution**: The recovery subsystem resolves and indexes the exact **absolute file path** to the session `.jsonl`. Resuming with `subagent({ resume: "<absolute_path_to_jsonl>", cwd: "<worktree_cwd>" })` bypasses CWD mismatch checks and opens the exact session directly.

### 4. Process Identity & PID Reuse Safety
- **Linux Kernel Verification**: Process identity is verified using three factors:
  1. `pid`: Process ID.
  2. `startTimeTicks`: Field 22 from `/proc/<pid>/stat` (ticks since boot).
  3. `bootId`: System boot UUID from `/proc/sys/kernel/random/boot_id`.
- **Invariants**:
  - If `bootId` changed: System rebooted; process is verifiably dead.
  - If `startTimeTicks` differs: PID has been recycled by another process. The old job is dead; foreign processes are **never** killed.
  - If permission denied (`EACCES`/`EPERM`): Status is treated as `unverifiable` and **never** marked dead or killed.

### 5. Concurrent Recovery Deduping (Atomic CAS Lease)
- A job cannot be resumed twice concurrently.
- `claimResumeLease` uses atomic SQLite `BEGIN IMMEDIATE` transactions to acquire an exclusive recovery lease.
- If a job is currently alive and active, resume requests are refused with `process_still_running`.

---

## File System & Security Layout

- `~/.pi/durable/` — Permissions `0700`
- `~/.pi/durable/sessions/` — Permissions `0700`
- `~/.pi/durable/subagents.sqlite` — Permissions `0600` (WAL and SHM files also `0600`)
- **Corrupt DB Fail-safe**: If SQLite integrity check fails or the file is corrupted, the engine renames it to `subagents.sqlite.corrupt.<timestamp>` and initializes a clean DB without crashing Pi startup.

---

## Tooling & Commands

- **Slash Command**: `/subagent-recover`
  - Lists recoverable, active, and interrupted jobs with absolute paths and exact resumption commands.
- **Model Tool**: `subagent_recover`
  - Allows the LLM or automation scripts to `list`, inspect `status`, or `claim` recovery leases.
- **CLI Doctor**: `bin/durable-subagent-doctor.sh`
  - Inspects environment, permissions, database integrity, and reports job counts.
  - Supports `--json` for automation and `--rollback` for safe deactivation.

---

## Important Operational Boundaries

1. **`surviveReload: true` vs. Durable Subagents**:
   - Pi's `bg_run` supports `surviveReload: true` for ordinary shell commands (`isAgent: false`) across same-process reload ONLY.
   - It explicitly does **not** cover agent processes or OS-level crashes / Termux restarts.
   - Durable Subagent Recovery handles LLM agent subagents across hard OS crashes, LMK events, and process restarts.
2. **Reset / Restart Timing**:
   - Never reset or reload while background tasks are active.
   - A reset or restart must be authorized only when all critical tasks finish or checkpoint safely.
