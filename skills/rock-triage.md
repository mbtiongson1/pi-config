---
name: rock-triage
description: Triage, link, prioritize, and assign Rock RMS and Rock-related issues across repositories using subagent fan-out and structured impact/urgency rules.
version: 1.0.0
---

# Rock Triage Skill

Use this skill when triaging, auditing, linking, prioritizing, or assigning issues across any Rock RMS repositories (such as `rock-steward`, `rock-pages`, `rock-security`, `rock-dashboards`, or Rock plugins/integrations).

---

## 1. Core Rules & Classification Taxonomy

### A. Impact Sizing
Every triaged issue must have a concrete impact size based on blast radius, structural complexity, and data footprint:
- **`XS`** — Trivial / aesthetic fix, label correction, single config value, negligible blast radius.
- **`S`** — Minor scoped adjustment, single query predicate fix, isolated UI touch-up.
- **`M`** — Standard scoped task, single component/table schema fix, localized workflow fix.
- **`L`** — Cross-component feature or schema change, non-trivial data backfill, multi-surface impact.
- **`XL`** — Architecture-level refactor, multi-campus structural disparity, substantial data debt remediation.
- **`XXL`** — High-blast-radius initiative affecting global data models, core authentication, or site-wide parity.
- **`Epic`** — Top-level parent / umbrella initiative spanning multiple distinct sub-issues across domains.

### B. Priority & Urgency
Prioritize issues using the `P0`–`P3` matrix:
- **`P0`** — **Urgent & High Importance**: Critical blockers, security/auth exposure, active data corruption, PII leaks, or broken prod deployments. Must be addressed immediately.
- **`P1`** — **Important Update (Not Necessarily Urgent)**: High-impact architectural or schema debt, broken data contracts, or prerequisites blocking core milestone delivery.
- **`P2`** — **New Feature / Upgrade to Existing Feature**: Important enhancements to working features, structural improvements, or planned feature upgrades.
- **`P3`** — **New Feature / Nice-to-Have**: Backlog enhancements, exploratory designs, non-blocking sensors, or future capabilities.

### C. Preflight & Labeling Hygiene
- **Preflight Check**: Always query and inspect existing repository labels first via `gh label list`.
- **Zero Ad-Hoc Labels**: Strictly apply existing repository labels (domain labels e.g. `domain:schema`, `domain:org`, authority classes e.g. `class-b`, standard types e.g. `bug`, `documentation`). Do not invent new labels outside the standard taxonomy.
- **Label Idempotency**: If an issue or topic already has the appropriate priority (`P0`-`P3`) and size (`XS`-`Epic`) labels, **do not relabel**—only post necessary status updates.

---

## 2. Four-Step Triage Inspection Workflow

For every issue in scope, perform the following 4-step inspection:

1. **State & Relevance Assessment**:
   - Is the issue still ongoing, or has it already been resolved / superseded?
   - If resolved or obsolete, verify against codebase/PRs and recommend or execute closing with rationale.
2. **Status Update & Roadmap Timeline**:
   - Provide a concise technical comment/update on current state.
   - State whether work is scheduled to start soon, is blocked on prerequisites, or is in backlog.
3. **Linkage & Umbrella Synthesis**:
   - Identify shared domains and underlying dependencies across issues.
   - Connect related issues under an umbrella. If multiple related sub-issues exist without a parent, define or create an umbrella issue and tag as `Epic`.
4. **Issue Assignment**:
   - Default assignment: Assign to the **original issue creator**, unless someone is already explicitly assigned.
   - For newly identified or synthesized Epics/umbrellas, assign them to the owner of the constituent issues.

---

## 3. Subagent Fan-Out Orchestration

To maintain low latency and token efficiency:
- **Scout Fan-Out**: Delegate parallel reads and issue payload inspection to cost-efficient subagents (e.g. `scout`, `scout-lite`, or `scout-fast`).
- **Orchestrator Focus**: The main triage orchestrator aggregates findings, identifies semantic clusters, constructs umbrella links, and maintains prioritization.
- **Hallucination Verification**: Run a quick verification pass confirming referenced issue numbers, commit IDs, and existing label names before executing `gh issue edit` / `gh issue comment` commands.

---

## 4. Final Output Format

End every triage run with a consolidated **Prioritized Rock Issue Matrix**:

```markdown
# Rock Triage Summary

## 🚨 P0 — Urgent & Critical
- **#<number>** — <Title> | `<Size>` | Assigned: `@<assignee>` | Status: <Active/Blocked/Ongoing>
  - *Context / Umbrella*: <Link or umbrella reference>
  - *Next Action*: <Immediate step>

## ⚠️ P1 — Important Updates
- **#<number>** — <Title> | `<Size>` | Assigned: `@<assignee>` | Status: <Status>
  - *Context / Umbrella*: <Link or umbrella reference>

## 💡 P2 — Feature Upgrades & Enhancements
- **#<number>** — <Title> | `<Size>` | Assigned: `@<assignee>` | Status: <Status>

## 📋 P3 — New Features & Backlog
- **#<number>** — <Title> | `<Size>` | Assigned: `@<assignee>` | Status: <Status>

## 📦 Umbrella & Epic Structure
- **Epic: <Umbrella Title> (#<number>)** [Assigned: `@<assignee>`]
  - Sub-issues: #A, #B, #C
```
