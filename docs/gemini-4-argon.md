# Gemini 4 Argon Stream Stall Guard

Durable, upgrade-safe protection and diagnostics for Gemini 4 Argon (`gemini-4-argon`) stream stalls in Pi on Termux.

## Root Cause Analysis

- **Symptom**: During extended reasoning sessions on Gemini 4 Argon (Low, Medium, or High thinking), Pi aborts with:
  ```
  Error: stream stalled: no data for 120000ms
  ```
- **Source**: `~/.pi/agent/npm/node_modules/pi-antigravity/src/stream/stream.ts` (line 1134):
  ```ts
  return new Error(`stream stalled: no data for ${stallMs}ms`);
  ```
- **Mechanism**:
  - `STREAM_STALL_TIMEOUT_DEFAULT_MS` defaults to `120_000` ms (120 seconds).
  - During complex reasoning chains, Argon pauses SSE chunk emission while evaluating intermediate thoughts. When silence exceeds 120 seconds, the client-side stall watchdog triggers and terminates the stream.
  - The watchdog reads `ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS` (or legacy `NOAGY_STREAM_STALL_TIMEOUT_MS`). When unset, it falls back to 120,000ms.
  - Header timeout is governed separately by `STREAM_HEADER_TIMEOUT_DEFAULT_MS` (`180_000` ms = 180s) or `ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS`.

## Solution Architecture

Rather than monkey-patching installed dependencies in `node_modules` (which get erased during package updates or reinstalls), this fix combines official configuration options with a minimal, version-guarded extension adapter:

1. **Official Upstream Configuration**:
   - `ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS=300000` (300 seconds = 5 minutes): Extends the mid-stream stall watchdog for Argon reasoning.
   - `ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS=180000` (180 seconds = 3 minutes): Maintains an independent, finite request deadline for initial HTTP connection and response header arrival. Truly broken connections terminate promptly.

2. **Version-Guarded Extension Adapter (`extensions/argon-stall-guard.ts`)**:
   - Deployed to `~/.pi/agent/extensions/argon-stall-guard.ts`.
   - Loaded at session startup, dynamically ensuring the 300s stall watchdog is active whenever `gemini-4-argon` is invoked (in main sessions and subagents).
   - Works across environments even if login shell profiles were bypassed.

3. **Structured, Credential-Redacted Diagnostics**:
   - Automatically classifies stream failures into 4 distinct categories:
     - `provider_silence`: Headers arrived (HTTP 200), connection healthy, but upstream server paused SSE chunk emission exceeding stall watchdog.
     - `network_disconnection`: TCP socket reset, ECONNRESET, EPIPE, ETIMEDOUT, socket hang up, fetch failed.
     - `process_termination`: SIGKILL (137 / OOM), SIGTERM (143), SIGINT (130), abnormal child process exit.
     - `timeout`: Response headers took longer than header deadline, or connect timeout.
   - Redacts all secrets (OAuth access tokens `ya29...`, refresh tokens `1//...`, Bearer tokens, GitHub tokens `ghp_...`, API keys `sk-...`).
   - Maintains an in-memory diagnostic buffer accessible via `/argonguard diag`.

4. **Safe Recovery Guard (Idempotency & Safety)**:
   - Evaluates failed assistant turns before settlement (`agent_before_settle`):
     - **Unsafe condition**: If the failed message contains any `toolCall` block, or if any tool execution occurred during the turn, **automatic retry is strictly blocked** to prevent duplicate side effects or non-idempotent writes (`write`, `edit`, `bash`). Fails closed.
     - **Safe condition**: If failure occurred during pure reasoning prior to any tool dispatch (0 tool calls), allows 1 bounded continuation turn.
     - **Invariant check**: Model and thinking effort are strictly preserved (never escalated or altered).

5. **Subagents and Termux Compatibility**:
   - Subagent turn limits (`max_turns`) remain unbounded/governed by task specs, not streaming timeouts.
   - Environment variables are exported in `bin/pi` and `bin/ensure-antigravity-argon.sh` to ensure child processes and Termux aarch64 environments inherit the configuration.

## Commands

- `/argonguard` — Show watchdog timeouts, safe recovery policy, and diagnostics count.
- `/argonguard diag` — View recent structured, credential-redacted stream diagnostics.
- `/argonguard on` / `/argonguard off` — Arm or disarm the stall guard adapter.

## Setup & Verification

Run the reliability verification script:
```bash
bash bin/ensure-subagent-config.sh
```

Run automated regression tests:
```bash
python3 -m unittest tests/test_argon_stall_guard.py
```

## Rollback Instructions

If you need to revert to default 120s timeouts:

1. **Remove environment variable overrides**:
   In `~/.bashrc` and `~/.zshrc`, remove:
   ```bash
   export ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS=300000
   export ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS=180000
   ```
2. **Remove the extension**:
   ```bash
   rm -f ~/.pi/agent/extensions/argon-stall-guard.ts
   ```
3. **Restart Pi session**:
   Unset variables in the current shell:
   ```bash
   unset ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS
   unset ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS
   ```
