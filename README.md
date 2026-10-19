# Pi Config — mbtiongson1 (v1.10.0)

Portable, reproducible pi setup with custom agents, extensions, prompts, and a **mandatory pi-cost skill**.
**Repo:** `https://github.com/mbtiongson1/pi-config`

---

## Pi Agent Prompt

```
You are helping manage a pi config
from https://github.com/mbtiongson1/pi-config.

Ask if the user wants to:
- Update (pull latest and layer over existing config, including mandatory pi-cost)
- Reinstall (clean wipe of managed folders, then copy fresh from repo and install mandatory pi-cost)
- Sync (push current ~/.pi/agent/ state back to the repo)
- Diff (show differences between ~/.pi/agent/ and the repo)

Then carry out whichever they choose.

After **every Update or Reinstall**, run `bash bin/install-pi-cost.sh` from this checkout. It copies and verifies the versioned skill, script, license/notice, and Gaia/LiteLLM price catalog into `${PI_CODING_AGENT_DIR:-~/.pi/agent}/skills/pi-cost`; installation failure blocks completion. Pi discovers this user skill without a `settings.json` package entry. `pi-cost` is **mandatory**, not an optional package.

Then check `optional-packages.json`. If any optional package is missing from `~/.pi/agent/settings.json`, ask whether to install it. Never treat `pi-cost` as optional.
```

---

## Quick One-Liners

**Update** — pull latest and layer over existing config (additive, won't delete anything):

```
Pull the latest from https://github.com/mbtiongson1/pi-config
and copy agents, extensions, prompts, and bin
into ~/.pi/agent/ without removing anything already there.
Run bash bin/install-pi-cost.sh and bash bin/install-append-system.sh from the repo and verify both succeed (mandatory).
Then check optional-packages.json in the repo and ask
if I want to install any listed packages that are missing from ~/.pi/agent/settings.json.
```

**Reinstall** — clean wipe, then copy fresh from repo:

```
Clone https://github.com/mbtiongson1/pi-config (or pull if already cloned),
wipe ~/.pi/agent/agents, extensions, prompts, and bin,
then copy them fresh from the repo.
Run bash bin/install-pi-cost.sh and bash bin/install-append-system.sh from the repo and verify both succeed (mandatory).
Also reset settings.json from the template.
Then check optional-packages.json in the repo and ask
if I want to install any listed packages that are missing from ~/.pi/agent/settings.json.
```

**Sync** — push current `~/.pi/agent/` state back to the repo:

```
Copy agents, extensions, prompts, and bin
from ~/.pi/agent/ into the local pi-config repo,
then commit and push to https://github.com/mbtiongson1/pi-config.
Skip auth.json, models.json, trust.json, and sessions/.
```

**Diff** — show differences between `~/.pi/agent/` and the repo:

```
Show differences between the installed files in ~/.pi/agent/
and the local repository /Users/marcotiongson/Documents/pi-config/
by diffing agents, extensions, prompts, and bin.
```

---

## What's in the Repo

| Path | Purpose |
|------|---------|
| `agents/` | Custom subagents (advisor, planner, reviewer, scout, worker) |
| `extensions/` | Custom pi extensions (including `/statusline` bloat manager and last-message/cache status) |
| `statusline.json.template` | Default statusline settings (`showExtensions: false` clean default) |
| `prompts/` | Prompt templates |
| `themes/` | Dark-mode-first custom themes (`favor-cream`, `favor-dark`, `favor-events`, `favor-finance-green`, `favor-indigo`, `favor-watershed`, `finance-editorial`, `gaia-research`, `gaia-skill-tree`) |
| `bin/` | Utility scripts |
| `bin/ensure-quota-line.sh` | Idempotent quota surface verification ensuring quota box is never on by default and default is always quota line |
| `bin/ensure-antigravity-argon.sh` | Linux/Termux compatibility repair for Gemini 4 Argon model mapping and stall-timeout setup; review its shell-profile and package-source edits before running on other platforms |
| `docs/gemini-4-argon.md` | End-to-end Antigravity/Argon setup, safe portability notes, diagnostics, and stream-stall guard details |
| `settings.json.template` | Base settings — fill in your provider + models |
| `skills/pi-cost/` | Mandatory v1.10.0 skill, cost calculator, license/notice, and auto-refreshing Gaia/LiteLLM price catalog |
| `skills/astra-advisor/` | Portable one-round decision advisor skill (`SKILL.md`) and native Codex configuration profile (`codex.config.toml`) |
| `bin/install-astra-advisor.sh` | Standalone installer for Astra Advisor across Pi and Codex |
| `APPEND_SYSTEM.md` | Global engineering-discipline contract (Pi native system-prompt append) |
| `bin/install-append-system.sh` | Required idempotent installer for the contract on Update and Reinstall; preserves user text |
| `bin/install-pi-cost.sh` | Required idempotent, verified install step on Update and Reinstall |
| `VERSION` | pi-config release version (`1.10.0`) |
| `bin/install-codex-computer-use.sh` | Optional installer & health-check runner for Codex Computer Use on macOS |
| `docs/codex-computer-use.md` | Guide for Codex Computer Use integration, doctor, and permissions |
| `optional-packages.json` | List of *other* optional packages/extensions to prompt for installation |

## What's NOT Committed (stays local)

`auth.json` · `models.json` · `trust.json` · `sessions/` · any API keys or proxy config

---

## Antigravity cache warming

The default Pi template opts `antigravity/gemini-3.8-flash` into the extension's guarded `force` warming policy. Other Antigravity Flash models retain the existing streaming-only policy. The model template supplies a five-minute scheduling hint; it is a local Pi refresh cadence, **not a published or guaranteed Antigravity cache TTL**. The extension may override Pi's default savings decision only inside its estimated per-refresh miss-premium guard, and Pi's own active/idle safety windows still apply. A completed refresh is not itself proof that the provider reported a cache hit.

---

## Optional Integrations

### Statusline Bloat Manager (`/statusline`)
Control statusline bloat from extensions with clean-by-default behavior:

- **Clean Default**: Extension statuses are suppressed by default unless explicitly specified.
- **Commands**:
  - `/statusline` — Open interactive picker menu
  - `/statusline hide` — Hide extension statuses (clean mode)
  - `/statusline show` — Show extension statuses
  - `/statusline hide all` — Hide entire footer/statusline (zen view)
  - `/statusline show all` — Show full footer and all extension statuses
  - `/statusline toggle` / `/statusline toggle all` — Toggle visibility
  - `/statusline block <key>` / `/statusline allow <key>` / `/statusline only <key>` — Fine-grained key filtering
  - `/statusline status` / `/statusline list` — View current state and active keys in memory
  - `/statusline reset` — Reset to default clean state
- **Config**: Persisted to `~/.pi/agent/statusline.json` across sessions.

---

### Completion Sound Effects (`/sound`)
Audio notification cues on task completion:
- **Agent Settled**: Plays audio chime when main agent completes all actions and reaches idle.
- **Subagent Finish**: Plays a distinct audio chime when delegated subagent tool completes.
- **Cross-platform**: Auto-detects Android/Termux (`termux-media-player`), macOS (`afplay`), Linux PulseAudio (`paplay`), ALSA (`aplay`), and `mpv`.
- **Commands**:
  - `/sound` — View status and active sound paths
  - `/sound toggle` — Mute/unmute sounds
  - `/sound test` — Test main agent chime
  - `/sound test-subagent` — Test subagent chime
- **Config**: Persisted to `~/.pi/agent/sounds.json`.

---

### Codex Computer Use (macOS)
Give Pi agents native access to macOS desktop inspection and control using `pi-codex-computer-use`.

- **Platform**: macOS only
- **Prerequisites**: Pi CLI, Codex CLI, Codex.app / ChatGPT.app (`com.openai.codex`), Accessibility and Screen Recording permissions.
- **Install / Verify**:
  ```bash
  bash bin/install-codex-computer-use.sh          # Idempotent install
  bash bin/install-codex-computer-use.sh --doctor # Status check
  bash bin/install-codex-computer-use.sh --smoke-test # Live tool verification
  ```
- **Disable**:
  ```bash
  bash bin/install-codex-computer-use.sh --disable
  ```
- Full guide: [`docs/codex-computer-use.md`](docs/codex-computer-use.md)

---

### Jev (System One) & Selectable Decision Engine
Fast probabilistic decision layer, semantic MCP tool discovery, and reflex classification:

- **Features**:
  - **Selectable Classifier Engines** (`extensions/jev-classifier.ts`): Switch seamlessly between actual TypeSafe Jev (`openrouter/~typesafe/jev-latest` / `typesafe`) and lightweight LLM mimics (`antigravity/gemini-3.8-flash` or `openai/gpt-6-luna` with thinking: off).
  - **Pi Tool (`classify`)**: Evaluates discrete questions (choice, bool, score) over arbitrary JSON states.
  - **Subagent (`jev-wannabe`)**: Specialized agent for isolated decision routing and classification.
  - **Telemetry in Statusline**: Real-time token and cost meter (`⚡ Jev [actual|flash|luna]`) with zero extra footprint.
- **Commands**:
  - `/classifier mode [actual|flash|luna|auto]` — Switch active engine
  - `/classifier` or `/jev` — Interactive picker and telemetry review
- **Install & Setup**:
  ```bash
  bash bin/install-jev.sh
  ~/.pi/agent/npm/node_modules/.bin/pi-mcp-adapter key set systemone
  ```

---

### OpenAI Fast Mode (`/fast`)
Enables OpenAI priority service tier routing directly inside Pi:

- **Package**: `npm:@benvargas/pi-openai-fast` (in `optional-packages.json`)
- **Commands**:
  - `/fast` — Toggle fast mode on/off
  - `/fast status` — Inspect priority tier status on active model
  - `--fast` — CLI flag on startup
- **Supported Models**: `openai/*`, `openai-codex/*` (GPT-5 and GPT-6 families).

---

### Anthropic API Keys with `pi-background-tasks`
By default, `npm:pi-background-tasks` enables Claude Code subscription OAuth attribution for Anthropic models. If you use standard Anthropic API keys (`sk-ant-api...` via `ANTHROPIC_API_KEY` or `~/.pi/agent/auth.json`), Pi will reject the non-OAuth credential:
`Error: Anthropic attribution refuses non-OAuth Anthropic credential; subscription OAuth token is required`

To use standard Anthropic API keys, disable ambient attribution in your shell startup (`~/.bashrc` / `~/.zshrc`):
```bash
export PI_BG_FEATURES="process,delegate,fusion,attested"
```
This preserves all background task and delegation features while allowing standard Anthropic API keys to work directly. See [`docs/anthropic-api-keys.md`](docs/anthropic-api-keys.md) for full details.

---

### Gemini 4 Argon on Antigravity (`/argonguard`)
The templates enable `npm:pi-antigravity`, include `antigravity/gemini-4-argon`, and define the Argon model metadata. Authentication is per-environment and must be completed locally; never copy `auth.json` or provider tokens between machines. For a new machine, first validate the package, enabled-model entry, model override, and local Antigravity login. If the installed provider lacks Argon, the Linux/Termux compatibility repair is `bash bin/ensure-antigravity-argon.sh`; it can modify shell profiles and installed provider source, and its User-Agent override should not be blindly applied to other operating systems. The stall guard is off by default: explicitly run `/argonguard on` to activate its timeout overrides. See [`docs/gemini-4-argon.md`](docs/gemini-4-argon.md) for the full setup and verification checklist.

The guard prevents premature `Error: stream stalled: no data for 120000ms` aborts during extended reasoning on Gemini 4 Argon:

- **Features**:
  - **Opt-In 300s Stream Watchdog**: When explicitly armed, sets upstream `ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS=300000` while maintaining an independent 180s header deadline; disabled by default.
  - **Structured Redacted Diagnostics**: Categorizes failures (`provider_silence`, `network_disconnection`, `process_termination`, `timeout`) with credentials automatically redacted.
  - **Safe Recovery**: Automatically retries only during pure reasoning prior to tool dispatch; strictly blocks replays if tool calls (`write`, `edit`, `bash`) were present to prevent duplicate side effects.
  - **Model Invariants**: Preserves exact model (`gemini-4-argon`) and thinking level; keeps subagent turn counts unbounded.
- **Commands**:
  - `/argonguard` — Inspect active timeouts and safe recovery status
  - `/argonguard diag` — Review credential-redacted diagnostics
  - `/argonguard on|off` — Arm or disarm stall guard
- **Full Documentation**: See [`docs/gemini-4-argon.md`](docs/gemini-4-argon.md).

---

### Advisor Roles in Pi (`advisor-astra` & `advisor-argon`)
Advisors in Pi are specialized one-round decision agents for high-stakes technical and architectural choices:

- **Core Behavioral Contract**:
  - **Pure Reasoning Only**: Advisors receive a complete brief and return advice in one round. They have zero tools attached—no filesystem edits, bash commands, or web searches.
  - **Maximum Reasoning Depth**: Explicitly configured to maximum thinking depth (`:max`).
  - **Strict Brief Prerequisites**: Callers must provide **Situation**, **Constraints**, **Options** (at least 2), and **Goal**. If any prerequisite is missing or vague, the advisor refuses to speculate and returns:
    `❌ **Insufficient context.** I need the following before I can advise: [list what's missing]`
  - **Structured Output**: Every evaluation returns four mandatory sections: `## Decision`, `## Reasoning`, `## Risks`, and `## Confidence`.
- **Configured Advisor Roles**:
  - `advisor-astra`: Pinned to `openai/gpt-6-astra:max` (or `openai-codex/gpt-6-astra:max`).
  - `advisor-argon`: Pinned to `antigravity/gemini-4-argon:max`.
  - *Fable Advisor Note*: In audit discovery, while `anthropic/claude-fable-5` was enabled in model settings and tracked in pricing catalogs, no dedicated `advisor-fable.md` agent file or prompt was authored on disk or committed to repository history.
  - `agent-templates.json`: Maps the abstract role `"advisor"` to `openai--gpt-6-astra` at `thinkingLevel: "max"`.
- **How Advisors are Invoked in Pi**:
  - Via subagent delegation:
    ```javascript
    subagent({
      agent: "advisor-astra",
      task: "Situation: ... Constraints: ... Options: 1) ... 2) ... Goal: ..."
    })
    ```
  - Via role template:
    ```javascript
    subagent({
      role: "advisor",
      task: "Situation: ... Constraints: ... Options: 1) ... 2) ... Goal: ..."
    })
    ```
  - Interactively in session:
    ```bash
    /agent advisor-astra
    ```

---

### Astra Advisor for Codex & Pi

Astra Advisor is packaged as a reusable, portable skill and native configuration profile compatible across Pi, OpenAI Codex CLI, and standard AgentSkills harnesses.

#### Installation

Astra Advisor is fully decoupled from personal configurations, private API keys, and custom extensions. Friends or external collaborators can install it standalone:

```bash
# Clone the repository (or download skills/astra-advisor)
git clone https://github.com/mbtiongson1/pi-config.git
cd pi-config

# Standalone install to Codex CLI only:
bash bin/install-astra-advisor.sh --codex

# Standalone install to Pi only:
bash bin/install-astra-advisor.sh --pi

# Or install to both:
bash bin/install-astra-advisor.sh --all
```

**Manual installation (no scripts required):**
- **For Codex CLI**:
  1. Copy `skills/astra-advisor/SKILL.md` to `~/.codex/skills/astra-advisor/SKILL.md` (for in-session skill usage).
  2. Copy `skills/astra-advisor/codex.config.toml` to `~/.codex/astra-advisor.config.toml` (for native `-p astra-advisor` profile execution).
  3. Copy `bin/astra-advisor-preflight.py` and `bin/run-astra-advisor.sh` to `~/.codex/skills/astra-advisor/preflight.py` and `~/.codex/skills/astra-advisor/run-astra-advisor.sh`, then make the launcher executable.
- **For Pi**:
  1. Copy `skills/astra-advisor/SKILL.md` to `~/.pi/agent/skills/astra-advisor/SKILL.md`.
  2. Copy `agents/advisor-astra.md` to `~/.pi/agent/agents/advisor-astra.md`.

#### Invocations

**In OpenAI Codex CLI:**
- *Native Agent Profile (Recommended)*:
  ```bash
  # Check the installed Codex model catalog, then run one isolated advisor turn.
  ~/.codex/skills/astra-advisor/run-astra-advisor.sh "Situation: ... Constraints: ... Options: 1) ... 2) ... Goal: ..."
  ```
  Direct `codex -p astra-advisor` invocations bypass preflight and are unsupported when model freshness must be guaranteed. The launcher uses `codex debug models`, checks the named profile overlay, and updates only its top-level `model` when the newest catalogued Astra supports `max`. Catalog errors, ambiguous Astra identifiers, unsupported `max`, or missing/unwritable profile settings block the advisor process.
- *As a Skill in an existing session*:
  ```
  $ codex
  > Use $astra-advisor to evaluate the architecture options below...
  ```

**In Pi:**
- *As a dedicated subagent*:
  ```javascript
  subagent({
    agent: "advisor-astra",
    task: "Situation: ... Constraints: ... Options: 1) Migrate to Postgres 2) Stay on SQLite with WAL Goal: High concurrency with zero devops overhead"
  })
  ```
- *As a skill*:
  ```
  /skill astra-advisor
  ```

#### Skill vs. Agent Behavior

Understanding the architectural distinction prevents false assumptions about safety and model guarantees:

| Dimension | In-Context Skill (`SKILL.md`) | Dedicated Agent / Profile (`advisor-astra.md` / `astra-advisor.config.toml`) |
|:---|:---|:---|
| **Context Isolation** | Shares the existing conversation context, previous tool outputs, and prompt history. | Executes in a fresh, isolated thread/turn (`--ephemeral` or isolated subagent context) with zero baggage. |
| **Tool Restrictions** | Soft behavioral instruction: advises the model not to mutate files or run tools. Tools remain accessible to the harness. | Hard architectural enforcement: Pi strips all tools (`tools: none`); Codex enforces `sandbox_mode = "read-only"` and `web_search = false`. |
| **Model & Thinking** | Inherits whatever model the active host session is running on. Instructs model to warn if thinking is disabled. | Preflights the installed Codex catalog, then uses the newest max-capable Astra with `model_reasoning_effort = "max"`. |
| **Execution Flow** | Can be queried iteratively, though instructed to return one-round structured advice. | Hard one-round boundary: brief in → decisive recommendation out → session concludes. |

#### Supported Capabilities and Limitations

- **Capabilities**:
  - Uncompromising trade-off analysis between 2 or more concrete architectural paths.
  - Identification of subtle second-order failures, lock-in risks, and operational costs.
  - Decisive, single-sentence recommendation with explicit confidence ratings (**High** / **Medium** / **Low**).
- **Limitations & Guardrails**:
  - **No implementation**: Strictly read-only; will not generate boilerplate or write code.
  - **No autonomous delegation**: Will never dispatch subagents or escalate model tiers without explicit user authorization.
  - **No guessing**: Incomplete briefs are rejected immediately with `❌ **Insufficient context.**`.

---

For provider/model setup, see [pi.dev docs](https://pi.dev).
