# Bunny Routing — Provider Transition, Credit Safety, and Device Enrollment

The Bunny family is a set of Pi subagents that share one internal model
identity: `bunny/minimax-m3.1-flash`. The identity never changes. The physical
provider behind it is resolved **at invocation time**, so the published
transition from OpenRouter free to the Vercel AI Gateway never requires
renaming or editing an agent file.

- Implementation: `extensions/bunny-router.ts` (Pi extension) +
  `extensions/bunny-route.mjs` (pure, testable decision core)
- Agents: `agents/scout-bunny*.md`, `agents/worker-bunny*.md`
- Device profiles: `device-profiles/` + `bin/device-models.sh`
- Tests: `tests/bunny-router.test.mjs` (node) and `tests/test_bunny_routing.py`

---

## 1. The Bunny agent family

| Agent | Model selection | Role |
|---|---|---|
| `scout-bunny` | alias of `scout-bunny-low` | scout |
| `scout-bunny-low` | `bunny/minimax-m3.1-flash:low` | scout |
| `scout-bunny-medium` | `bunny/minimax-m3.1-flash:medium` | scout |
| `worker-bunny` | alias of `worker-bunny-high` | worker |
| `worker-bunny-low` | `bunny/minimax-m3.1-flash:low` | worker |
| `worker-bunny-medium` | `bunny/minimax-m3.1-flash:medium` | worker |
| `worker-bunny-high` | `bunny/minimax-m3.1-flash:high` | worker |
| `worker-bunny-xhigh` | `bunny/minimax-m3.1-flash:xhigh` | worker |
| `worker-bunny-max` | `bunny/minimax-m3.1-flash:max` | worker |

Every invocation pins an explicit thinking level. `off` and `minimal` are not
part of the family: the OpenRouter free route maps both to `null` in the
published model catalog, and MiniMax requires a reasoning budget. If a pinned
level is not supported by the physical model, the request fails with an
explicit diagnostic — it is never silently downgraded.

No Bunny agent sets `max_turns` or `max_cost`. Pi subagents are not turn-capped.

Scouts are read-only (`read, grep, find, ls, bash`). Workers deliver code,
tests, findings, and a precise status receipt.

There is deliberately **no** Bunny planner and no Bunny advisor.

---

## 2. The published route schedule

| Period | Scheduled route | Provider | Model | Credential |
|---|---|---|---|---|
| until 2026-10-22T12:00:00Z (20:00 Asia/Manila) | `openrouter-free` | `openrouter` | `minimax/minimax-m3.1-flash:free` | `OPENROUTER_API_KEY` or `/login openrouter` |
| from 2026-10-22T12:00:00Z | `vercel-ai-gateway` | `vercel-ai-gateway` | `minimax/minimax-m3.1-flash` | `AI_GATEWAY_API_KEY` or `/login vercel-ai-gateway` |

Sources:

- Vercel changelog, 19 Oct 2026 — "MiniMax M3.1 Flash from MiniMax is now
  available on AI Gateway for free until Oct 22. The free rate applies only
  when MiniMax serves the request… After the offer ends, pinned requests bill
  at MiniMax's standard rate."
  <https://vercel.com/changelog/minimax-m3-1-flash-now-available-on-ai-gateway-for-free>
- `mbtiongson1/pi-config#9` — "Until Oct 22 2026 12:00 UTC, prefer OpenRouter
  `openrouter/minimax/minimax-m3.1-flash:free` subject to actual
  availability/rate limits. Do not silently switch to paid on date alone."
- Pi model catalog (verified live against `https://pi.dev/api/models/providers/…`):
  - `openrouter` → `minimax/minimax-m3.1-flash:free`, `openai-completions`,
    `thinkingLevelMap` = off/minimal `null`, low/medium/high/xhigh/max mapped.
  - `vercel-ai-gateway` → `minimax/minimax-m3.1-flash`, `anthropic-messages`,
    base `https://ai-gateway.vercel.sh`, `compat.allowEmptySignature: true`.

The two promotions are tracked separately, so they can end at different times.
The OpenRouter `:free` variant is served at $0 by construction; the Vercel
promotion is account-specific and may bill after its cutoff.

---

## 3. How the resolution works

Pi's native **virtual model** mechanism is used. `extensions/bunny-router.ts`
registers `bunny/minimax-m3.1-flash` as a virtual model. On every request Pi
calls the router, which returns a physical model and thinking level.

```
agent file  ->  pi --model bunny/minimax-m3.1-flash:high
             ->  virtual model route
             ->  openrouter/minimax/minimax-m3.1-flash:free   (before cutoff)
                vercel-ai-gateway/minimax/minimax-m3.1-flash    (after cutoff)
```

### Gates a route must pass

1. the model exists in the local Pi catalog (`pi update --models`),
2. the provider has working credentials,
3. local authorization allows the route,
4. the pinned thinking level is supported by the physical model.

If the scheduled route fails any gate, routing **fails closed** with an
actionable error that names the exact blocker. The router does not silently
switch providers. A second route is only used when the local state sets
`routing.allowVerifiedFallback: true` **and** that route is itself verified.

### In-flight jobs

A continuation (tool follow-up) or a retry stays on the provider that already
served the turn, so a route change never interrupts running work. A **new**
invocation re-evaluates the schedule, so a job started after the cutoff uses
the new route.

---

## 4. Credit and billing safety

- The clock selects a preference. It never authorizes spending.
- The OpenRouter `:free` route cannot bill.
- The Vercel route requires one of:
  - `freeVerified: true` — the account's free credit was checked and covers
    MiniMax usage, or
  - `paidAuthorized: true` — explicit human authorization for paid use.
- A catalog price of `$0` is **not** treated as proof that a request is free.
  The Vercel catalog entry is priced at `$0`, but the changelog says the free
  rate only applies while MiniMax serves the request.
- A verification dated before the promotion cutoff is treated as stale after
  the cutoff and must be renewed.
- `routing.spend.capUsd` (default 5) blocks a paid route once the recorded
  spend reaches the cap.
- No automatic purchase, no auto top-up, no broad provider fallback chain, no
  automatic switch to paid OpenRouter, and no MiniMax direct route.
- Direct MiniMax (`minimax` provider, `MINIMAX_API_KEY`) stays disabled until
  it is separately authorized — see `mbtiongson1/pi-config#11`.

Costs are tracked with the mandatory `pi-cost` skill.

---

## 5. Device-scoped model catalog

Every machine may keep its own model catalog and routing preferences. Only
machines that explicitly enroll are affected.

```bash
bash bin/device-models.sh list
bash bin/device-models.sh status
bash bin/device-models.sh enroll macbook-air-m1
bash bin/device-models.sh verify
bash bin/device-models.sh sync macbook-air-m1
bash bin/device-models.sh diff macbook-air-m1
bash bin/device-models.sh restore macbook-air-m1 --yes
bash bin/device-models.sh disable
```

- Git-tracked: `device-profiles/<device>/profile.json` and
  `device-profiles/<device>/model-catalog.json` — device alias, provider and
  model identifiers, routing policy, availability status, verification
  timestamps. No secrets, no account identifiers, no balances, no hostname,
  username, home path, or hardware id.
- Local only: `<agent-dir>/device-profile.json` — enrollment flag and the
  non-secret authorization flags (`freeVerified`, `paidAuthorized`, spend
  counters). Never synced into the repository.

Enrollment never runs during an Update, a Reinstall, or a Pi package install.
A fresh installation on another machine does not inherit the MacBook's routing
and does not overwrite its own `models.json`.

See [`device-profiles/README.md`](../device-profiles/README.md) for the full
split and the rollback procedure.

---

## 6. Verifying the setup

```bash
# the virtual model is registered
pi --list-models bunny

# a live request through the routed identity
pi --print --no-session --no-tools --model bunny/minimax-m3.1-flash:low --thinking low \
  "Reply with exactly: BUNNY_OK"

# an unsupported level fails explicitly
pi --print --no-session --no-tools --model bunny/minimax-m3.1-flash --thinking off "hi"

# local routing state
bash bin/device-models.sh status

# the behavioural matrix
node --test tests/bunny-router.test.mjs
python3 -m unittest tests.test_bunny_routing
```

---

## 7. Rollback

```bash
# stop routing entirely on this machine
bash bin/device-models.sh disable

# remove the virtual model by removing the extension
rm "$HOME/.pi/agent/extensions/bunny-router.ts" "$HOME/.pi/agent/extensions/bunny-route.mjs"

# revert the repository side
git revert <commit>
```

Removing the extension makes `bunny/minimax-m3.1-flash` unresolvable, so the
Bunny agents fail fast instead of silently running on another model. The
default Flash provider (`antigravity/gemini-3.8-flash`) is never affected.
