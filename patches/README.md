# Optional Staged Native Compatibility Patch

This directory contains a narrow, version- and SHA-guarded compatibility patch for `@parke.dev/pi-subagent@0.8.0`.

## Status: STAGED FOR REVIEW ONLY (NOT APPLIED LIVE)

Under the non-mutating observer design, the durable recovery extension operates without modifying vendor packages. This patch is staged for isolated testing and future upstream review only; **no installer applies it automatically and live vendor code remains 100% stock**.

## Purpose: Android `/proc` Capture & PID-Reuse Safety

In native `@parke.dev/pi-subagent@0.8.0`, `processStartTime(pid)` checked only `process.platform === "linux"`. In Android / Termux environments, Node.js reports `process.platform === "android"`.
Consequently:
1. Native lock records recorded `process.startTime: 0`, leaving PID-reuse protection disabled.
2. In `isProcessAlive` and `killProcessTree`, records with missing or zero birth `startTime` risked treating recycled PIDs as live and sending `SIGTERM`/`SIGKILL` to foreign processes during orphan reconciliation.

## Guards & Invariants
- **Target Package**: `@parke.dev/pi-subagent` version `0.8.0`
- **Target File**: `src/process-lock.ts`
- **Stock File SHA-256**: `5cf89e4846ebc3bb59fce14af05ce0cf92be6701456ecef3e4e51746e82b2702`
- **Patched File SHA-256**: `450398c72432ee2945a811ff981985d043fb85664d339d73c82d33d388a304c1`

The patch:
1. Enables `/proc/<pid>/stat` field 22 clock-tick inspection on `process.platform === "android"` as well as `"linux"`.
2. Treats records with zero/missing birth start time (`startTime <= 0`) as unverifiable when `/proc` is active on the host, preventing false liveness and foreign PID signals.
3. Guards `killProcessTree` so it never signals unverified PIDs without birth start-time proof.
