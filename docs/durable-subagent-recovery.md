# Durable Subagent Recovery — Experimental Safety Work

## Status

**Not deployment-ready.** This extension is an additive observer/ledger experiment for Pi 1.4.0 and `@parke.dev/pi-subagent@0.8.0`. Do not install or rely on it for automatic recovery until the independent source review and positive actual-SDK recovery gates pass. A mock callback test or manual native resume does not meet that gate.

The live extension is not modified by these source changes. The staged native compatibility patch is never automatically applied.

## Native lifecycle ordering and transcript preservation

The native package's `session_start` maintenance may reconcile/terminalize run records before user extension `session_start` handlers execute. Therefore the observer takes a synchronous, read-only snapshot of sessions referenced by `running` native records during its factory registration, before session events. Startup reconciliation retries preservation where possible. It never changes a native record to `terminal` to bypass native lifecycle logic, because native `busy` and `liveWorktrees` sets depend on records remaining `running`.

This snapshot is best-effort and does not keep a child alive, prevent native reaping, prove completion, or guarantee a consistent snapshot of a concurrently-written transcript. It is not automatic replay. Preserve hash/mode and session-format validation in any future strengthening.

## Liveness and recovery safety

The ledger uses Node's built-in `node:sqlite`, WAL, and `synchronous = FULL`. Process death may only be concluded from verified identity evidence. The identity requires PID, `/proc/<pid>/stat` birth ticks, kernel boot ID, and matching host where available. A missing PID, missing binding, legacy row without birth metadata, unreadable `/proc`, EPERM, unknown host, or ambiguous launch is **unknown**—not dead, not successful, and not claimable. Startup leaves such data intact and reports unknown workers. Every eventual claim path must repeat the full identity check.

Only verified death can make a process-backed job eligible for explicit logical recovery. Transcript presence does not prove process death or task completion. The current source implements an owner-bound, unique reservation artifact, exact-path lookup, and an awaited `tool_call` admission gate. It atomically consumes that reservation while admitting/linking one successor; expired, duplicate, foreign, or mismatched attempts are blocked. A committed pending successor remains ambiguous after parent death and is not automatically retried. This protocol is **not independently reviewed or actual-SDK certified**. It guarantees at most one ledger admission per reservation, not exactly-once external side effects.

## Execution constraints and scope

The resume spec must preserve the original requested and effective backend, profile, model, thinking level, agent, tools, prompt, and cwd. Legacy rows that cannot prove the original constraints fail closed rather than inheriting broader defaults. The currently supported logical transcript path is Pi backend only; managed temporary worktrees and missing or symlinked cwd are unsupported. Do not silently widen to defaults.

The native Android compatibility patch is staged, version/source-hash-specific, and unapplied. It adds actual Android `/proc` birth-time capture and boot identity; it distinguishes verified alive/dead/unknown, never signals unknown/reused PIDs, and preserves unknown lock/slot data. The target stock source hash is `5cf89e4846ebc3bb59fce14af05ce0cf92be6701456ecef3e4e51746e82b2702`; see `patches/README.md` for the staged patch hash and isolated lifecycle test. It does not promise detached-worker survival.

## Storage and tooling

- `~/.pi/durable/` and `sessions/`: mode `0700`.
- SQLite DB/WAL/SHM: mode `0600` where created by the extension.
- Corrupt DB handling is fail-closed; do not automatically quarantine/reset active safety state. Preserve DB, WAL, and SHM for offline diagnosis.
- The installer and doctor must treat the deployment manifest as untrusted structured data, validate backup namespace/hash/mode, and never evaluate manifest strings as shell code.
- `bin/durable-subagent-doctor.sh --rollback` must not change `settings.json`, `auth.json`, `models.json`, package installation, or unrelated user data.
- Extension deployment now uses `bin/durable-recovery-deploy.py`: strict schema2 metadata, owned regular single-link files, an OS-held deployment lock, compare-safe staged writes, and a fsynced intent before replacing/removing the extension. A pending intent is completed only when both extension and manifest match its recorded before/after fingerprints; unexpected edits stop recovery without guessing.
- Rollback restores the **first managed installation preimage**, including original absence and mode, across same-version reruns and managed version replacements. It is not an N-minus-one release selector. No force override is accepted. Old experimental schema1 manifests lack the new complete proof and fail closed instead of being silently adopted.
- Update/Reinstall/Sync must exclude this extension from ordinary bulk copy or deletion and call its installer first. Otherwise those operations would destroy the preimage before the journal can protect it.
- This intent protects logical recovery after a deployment process dies; fsync calls are not a claim that every filesystem/device power-loss behavior has been tested. Native-package patch deployment remains a separate held review/rollback gate.

## Verification gates before deployment

1. Independent review of the exact candidate commit.
2. Actual Pi 1.4 SDK + native 0.8.0 fixture proving early transcript preservation through actual native lifecycle ordering and actual native resume; no handwritten native events or operator-copy substitution.
3. Actual native class Android fixture with an owned active process and legacy zero-start record, plus unknown/unreadable, PID-reuse, boot mismatch, signal and pruning guards.
4. Composed recovery tests for reconciliation → claim, actual competing processes, reservation TTL, two launch attempts, prelaunch crash ambiguity, and fail-closed foreign/stale/missing reservation rejection. The current unit fixture covers transactional claims and two attempts in-process; multiprocess contention and actual SDK hook ordering remain required.
5. Installer/doctor exploit regression, preimage SHA and mode checks across first install, idempotent reruns, replacement versions, restore, and crash-safe deployment.
6. Targeted install/rollback review with an isolated target. No live install/reload/restart is authorized by this document.
