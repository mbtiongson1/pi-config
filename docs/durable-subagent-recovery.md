# Durable Subagent Recovery Architecture

## Overview
Durable Subagent Recovery is an additive, crash-resilient job ledger and session preservation subsystem for `@parke.dev/pi-subagent` in Pi 1.4.0+.

It uses Node.js 24's native `node:sqlite` module (zero npm native dependencies) in Write-Ahead Logging (`WAL`) mode with `synchronous = FULL` to guarantee durability against hard OS terminations (Android Low Memory Killer, Termux kill -9, power loss).

---

## The Core Design Gaps & Solutions

### 1. Vendor Orphan Lifecycle & Distillation Protection
- **The Problem**: `@parke.dev/pi-subagent`'s `scheduleMaintenance` runs `reconcileOrphans` on session startup. Active disconnected processes are reaped on parent restart, and `sweepSessionsLifecycle` converts non-busy sessions to `.digest.json`, deleting `.jsonl` transcripts. Mutating native locks to `terminal` strips child sessions and worktrees from `busy` and `liveWorktrees` sets, accelerating distillation.
- **The Solution (Non-Mutating Observer)**:
  1. **Non-Mutating Observer**: On startup, our extension scans vendor locks without modifying vendor files or claiming live process survival across restarts.
  2. **Session Preservation (`preserveSessionFile`)**: Active child `.jsonl` files are immediately preserved in `~/.pi/durable/sessions/<id>.jsonl` with `0600` permissions before native maintenance runs. Even after native distillation purges the vendor transcripts, the preserved transcript is intact and ready for logical resumption.

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
- **Corrupt DB Fail-Closed Integrity**: If SQLite integrity check (`PRAGMA quick_check`) fails, ordinary initialization strictly fails closed with `DatabaseCorruptError`, leaving existing DB, WAL, and SHM files completely untouched to prevent silent state or lease loss. Automated destructive resets are prohibited; an explicit offline manual diagnostic procedure is provided.

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

## Honest Scope & Support Matrix

1. **Permanent vs Temporary Worktrees**:
   - Subagents launched with `isolation: "worktree"` operate in ephemeral checkouts under `.pi/subagent-worktrees/` that native subagent reaps on parent restart.
   - Durable recovery supports permanent isolated or shared worktrees (e.g., permanent git worktrees or repo directories). Managed temporary worktrees cannot guarantee uncommitted WIP survival across restarts and are marked unresumable at admission.
2. **Backend Matrix**:
   - Resumption via preserved JSONL session transcripts is supported exclusively for the `pi` backend (`pi --session <path>`).
   - Non-Pi backends (`claude`, `codex`) use different, non-interchangeable session models and are explicitly rejected for session transcript resumption.
3. **Execution Constraints**:
   - All requested and effective execution constraints (`profile`, `tools`, `backend: "pi"`, `model`, `thinking`, `agent`, `cwd`) are persisted at admission and pinned on generated resume specs, preventing profile escalation (such as `explore -> general`) or routing loss.
