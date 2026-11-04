# Shared OpenAI-family agents

Every `*-shared` agent explicitly selects the **`openai-codex` provider**. These
are separate named personas, not a silent fallback from the `openai` provider.
The original agent files are unchanged, including existing Terra defaults that
already use Codex. Selecting a shared name makes the intended route explicit.

Installed definitions live in `~/.pi/agent/agents/`; portable source lives in
`agents/` in this repository. No credentials, account settings, model catalogs
or global retry/default settings are changed by adding these files.

| Shared name | Model | Default effort |
|---|---|---|
| `worker-luna-shared` | `openai-codex/gpt-6-luna` | medium |
| `worker-luna-high-shared` | `openai-codex/gpt-6-luna` | high |
| `worker-sol-shared` | `openai-codex/gpt-6.1-sol` | medium |
| `worker-terra-shared` | `openai-codex/gpt-6.1-terra` | medium |
| `worker-astra-shared` | `openai-codex/gpt-6-astra` | medium |
| `scout-luna-shared` | `openai-codex/gpt-6-luna` | minimal |
| `reviewer-shared` | `openai-codex/gpt-6.1-terra` | high |
| `planner-shared` | `openai-codex/gpt-6.1-terra` | maximum |
| `planner-terra-shared` | `openai-codex/gpt-6.1-terra` | maximum |
| `planner-sol-shared` | `openai-codex/gpt-6.1-sol` | maximum |
| `advisor-shared` | `openai-codex/gpt-6-astra` | maximum |
| `advisor-astra-shared` | `openai-codex/gpt-6-astra` | maximum |
| `writer-sol-low-shared` | `openai-codex/gpt-6.1-sol` | low |

Bodies and roles match their corresponding originals. Tool declarations are
preserved, except advisors explicitly enforce their existing pure-reasoning
contract with `tools: []` and `spawns: false` (the installed subagent parser treats
`none` as an unavailable tool name, not an empty list).
`thinking` is explicit to prevent inheriting the lead's effort. Maximum keeps
the existing `:max` model suffix and uses Pi's valid `thinking: xhigh` spelling.
A model that cannot honor a requested effort must be reported, not silently
replaced. A Sol high assignment still needs an explicit `thinking: high`
override; its base worker persona intentionally remains medium.

Each shared definition has a **nonempty same-model-only** `fallback_models`
list and `max_retries: 0`. An empty fallback list can inherit profile/global
providers, so it is not a route lock. The installed native runner may still
perform a same-model retry due to its fallback-count algorithm; these files
prevent automatic cross-provider or cross-model fallback, not all retries.
Explicit dispatch parameters continue to override persona defaults: do not
pass an unrelated model or fallback list when a shared route is required.

## Dispatch and verification

```javascript
subagent({
  action: "plan",
  agent: "worker-sol-shared",
  thinking: "high",
  task: "Inspect the scoped assignment without spawning."
});
```

Validate discovery and actual runtime provider/model/effort rather than treating
shell exit 0 as success. A Pi child may exit 0 after an assistant message with
`stopReason: error` (for example an authentication/quota failure).

No shared definition adds a turn cap or timeout. **Omitting those fields does
not remove the native runner's configured default deadline.** When an operator
requires uncapped execution, use the approved direct Pi launch path with the
same pinned provider/model/effort and persona, rather than pretending native
`subagent` omission is unbounded. Disable extension discovery and use explicit
tools where required by that execution contract. Native `action: plan` is
read-only validation and does not launch work.

Tests: `python -m pytest tests/test_shared_agents.py -q`.
