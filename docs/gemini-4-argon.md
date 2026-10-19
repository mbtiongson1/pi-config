# Gemini 4 Argon in Pi (Antigravity)

The checked-in templates enable the Antigravity provider, expose Gemini 4 Argon,
and define its model metadata. Authentication stays local to each machine; do
not copy `auth.json`, account files, access tokens, or refresh tokens between
environments.

## Model setup

1. Install `npm:pi-antigravity` and authenticate through its supported login
   flow in the target environment.
2. Confirm `settings.json` includes `npm:pi-antigravity` in `packages` and
   `antigravity/gemini-4-argon` in `enabledModels`. The repository template
   includes both.
3. Confirm `models.json` includes the Argon override under
   `providers.antigravity.modelOverrides` (and
   `providers.google-antigravity.modelOverrides` if that alias is used).
   `models.json.template` sets a 1,048,576 token context window, a 65,536 token
   output limit, and the model cost metadata. Preserve unrelated local model
   settings.
4. Refresh provider models or restart Pi, then select
   `antigravity/gemini-4-argon` with the desired thinking level. A configured
   model does not guarantee that the provider currently offers access.

If the installed provider package does not expose Argon, the compatibility
repair is available for Linux/Termux:

```bash
bash bin/ensure-antigravity-argon.sh
```

The script may edit shell profiles and files under
`~/.pi/agent/npm/node_modules`. It sets a Linux/amd64-style User-Agent, so review
its changes before using it on another operating system. It does not configure
credentials. Restart Pi after running it.

## Verify

- Confirm the provider package and Argon enabled-model entry are present.
- Confirm `models.json` contains the Argon override and metadata.
- Confirm the local provider model catalog includes `gemini-4-argon`.
- Make a short request at low thinking effort. If authentication fails,
  reauthenticate locally; a model catalog entry alone does not prove access.
