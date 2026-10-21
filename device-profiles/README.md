# Device Profiles

A device profile is a **sanitized, Git-trackable** description of one machine's
model catalog and routing policy. Each machine opts in explicitly; no machine
inherits another machine's routing.

The first enrolled device is `macbook-air-m1` (MacBook Air M1, darwin/arm64).

```text
device-profiles/
  README.md
  schema.json                        # JSON Schema for profile.json
  templates/
    device-profile.example.json       # copy this to start a new device
  macbook-air-m1/
    profile.json                      # policy + verification metadata
    model-catalog.json                # sanitized snapshot of the local catalog
```

## What is tracked in Git vs. kept local

| Git-tracked (shareable) | Local only (never committed) |
|---|---|
| Device alias, platform, architecture | API keys and OAuth tokens |
| Provider IDs and model identifiers | Credential locations and account IDs |
| Enabled models and thinking levels | Credit balances and billing data |
| Bunny routing policy and route schedule | Private endpoints |
| Supported role / subagent definitions | Verification of account-specific credit |
| Model availability status, verification timestamp | Spend counters |
| Non-sensitive preferences | |

`auth.json`, `models.json`, `trust.json`, `.env`, and sessions stay local —
that rule is unchanged. The local state file this feature adds is
`<agent-dir>/device-profile.json`; it holds only non-secret authorization
flags and is never synced into the repository.

## Commands

```bash
bash bin/device-models.sh list                 # profiles in this repository
bash bin/device-models.sh status               # local enrollment + resolved route
bash bin/device-models.sh enroll macbook-air-m1  # opt this machine in
bash bin/device-models.sh verify               # re-check catalog + credentials
bash bin/device-models.sh sync macbook-air-m1  # push a sanitized snapshot
bash bin/device-models.sh diff macbook-air-m1  # local vs tracked
bash bin/device-models.sh restore macbook-air-m1 --yes  # apply tracked prefs
bash bin/device-models.sh disable              # turn Bunny routing off here
```

Every local write is atomic and keeps a single `.bak` copy of the previous
file, so an interrupted run cannot leave a half-written profile.

## Enrollment is explicit

`enroll` is never run by Update, Reinstall, or a Pi package install. A fresh
installation on another machine therefore has:

- no local `device-profile.json`,
- no inherited routing preference,
- and no change to its own `models.json`.

On an unenrolled machine the Bunny router still works, but it uses only the
published schedule and the machine's own credentials. Device-specific
verification (for example a Vercel AI Gateway free-credit check) is never
inherited, because it is never committed.

## The Bunny route in a profile

`bunny.identity` is the stable internal identity `bunny/minimax-m3.1-flash`.
`bunny.routes` mirrors the schedule in `extensions/bunny-route.mjs`:

| Route | Provider | Model | Free until | Guarantee |
|---|---|---|---|---|
| `openrouter-free` | `openrouter` | `minimax/minimax-m3.1-flash:free` | 2026-10-22T12:00:00Z | cannot bill |
| `vercel-ai-gateway` | `vercel-ai-gateway` | `minimax/minimax-m3.1-flash` | 2026-10-22T12:00:00Z | promotional, account-specific |

`bunny.policy` records the guardrails: no automatic purchase, no auto top-up,
no automatic paid OpenRouter, and MiniMax direct stays disabled until it is
separately authorized.

## Sync and diff

`sync` writes a sanitized snapshot of the locally available models and
refreshes the availability metadata in `profile.json`. It copies no secret:
only a fixed set of safe model fields is written, and the writer strips any
key that could carry a credential or a machine identifier.

`diff` compares the local snapshot with the tracked one and prints the
difference per provider, then lists the local-only fields that are never
committed.

## Rollback

```bash
bash bin/device-models.sh disable            # stop routing on this machine
rm "$HOME/.pi/agent/device-profile.json.bak" # keep a copy before editing
git revert <sync-commit>                     # restore the previous snapshot
```

`restore` only adds the profile's models to the local `models.json`; it never
removes entries and never touches `auth.json`.
