# Optional Staged Native Compatibility Patch

This directory contains a narrow, version- and SHA-guarded compatibility patch for `@parke.dev/pi-subagent@0.8.0`.

## Status: STAGED FOR REVIEW ONLY (NOT APPLIED LIVE)

Under the non-mutating observer design, the durable recovery extension operates without modifying vendor packages. This patch is staged for isolated testing and future upstream review only; **no installer applies it automatically and live vendor code remains 100% stock**.

## Purpose: Android `/proc` Capture & PID-Reuse Safety

Native `@parke.dev/pi-subagent@0.8.0` checked only `process.platform === "linux"` in `processStartTime(pid)`. Android / Termux reports `process.platform === "android"`; stock records therefore had `startTime: 0`. The staged patch adds Android `/proc` capture and boot identity, and changes the safety contract to three outcomes: verified alive, verified dead, or unknown. Legacy zero-start records, missing boot IDs, unreadable `/proc`, EPERM, foreign-host records, and malformed lock ownership remain unknown and are not killed, terminalized, or pruned. PID reuse and reboot are only treated as verified death when birth ticks/boot identity establish a mismatch.

## Guards & Invariants
- **Target Package**: `@parke.dev/pi-subagent` version `0.8.0`
- **Target files**: `src/process-lock.ts`, `src/runner.ts`, `src/extension.ts`, `src/types.ts`.
- Exact before/after SHA-256 values and the patch digest are in `native-0.8.0-source-hashes.json`. Check **every** original file before applying to an isolated copy and every resulting file afterward. Package version alone is insufficient.
- `runner.ts` captures the child boot identity while it owns the spawned child; `extension.ts` retains it when updating the native run record. A helper that captures only the parent identity is insufficient.

The patch is staged only; it has not been applied to the live installation. It:
1. Enables Android `/proc/<pid>/stat` field 22 capture and records kernel `boot_id` at identity creation.
2. Uses a native tri-state liveness helper. Unknown is conservatively busy for native sessions/worktrees and prevents PID signals, lock release, slot pruning, and orphan terminalization.
3. Guards `killProcessTree` against unverified identities and preserves malformed/legacy lock data for diagnostics.
4. Does not promise detached-worker survival. The isolated component matrix passed 10/10 cases for the repaired source, including real Android birth/boot capture, lease-expired unknown ownership, failed signals, EPERM, missing process metadata and read failures. Corrected fault injection confirms the read failures were actually observed.
5. `node --test tests/test_native_process_safety.mjs` applies the exact patch only to a private copy and checks source digests. It skips explicitly when the real supported Android installation is unavailable. It uses its own checked synthetic child, not real workers; a successful component test is **not** actual SDK producer/maintenance/GC or deployment acceptance. Broader malformed-record cases and full SDK writer proof remain review requirements.
