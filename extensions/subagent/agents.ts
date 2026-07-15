/**
 * Agent discovery, role templates, and configuration resolution.
 *
 * ## Role Templates
 * Users configure `~/.pi/agent/agent-templates.json` to map role names
 * (planner, worker, scout, reviewer, …) to model + thinkingLevel.
 * Agent `.md` files declare `role: planner` instead of hardcoding a model —
 * the template supplies the infrastructure; the agent supplies the behaviour.
 *
 * Built-in thinking-level defaults (no model — must be set in your templates):
 *   planner  → high
 *   worker   → medium
 *   scout    → minimal
 *   reviewer → low
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

// ─── Role Templates ───────────────────────────────────────────────────────────

export interface RoleTemplate {
	/** pi model string, e.g. "anthropic--claude-4.8-opus" */
	model?: string;
	/** pi thinking level: off | minimal | low | medium | high | xhigh | max */
	thinkingLevel?: string;
}

export type RoleTemplates = Record<string, RoleTemplate>;

/** Built-in thinking-level defaults. No model defaults — those are user-configured. */
const BUILTIN_ROLE_DEFAULTS: RoleTemplates = {
	planner:  { thinkingLevel: "high" },
	worker:   { thinkingLevel: "medium" },
	scout:    { thinkingLevel: "minimal" },
	reviewer: { thinkingLevel: "low" },
};

/**
 * Load role templates from `<agentDir>/agent-templates.json`, merged over
 * built-in defaults. User values win field-by-field per role.
 */
export function loadTemplates(agentDir?: string): RoleTemplates {
	const dir = agentDir ?? getAgentDir();
	const templatePath = path.join(dir, "agent-templates.json");
	let userTemplates: RoleTemplates = {};
	try {
		const raw = fs.readFileSync(templatePath, "utf-8");
		userTemplates = JSON.parse(raw) as RoleTemplates;
	} catch {
		// File missing or unparseable — use built-in defaults only.
	}
	const merged: RoleTemplates = {};
	const allRoles = new Set([
		...Object.keys(BUILTIN_ROLE_DEFAULTS),
		...Object.keys(userTemplates),
	]);
	for (const role of allRoles) {
		merged[role] = { ...(BUILTIN_ROLE_DEFAULTS[role] ?? {}), ...(userTemplates[role] ?? {}) };
	}
	return merged;
}

/** The resolved model + thinkingLevel for an agent after applying its role template. */
export interface ResolvedAgentConfig {
	model?: string;
	thinkingLevel?: string;
	/** The role label, if declared in the agent file (used for display). */
	roleLabel?: string;
}

/**
 * Resolve the effective model and thinkingLevel for an agent.
 * Priority: explicit frontmatter field > role template > nothing.
 */
export function resolveEffectiveConfig(
	agent: AgentConfig,
	templates: RoleTemplates,
): ResolvedAgentConfig {
	const template: RoleTemplate = agent.role ? (templates[agent.role] ?? {}) : {};
	return {
		model: agent.model ?? template.model,
		thinkingLevel: agent.thinkingLevel ?? template.thinkingLevel,
		roleLabel: agent.role,
	};
}

// ─── Agent Config ─────────────────────────────────────────────────────────────

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	/** Explicit model override. When absent, resolved from the role template. */
	model?: string;
	/**
	 * Role template name (planner | worker | scout | reviewer | custom).
	 * Provides model + thinkingLevel defaults from agent-templates.json.
	 */
	role?: string;
	/**
	 * Explicit thinking-level override.
	 * When absent, resolved from the role template or built-in defaults.
	 */
	thinkingLevel?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			role: frontmatter.role,
			thinkingLevel: frontmatter.thinking_level ?? frontmatter.thinkingLevel,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents    = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();
	if (scope === "both") {
		for (const a of userAgents)    agentMap.set(a.name, a);
		for (const a of projectAgents) agentMap.set(a.name, a);
	} else if (scope === "user") {
		for (const a of userAgents) agentMap.set(a.name, a);
	} else {
		for (const a of projectAgents) agentMap.set(a.name, a);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed    = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
