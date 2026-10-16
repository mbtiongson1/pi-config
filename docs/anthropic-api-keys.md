# Anthropic API Key vs. Subscription OAuth (`pi-background-tasks`)

## Overview

When `npm:pi-background-tasks` is installed, its default configuration enables ambient Anthropic attribution (`attribution`). Ambient attribution intercepts requests routed to `provider: "anthropic"` to enforce Claude Code subscription OAuth tokens (`sk-ant-oat...`).

If you attempt to use standard Anthropic API keys (`sk-ant-api...` via `ANTHROPIC_API_KEY` or `~/.pi/agent/auth.json`), Pi fails with the following error:

```text
Error: Anthropic attribution refuses non-OAuth Anthropic credential; subscription OAuth token is required
If this looks like a pi bug, /bug sends a report to the developer
```

## Solution: Using Standard API Keys (Option B)

If you do not want to use Claude Pro/Max subscription OAuth and want your standard Anthropic API key to work directly:

Disable the ambient attribution feature in `pi-background-tasks` by omitting `attribution` from `PI_BG_FEATURES`.

Set the environment variable in your shell profile (`~/.bashrc`, `~/.zshrc`, or `~/.profile`):

```bash
export PI_BG_FEATURES="process,delegate,fusion,attested"
```

### Why this works

`pi-background-tasks` defines five feature flags:
`process`, `delegate`, `fusion`, `attested`, and `attribution`.

Omitting `attribution` prevents the package from wrapping the `anthropic` provider in the main session. All other background task features (`bg_run`, `bg_delegate`, `fusion_*`, and attested runs) remain fully operational while allowing your standard Anthropic API key to pass directly to Anthropic's Messages API.

## Alternative: Using Claude Pro/Max Subscription OAuth (Option A)

If you intentionally want to use Claude Pro/Max subscription OAuth instead of paying for API keys:
1. Install `npm:pi-anthropic-oauth`:
   ```bash
   pi install npm:pi-anthropic-oauth
   ```
2. Run `/login` in Pi and select **Claude Pro/Max**.
3. Complete the browser OAuth login. This stores `~/.claude.json` and supplies the necessary `sk-ant-oat...` token.
