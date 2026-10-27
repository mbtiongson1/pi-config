# Staged Vendor Compatibility Patches

This directory contains version-pinned, hash-guarded vendor compatibility patches for `@parke.dev/pi-subagent`.

## Strict Phase 1 Invariant
**DO NOT APPLY TO LIVE VENDOR DIRECTORY DURING PHASE 1.**
These patches are staged in the repository for review and isolated testing only. Live installation is deferred until Phase 2 parent authorization and independent review.

---

## `@parke.dev-pi-subagent-v0.8.0-durable-lifecycle.patch`

### Purpose
Allows live detached subagents to survive parent restarts when opt-in `PI_SUBAGENT_DETACHED_MODE=1` is active, without mutating vendor lock records or stripping native `busy` and `liveWorktrees` protections.

### Guard Criteria
- **Target Package**: `@parke.dev/pi-subagent`
- **Target Version**: `0.8.0`
- **Target File**: `src/process-lock.ts`
- **Expected Original SHA256**: `5cf89e4846ebc3bb59fce14af05ce0cf92be6701456ecef3e4e51746e82b2702`
- **Expected Patched SHA256**: `40a0d39335d6be0eadd1cedcd9b65818444063429a9ba9061d644ea516fe9d86`

### Reversibility
Verified 100% cleanly reversible via `patch -R -p1`.
