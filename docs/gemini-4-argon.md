# Gemini 4 Argon in Pi (Antigravity)

This guide documents both the model setup and the stream-stall reliability layer for Gemini 4 Argon (`gemini-4-argon`) in Pi. The checked-in templates already enable the Antigravity provider package, expose the Argon model, and set its model metadata; authentication remains local to each machine and must never be copied between environments.

## Model Setup

1. Install/use Pi's Antigravity provider package (`npm:pi-antigravity`) and authenticate in that environment using the provider's supported login flow. Do not copy `auth.json`, account files, access tokens, or refresh tokens from another machine.
2. Ensure `settings.json` has `"antigravity/gemini-4-argon"` in `enabledModels` and includes `npm:pi-antigravity` in `packages`. The repository's `settings.json.template` already includes both.
3. Ensure `models.json` has the Argon override under `providers.antigravity.modelOverrides` (and `providers.google-antigravity.modelOverrides` if the provider is exposed under that alias): `contextWindow: 1048576`, `maxTokens: 65536`, and the checked-in cost metadata. `models.json.template` supplies these values; preserve unrelated local model settings.
4. Refresh provider models/restart Pi after configuration changes, then select `antigravity/gemini-4-argon` and choose Low, Medium, or High thinking. The config alone does not authenticate the account or guarantee that the provider currently offers access to Argon.

If the provider package does not expose Argon, apply the repository's model compatibility repair on Linux/Termux from the pi-config clone:

```bash
bash bin/ensure-antigravity-argon.sh
```

The script is an idempotent compatibility repair for provider package versions that lack the model mapping. It may edit `~/.bashrc`/`~/.zshrc` and source files under `~/.pi/agent/npm/node_modules`; review those effects before running it in a different OS/provider package version. It currently sets a Linux/amd64-style User-Agent, so do not assume that specific override is appropriate on macOS or another platform. It does not configure credentials or enable the stall guard. Restart Pi after running it. The guard is intentionally opt-in: run `/argonguard on` to apply the 300-second stream-stall and 180-second header timeout overrides; `/argonguard off` disarms it.

## Check an Existing Setup

- Confirm `settings.json` contains the provider package and Argon in `enabledModels` (without printing or sharing the file wholesale; it may contain unrelated secrets).
- Check `models.json` for the Argon model override and metadata.
- Check the local provider package/model catalog includes `gemini-4-argon`, and verify the `/argonguard` extension command is available.
- Run a short Argon request at low effort before attempting a long reasoning task. If provider auth fails, reauthenticate locally; do not treat a model catalog entry as proof of valid credentials or service access.

## Stream Stall Guard

Durable, upgrade-safe protection and diagnostics for Gemini 4 Argon stream stalls in Pi on Termux.

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

Rather than permanently changing the stream implementation in `node_modules`, the setup combines upstream-supported timeout environment variables with a minimal, version-guarded extension adapter. The adapter applies the overrides only after an explicit `/argonguard on`:

1. **Opt-In Upstream Configuration**:
   - `ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS=300000` (300 seconds = 5 minutes): Extends the mid-stream stall watchdog for Argon reasoning.
   - `ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS=180000` (180 seconds = 3 minutes): Maintains an independent, finite request deadline for initial HTTP connection and response header arrival. Truly broken connections terminate promptly.

2. **Version-Guarded, Opt-In Extension Adapter (`extensions/argon-stall-guard.ts`)**:
   - Deployed to `~/.pi/agent/extensions/argon-stall-guard.ts`.
   - Loaded at session startup but disarmed by default; use `/argonguard on` to activate the 300s stall watchdog for Argon (including main sessions and subagents).
   - When armed, sets the timeout through the process environment, including environments where login shell profiles are bypassed.

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
   - When enabled, the extension sets environment variables in the Pi process so its Antigravity provider and child processes inherit the configuration. Timeout overrides are not globally exported by `bin/pi` and are not enabled by default.

## Commands

- `/argonguard` — Show watchdog timeouts, safe recovery policy, and diagnostics count.
- `/argonguard diag` — View recent structured, credential-redacted stream diagnostics.
- `/argonguard on` / `/argonguard off` — Explicitly arm or disarm the stall guard adapter; it is off by default.

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

To return to default timeout behavior, run `/argonguard off` and restart Pi. If you manually added timeout exports to a shell profile or launcher, remove those exports and unset them in the current shell. The extension may remain installed; it is disarmed by default.
