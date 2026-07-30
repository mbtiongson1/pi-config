---
name: proxy
description: Set up a local LLM proxy (Hyperspace/HAI) in pi. Run when the user says "Proxy", asks to configure proxy models, or wants to connect pi to a local LLM proxy.
version: 1.0.0
---

# Proxy Setup

Help the user configure pi to use a local LLM proxy — specifically the Hyperspace HAI proxy (`hai` CLI), which exposes Anthropic, OpenAI, and Gemini models through local endpoints.

## Step 1: Collect credentials

Ask the user for the following — do not proceed until both are provided:

1. **Proxy base URL** — the root URL where the proxy is running.
   - Example: `http://localhost:6655`
   - Ask: *"What is the base URL of your proxy? (e.g. http://localhost:6655)"*

2. **API key** — the proxy's bearer token / API key.
   - Ask: *"What API key does your proxy require?"*

Do not accept vague answers. If they give a URL without a scheme or port, ask them to confirm the full URL including `http://` and port number.

## Step 2: Explain what will be configured

Tell the user:

> I'll configure four provider groups against your proxy:
>
> - **hai-proxy** — Claude models (Anthropic-native endpoint)
> - **hai-litellm** — GPT-5.5 and GPT-5.4 (OpenAI Responses endpoint)
> - **hai-mini** — GPT-5 Mini (OpenAI chat completions via LiteLLM)
> - **hai-gemini** — Gemini 3.5 Flash (Google native endpoint)
>
> The following models will be registered:
> - `anthropic--claude-4.8-opus`
> - `anthropic--claude-4.6-sonnet`
> - `anthropic--claude-4.5-haiku`
> - `gpt-5.5`
> - `gpt-5.4`
> - `gpt-5-mini`
> - `gemini-3.5-flash`

Ask the user to confirm before writing.

## Step 3: Write models.json

Write `~/.pi/agent/models.json` using the template below, substituting `<BASE_URL>` with the user's proxy URL and `<API_KEY>` with their API key.

**Important**: Use these exact endpoint suffixes — they correspond to specific proxy routes that were validated to work:

| Provider | Endpoint suffix | Pi `api` type |
|---|---|---|
| hai-proxy | `<BASE_URL>/anthropic` | `anthropic-messages` |
| hai-litellm | `<BASE_URL>/openai/v1` | `openai-responses` |
| hai-mini | `<BASE_URL>/litellm/v1` | `openai-completions` |
| hai-gemini | `<BASE_URL>/gemini/v1beta` | `google-generative-ai` |

**Compat notes (do not omit these — they are required for tool calls to work):**
- `hai-proxy`: `supportsEagerToolInputStreaming: false`
- `hai-litellm`: `supportsStrictMode: false`
- `hai-mini`: `supportsStrictMode: false`
- `claude-4.5-haiku`: `forceAdaptiveThinking: false` (model-level)
- `gpt-5.5`: `thinkingLevelMap` with `minimal → low` and `max → null` (proxy rejects those values)
- `gpt-5.4` / `gpt-5-mini`: `thinkingLevelMap` with `max → null`

**models.json template:**

```json
{
  "providers": {
    "hai-proxy": {
      "baseUrl": "<BASE_URL>/anthropic",
      "apiKey": "<API_KEY>",
      "api": "anthropic-messages",
      "compat": {
        "supportsEagerToolInputStreaming": false
      },
      "models": [
        {
          "id": "anthropic--claude-4.8-opus",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1000000,
          "maxTokens": 128000
        },
        {
          "id": "anthropic--claude-4.6-sonnet",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1000000,
          "maxTokens": 64000
        },
        {
          "id": "anthropic--claude-4.5-haiku",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1000000,
          "maxTokens": 32000,
          "compat": {
            "forceAdaptiveThinking": false
          }
        }
      ]
    },
    "hai-litellm": {
      "baseUrl": "<BASE_URL>/openai/v1",
      "apiKey": "<API_KEY>",
      "api": "openai-responses",
      "compat": {
        "supportsStrictMode": false
      },
      "models": [
        {
          "id": "gpt-5.5",
          "name": "GPT-5.5",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 128000,
          "thinkingLevelMap": {
            "off": "none",
            "minimal": "low",
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "xhigh",
            "max": null
          }
        },
        {
          "id": "gpt-5.4",
          "name": "GPT-5.4",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 128000,
          "thinkingLevelMap": {
            "off": "none",
            "minimal": "minimal",
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "xhigh",
            "max": null
          }
        }
      ]
    },
    "hai-mini": {
      "baseUrl": "<BASE_URL>/litellm/v1",
      "apiKey": "<API_KEY>",
      "api": "openai-completions",
      "authHeader": true,
      "compat": {
        "supportsStrictMode": false
      },
      "models": [
        {
          "id": "gpt-5-mini",
          "name": "GPT-5 Mini",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 128000,
          "thinkingLevelMap": {
            "off": "none",
            "minimal": "minimal",
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "xhigh",
            "max": null
          }
        }
      ]
    },
    "hai-gemini": {
      "baseUrl": "<BASE_URL>/gemini/v1beta",
      "apiKey": "<API_KEY>",
      "api": "google-generative-ai",
      "models": [
        {
          "id": "gemini-3.5-flash",
          "name": "Gemini 3.5 Flash",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1048576,
          "maxTokens": 65536
        }
      ]
    }
  }
}
```

## Step 4: Update settings.json enabledModels

Add the following entries to `enabledModels` in `~/.pi/agent/settings.json` (append — do not remove existing entries):

```json
"hai-proxy/anthropic--claude-4.8-opus",
"hai-proxy/anthropic--claude-4.6-sonnet",
"hai-proxy/anthropic--claude-4.5-haiku",
"hai-litellm/gpt-5.5",
"hai-litellm/gpt-5.4",
"hai-mini/gpt-5-mini",
"hai-gemini/gemini-3.5-flash"
```

## Step 5: Verify

Run a quick smoke test for each provider using the pi CLI:

```bash
pi --provider hai-proxy --model "anthropic--claude-4.6-sonnet" --no-tools -p "Say OK"
pi --provider hai-litellm --model "gpt-5.5" --thinking medium -p "Say OK"
pi --provider hai-mini --model "gpt-5-mini" --thinking medium -p "Say OK"
pi --provider hai-gemini --model "gemini-3.5-flash" --thinking medium -p "Say OK"
```

Report which pass and which fail. If any fail, check:
- Is the proxy running? (`curl <BASE_URL>/`)
- Is the API key correct? (try `curl <BASE_URL>/litellm/v1/models -H "Authorization: Bearer <API_KEY>"`)

## Notes on why this specific wiring

- **`/anthropic` with `anthropic-messages`**: Claude models require the Anthropic-native messages format; the LiteLLM/OpenAI endpoints drop extended thinking support.
- **`/openai/v1` with `openai-responses`**: GPT-5.5 and GPT-5.4 require the newer Responses API (`responses` subpath); chat completions reject them.
- **`/litellm/v1` with `openai-completions`**: GPT-5 Mini is rejected by the Responses subpath — must use chat completions.
- **`/gemini/v1beta` with `google-generative-ai`**: Gemini requires the native Google `generateContent` format; OpenAI-compat endpoints return 404 for Gemini models.
- **`supportsStrictMode: false`**: Without this, Pi sends strict JSON-schema tool definitions that the proxy rejects with 400.
- **`supportsEagerToolInputStreaming: false`**: Required for the Anthropic endpoint to stream tool calls correctly.
