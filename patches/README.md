# Optional Staged Native Compatibility Patch

This directory contains a narrow, version- and SHA-guarded compatibility patch for `@parke.dev/pi-subagent@0.8.0`.

## Status: STAGED FOR REVIEW ONLY (NOT APPLIED LIVE)

Under the non-mutating observer design, the durable recovery extension operates without modifying vendor packages. This patch is staged for isolated testing and future upstream review only; **no installer applies it automatically and live vendor code remains 100% stock**.

## Purpose: Android `/proc` Capture & PID-Reuse Safety

Native `@parke.dev/pi-subagent@0.8.0` checked only `process.platform === "linux"` in `processStartTime(pid)`. Android / Termux reports `process.platform === "android"`; stock records therefore had `startTime: 0`. The staged patch adds Android `/proc` capture and boot identity, and changes the safety contract to three outcomes: verified alive, verified dead, or unknown. Legacy zero-start records, missing boot IDs, unreadable `/proc`, EPERM, foreign-host records, and malformed lock ownership remain unknown and are not killed, terminalized, or pruned. PID reuse and reboot are only treated as verified death when birth ticks/boot identity establish a mismatch.

## Guards & Invariants
- **Target Package**: `@parke.dev/pi-subagent` version `0.8.0`
- **Target File**: `src/process-lock.ts`
- **Stock File SHA-256**: `5cf89e4846ebc3bb59fce14af05ce0cf92be6701456ecef3e4e51746e82b2702`
- **Patched File SHA-256**: `0125694e4a15b1dac551e8442a536ad32290f42e6ec3c52f31cb48bc31d91c6b`

The patch is staged only; it has not been applied to the live installation. It:
1. Enables Android `/proc/<pid>/stat` field 22 capture and records kernel `boot_id` at identity creation.
2. Uses a native tri-state liveness helper. Unknown is conservatively busy for native sessions/worktrees and prevents PID signals, lock release, slot pruning, and orphan terminalization.
3. Guards `killProcessTree` against unverified identities and preserves malformed/legacy lock data for diagnostics.
4. Does not promise detached-worker survival; it provides fail-closed native lifecycle behavior pending isolated lifecycle tests.
