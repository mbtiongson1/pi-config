# Durable Subagent Recovery — Experimental Safety Work

## Status

**Not deployment-ready.** This extension is an additive observer/ledger experiment for Pi 1.4.0 and `@parke.dev/pi-subagent@0.8.0`. Do not install or rely on it for automatic recovery until the independent source review and positive actual-SDK recovery gates pass. A mock callback test or manual native resume does not meet that gate.

The live extension is not modified by these source changes. The staged native compatibility patch is never automatically applied.

## Native lifecycle ordering and transcript preservation

The native package's `session_start` maintenance may reconcile/terminalize run records before user extension `session_start` handlers execute. Therefore the observer takes a synchronous, read-only snapshot of sessions referenced by `running` native records during its factory registration, before session events. Startup reconciliation retries preservation where possible. It never changes a native record to `terminal` to bypass native lifecycle logic, because native `busy` and `liveWorktrees` sets depend on records remaining `running`.

This snapshot is best-effort and does not keep a child alive, prevent native reaping, prove completion, or guarantee a consistent snapshot of a concurrently-written transcript. It is not automatic replay. Preserve hash/mode and session-format validation in any future strengthening.

## Liveness and recovery safety

The ledger uses Node's built-in `node:sqlite`, WAL, and `synchronous = FULL`. Process death may only be concluded from verified identity evidence. The identity requires PID, `/proc/<pid>/stat` birth ticks, kernel boot ID, and matching host where available. A missing PID, missing binding, legacy row without birth metadata, unreadable `/proc`, EPERM, unknown host, or ambiguous launch is **unknown**—not dead, not successful, and not claimable. Startup leaves such data intact and reports unknown workers. Every eventual claim path must repeat the full identity check.

Only verified death can make a process-backed job eligible for explicit logical recovery. Transcript presence does not prove process death or task completion. The product's resume reservation and successor-lineage binding is **not yet complete or certified**; commands emitted by earlier revisions are not a safe exactly-once launch protocol. External side effects cannot be made exactly once by the ledger.

## Execution constraints and scope

The resume spec must preserve the original requested and effective backend, profile, model, thinking level, agent, tools, prompt, and cwd. Legacy rows that cannot prove the original constraints fail closed rather than inheriting broader defaults. The currently supported logical transcript path is Pi backend only; managed temporary worktrees and missing or symlinked cwd are unsupported. Do not silently widen to defaults.

The native Android compatibility patch is staged, version/source-hash-specific, and unapplied. It adds actual Android `/proc` birth-time capture and boot identity; it distinguishes verified alive/dead/unknown, never signals unknown/reused PIDs, and preserves unknown lock/slot data. The target stock source hash is `5cf89e4846ebc3bb59fce14af05ce0cf92be6701456ecef3e4e51746e82b2702`; see `patches/README.md` for the staged patch hash and isolated lifecycle test. It does not promise detached-worker survival.

## Storage and tooling

- `~/.pi/durable/` and `sessions/`: mode `0700`.
- SQLite DB/WAL/SHM: mode `0600` where created by the extension.
- Corrupt DB handling is fail-closed; do not automatically quarantine/reset active safety state. Preserve DB, WAL, and SHM for offline diagnosis.
- The installer and doctor must treat the deployment manifest as untrusted structured data, validate backup namespace/hash/mode, and never evaluate manifest strings as shell code.
- `bin/durable-subagent-doctor.sh --rollback` must not change `settings.json`, `auth.json`, `models.json`, package installation, or unrelated user data.

## Verification gates before deployment

1. Independent review of the exact candidate commit.
2. Actual Pi 1.4 SDK + native 0.8.0 fixture proving early transcript preservation through actual native lifecycle ordering and actual native resume; no handwritten native events or operator-copy substitution.
3. Actual native class Android fixture with an owned active process and legacy zero-start record, plus unknown/unreadable, PID-reuse, boot mismatch, signal and pruning guards.
4. Composed recovery tests for reconciliation → claim, competing processes, reservation TTL, two launch attempts, prelaunch crash ambiguity, and fail-closed foreign/stale/missing reservation rejection.
5. Installer/doctor exploit regression, preimage SHA and mode checks across first install, idempotent reruns, replacement versions, restore, and crash-safe deployment.
6. Targeted install/rollback review with an isolated target. No live install/reload/restart is authorized by this document.
