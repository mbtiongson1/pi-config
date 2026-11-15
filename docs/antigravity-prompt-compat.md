# Antigravity prompt compatibility

`extensions/antigravity-prompt-compat.ts` is a user-level compatibility hook for
prompt-triggered `429 RESOURCE_EXHAUSTED` responses seen with pi-antigravity
0.14.0 and Pi 1.5.2 on 2026-11-15. Remaining account quota and an advertised model
do not rule out this failure. A generic 429 alone does not establish its cause.

## What it changes

For `antigravity` and `google-antigravity` only, `before_provider_request`:

1. Rewords the known stock Pi opening sentence group to
   `You are a coding agent helping the user with their project.`
2. Rewords the stock documentation-index phrase about codemode scripts,
   classifiers, and image models, retaining the `docs/codemode.md` reference.

Everything else is preserved, including tool schemas, user messages, project
rules, generation settings, model selection, authentication, and endpoints.
Instructions remain in `systemInstruction`; they are **not** moved to a user
turn or silently dropped. Custom text that does not match is untouched. The
hook is idempotent, emits no prompt/payload logs, and returns no replacement
when nothing changes.

This is deliberately narrow, not a general prompt obfuscator or retry loop.
Backend behavior can change again; it is a workaround, not a permanent service
availability guarantee. Genuine quota, authentication, and capacity failures
remain failures.

## Install / reload

The normal pi-config additive extension copy includes this file. To install
only this fix from the checkout without overwriting other local resources:

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent_dir/extensions"
cp extensions/antigravity-prompt-compat.ts "$agent_dir/extensions/"
```

Run `/reload` in an existing Pi session or start a fresh session. The hook is
outside the managed pi-antigravity package, so updating that package does not
remove it. Keep the local copy authoritative when resolving config syncs.
It requires the Pi `before_provider_request` hook and a provider that invokes
`onPayload`; pi-antigravity 0.14.0 does.

Disable for a controlled comparison:

```bash
ANTIGRAVITY_PROMPT_COMPAT=off pi
```

Unset the variable and restart to enable again. `0` and `false` also disable
it. Disable or remove this local compatibility extension if a future upstream
provider fix supersedes it.

## Verification

Offline:

```bash
node --experimental-strip-types --test tests/antigravity-prompt-compat.test.mjs
python -m unittest discover -s tests -p 'test_antigravity_prompt_compat.py'
python -m unittest discover -s tests -p 'test_quota_line_default.py'
```

Controlled live checks on the affected account established:

- Original prompt, with either the historical or bundled User-Agent: 429.
- Whole-opener rewrite alone: 429.
- Whole-opener plus the narrow docs-line rewrite: 200 and a completed reply.
- High and xhigh thinking: actual `read` tool execution, then a completed final
  response; doctor reported 200 on the daily endpoint and the matching tier.
- The high/xhigh checks preserved the historical User-Agent override. Changing
  that override was not necessary for the successful workaround.

Those initial checks isolated the provider and a read tool. After installation,
a native Pi Hydrogen subagent with normal resource discovery (no explicit `-e`
hook) also executed `read` and returned the exact fixture marker at high thinking.
Its session recorded `responseModel=gemini-4-hydrogen`, a successful tool result,
and a completed final assistant turn. Other tools and extended sessions were not
exhaustively tested. Do not mistake a diagnostic script's exit code for successful
model inference. Run `/antigravity.doctor` immediately after a probe, before usage
queries replace its last-request state.

The local quota-line launcher repair is preserved in this checkout as well:
it no longer reinstalls `npm:pi-high-availability` or forces existing HA error
policies back to retry. This prevents updates from undoing the user's separate
crash/retry repair; it is not the prompt-429 fix itself.

## Upstream context

- [Issue #137](https://github.com/Rahularya01/pi-antigravity/issues/137): reports
  and later corrections on changing prompt-related 429 behavior.
- [PR #147](https://github.com/Rahularya01/pi-antigravity/pull/147): broader
  opener rewrite, open/unmerged when checked. Opener-only did not fix the local
  account in this investigation.

No credentials, account identifiers, or session payloads belong in this repo.
