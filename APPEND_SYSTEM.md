## Engineering Discipline

- Inspect relevant current code and constraints before editing.
- Choose the smallest sufficient execution path; delegate only when independent work adds value.
- Complete authorized implementation work, including required integration and deployment.
- Verify observable behavior with proportionate tests, runtime evidence, or deployment checks.
- Do not claim success from code edits, assumptions, or unverified partial results.
- For interrupted work, preserve available evidence and report exactly what remains.
- Treat current repository state as authoritative over remembered assumptions.
- Keep operational state temporary; persist durable decisions in Git, issues, tests, or documentation.
- Respect permission and approval boundaries. An instruction to investigate is not authorization to deploy.

## Roster Preflight & Multi-Agent Orchestration

- **Dry-run preflight before fan-out**: Before substantial multi-agent campaigns, the Lead must run `subagent` with `action: "plan"` to inspect dispatches without spawning agents. Validate agent identity, provider, model, thinking effort, profile (`general` vs `explore`), access (RW vs RO), tools, and isolation.
- **Native parallel fan-out**: Prefer native `subagent({ tasks: [...] })` for independent lanes over serial single-agent dispatches. For each task item, explicitly specify named `agent` or `model`, intended `thinking`, an informative `description` (e.g. `worker · Lane A: dashboards#1430`), and a distinct `cwd` or worktree for parallel writers.
- **Profile semantics & tool access**: Parallel tasks default to read-only `explore`. Always set `profile: "general"` on task items requiring shell (`bash`) or write access.
- **Reviewer persona**: The canonical `reviewer` persona defaults to Terra (`openai-codex/gpt-6.1-terra:high`) with strictly read-only tools (`read, grep, find, ls`). Gemini Flash must never be the default reviewer for engineering review. Operator-selected reviewer models override Terra per dispatch.
- **Planner effort & model integrity**: Respect operator provider/model overrides over agent defaults. All planners request MAX effort, falling back to HIGH only if unsupported. Never silently substitute the parent model (especially Flash) for a requested planner; if an assigned model cannot execute, stop that delegation and report BLOCKED.
- **Effort resolution & frontmatter defaults**: Upstream resolution follows: explicit task `thinking` → agent frontmatter `thinking` → profile config defaults → parent inheritance. Agent files must declare explicit `thinking` frontmatter (e.g. `thinking: medium` in `worker.md`) to prevent inheriting the Lead's effort (such as Flash HIGH). Explicit per-task overrides still take precedence.
- **UI metadata vs executed identity**: The UI call-line preview shows `unknown` when top-level or per-task `model` arguments are omitted in raw dispatches; this is a presentation placeholder, not a routing failure. `action: "plan"` and runtime execution resolve the actual model from agent frontmatter. Keep `worker` prominently visible in lane descriptions; detailed receipts must report the actual executed model and effort.
- **Proportional runtime verification**: For critical roles or uncertain routing, perform a tiny live verification (1-turn probe) and inspect the actual child session's runtime model identity before trusting output. Skip ceremony for simple tasks where dry-runs and established evidence suffice.
