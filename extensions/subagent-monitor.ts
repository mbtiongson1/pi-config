import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface SubagentTaskState {
	callId: string;
	parentCallId: string;
	label: string;
	model: string;
	thinking: string;
	state: "queued" | "running" | "stalled" | "completed" | "failed" | "interrupted" | "timed_out" | "partial";
	startedAt: number;
	lastUpdateAt: number;
	endedAt?: number;
	duration?: string;
}

const KNOWN_MODELS: Record<string, string> = {
	"gemini-3.8-flash": "Gemini 3.8 Flash",
	"gemini-3.5-flash-lite": "Gemini 3.5 Flash Lite",
	"gemini-3.1-pro": "Gemini 3.1 Pro",
	"claude-opus-5-5": "Claude Opus 5.5",
	"claude-sonnet-5-5": "Claude Sonnet 5.5",
	"claude-opus-4-6": "Claude Opus 4.6",
	"claude-sonnet-4-6": "Claude Sonnet 4.6",
	"gpt-6-luna": "GPT-6 Luna",
	"gpt-6.1-sol": "GPT-6.1 Sol",
	"gpt-6-astra": "GPT-6 Astra",
	"gpt-5.6-terra": "GPT-5.6 Terra",
	"gpt-5.6-sol": "GPT-5.6 Sol",
	"gpt-5.6-luna": "GPT-5.6 Luna",
};

function formatModelDisplay(modelStr?: string): string {
	if (!modelStr || modelStr === "unknown" || modelStr === "") return "unknown";
	const clean = modelStr.split(":").shift() ?? modelStr;
	const [providerPart, modelPartRaw] = clean.includes("/") ? clean.split("/", 2) : ["", clean];
	const modelId = modelPartRaw ?? clean;
	const friendly = KNOWN_MODELS[modelId] || modelId.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
	if (providerPart) {
		return `${providerPart}/${modelId} (${friendly})`;
	}
	return `${modelId} (${friendly})`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h${remainingMinutes.toString().padStart(2, "0")}m`;
}

const DESIRED_SUBAGENT_CONFIG = {
	defaultTimeoutMs: 1800000,
	stallAfterMs: 300000,
	stallKillAfterMs: 0,
	maxActiveProcesses: 4,
	maxGlobalActive: 16,
	maxQueuedTasks: 32,
	graceTurns: 2,
};

function ensureSubagentConfig(): void {
	const subagentConfigPath = join(homedir(), ".pi", "subagent.json");
	try {
		let currentConfig: Record<string, any> = {};
		if (existsSync(subagentConfigPath)) {
			currentConfig = JSON.parse(readFileSync(subagentConfigPath, "utf-8"));
		}
		let changed = false;
		for (const [k, v] of Object.entries(DESIRED_SUBAGENT_CONFIG)) {
			if (currentConfig[k] !== v) {
				currentConfig[k] = v;
				changed = true;
			}
		}
		if (changed || !existsSync(subagentConfigPath)) {
			writeFileSync(subagentConfigPath, JSON.stringify(currentConfig, null, 2) + "\n", "utf-8");
		}
	} catch {}
}

export default function subagentMonitorExtension(pi: ExtensionAPI): void {
	const activeTasks = new Map<string, SubagentTaskState>();
	const requestedAgents = new Map<string, string[]>();
	let recentTerminal: SubagentTaskState | null = null;
	let recentTerminalTimer: NodeJS.Timeout | null = null;
	let ticker: NodeJS.Timeout | null = null;
	let currentContext: ExtensionContext | null = null;

	ensureSubagentConfig();

	function renderStatus(theme: any): string {
		const now = Date.now();
		const runningList: SubagentTaskState[] = [];

		for (const task of activeTasks.values()) {
			if (task.state === "running" && now - task.lastUpdateAt > 300000) {
				task.state = "stalled";
			}
			runningList.push(task);
		}

		if (runningList.length > 0) {
			const displays = runningList.map((task) => {
				const elapsed = formatDuration(now - task.startedAt);
				const parts = [
					theme.fg("accent", task.agent || task.label),
					theme.fg("dim", formatModelDisplay(task.model)),
					task.thinking && task.thinking !== "off" ? theme.fg("dim", `[${task.thinking}]`) : "",
					task.state === "running"
						? theme.fg("accent", "running")
						: task.state === "stalled"
						? theme.fg("warning", "stalled")
						: theme.fg("dim", task.state),
					theme.fg("dim", elapsed),
				].filter(Boolean);
				return parts.join(theme.fg("dim", " · "));
			});

			if (displays.length === 1) return displays[0];
			const first = displays[0];
			const extraLabels = runningList.slice(1).map((task) => task.label).join(", ");
			const extra = ` (+${displays.length - 1}: ${extraLabels})`;
			return `${first}${theme.fg("dim", extra)}`;
		}

		if (recentTerminal && now - (recentTerminal.endedAt || now) < 5000) {
			const task = recentTerminal;
			const parts = [
				theme.fg("text", task.label),
				task.model ? theme.fg("dim", formatModelDisplay(task.model)) : "",
				task.thinking && task.thinking !== "off" ? theme.fg("dim", task.thinking) : "",
				task.state === "completed"
					? theme.fg("success", "completed")
					: task.state === "failed"
					? theme.fg("error", "failed")
					: task.state === "interrupted"
					? theme.fg("muted", "interrupted")
					: task.state === "timed_out"
					? theme.fg("warning", "timed_out")
					: theme.fg("warning", task.state),
				theme.fg("dim", task.duration ?? "0s"),
			].filter(Boolean);
			return parts.join(theme.fg("dim", " · "));
		}

		return "";
	}

	function updateStatusline(): void {
		if (!currentContext?.ui) return;
		const text = renderStatus(currentContext.ui.theme);
		currentContext.ui.setStatus("subagent-monitor", text || undefined);
		// Suppress generic unformatted subagent status when active
		if (text) {
			currentContext.ui.setStatus("subagent", undefined);
		}
	}

	function syncTaskResults(parentCallId: string, details: any): void {
		const results = details?.results;
		if (!Array.isArray(results) || results.length === 0) return;
		const parentTask = Array.from(activeTasks.values()).find((task) => task.parentCallId === parentCallId);
		const previousResults = results.map((_: unknown, index: number) => activeTasks.get(`${parentCallId}:${index}`));
		for (const [key, task] of activeTasks) {
			if (task.parentCallId === parentCallId) activeTasks.delete(key);
		}
		const now = Date.now();
		results.forEach((result: any, index: number) => {
			const state = result.state === "completed" ? "completed"
				: result.state === "partial" ? "partial"
				: result.state === "failed" || result.state === "lost" ? "failed"
				: result.state === "cancelled" ? "interrupted"
				: result.state === "timeout" ? "timed_out"
				: result.state === "queued" ? "queued" : "running";
			const key = `${parentCallId}:${index}`;
			const previous = previousResults[index];
			activeTasks.set(key, {
				callId: key,
				parentCallId,
				label: requestedAgents.get(parentCallId)?.[index] || result.label || `task-${index + 1}`,
				model: result.model || "",
				thinking: result.thinking || "",
				state,
				startedAt: previous?.startedAt ?? parentTask?.startedAt ?? now,
				lastUpdateAt: now,
			});
		});
	}

	function syncTicker(): void {
		const shouldTick = activeTasks.size > 0 || recentTerminal !== null;
		if (shouldTick && !ticker) {
			ticker = setInterval(() => {
				updateStatusline();
				if (activeTasks.size === 0 && !recentTerminal) {
					if (ticker) {
						clearInterval(ticker);
						ticker = null;
					}
					updateStatusline();
				}
			}, 1000);
			ticker.unref?.();
		} else if (!shouldTick && ticker) {
			clearInterval(ticker);
			ticker = null;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		ensureSubagentConfig();
		updateStatusline();
	});

	// Codemode prompt guidance hook: remove 60s timeout example from system prompt
	pi.on("before_agent_start", (event) => {
		let prompt = event.systemPrompt;
		const oldHeader = '// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}';
		const newHeader = '// @options: {"max_output_tokens": 10000}';
		if (prompt.includes(oldHeader)) {
			prompt = prompt.replace(
				oldHeader,
				`${newHeader} (execution has no default timeout; set timeout_ms only when an explicit deadline is needed)`
			);
		}
		const guidelineNote = "\n- Codemode scripts run without a timeout by default. Do not set timeout_ms unless an explicit execution deadline is requested.";
		if (!prompt.includes(guidelineNote)) {
			prompt = prompt.replace(
				"- Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.",
				`- Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.${guidelineNote}`
			);
		}
		return { systemPrompt: prompt };
	});

	// Codemode tool_call safety: omit cargo-culted 60s timeout unless explicitly asked
	pi.on("tool_call", (event) => {
		if (event.toolName === "subagent" && event.input) {
			const args = event.input as Record<string, any>;
			const prefixAgentLabel = (task: Record<string, any>) => {
				if (typeof task.agent !== "string" || typeof task.description !== "string" || !task.description) return;
				const prefix = `${task.agent} · `;
				if (!task.description.startsWith(prefix)) task.description = `${prefix}${task.description}`.slice(0, 60);
			};
			if (Array.isArray(args.tasks)) args.tasks.forEach(prefixAgentLabel);
			else prefixAgentLabel(args);
		}
		if (event.toolName === "codemode" && event.input && typeof event.input.code === "string") {
			const code = event.input.code;
			// Detect standard copied 60s header
			const pattern60s = /\/\/\s*@options:\s*\{[^}]*["']timeout_ms["']\s*:\s*60000[^}]*\}/;
			if (pattern60s.test(code)) {
				// Strip timeout_ms: 60000 while preserving max_output_tokens if present
				const sanitized = code.replace(pattern60s, (match) => {
					return match.replace(/,?\s*["']timeout_ms["']\s*:\s*60000/, "").replace(/["']timeout_ms["']\s*:\s*60000\s*,?/, "");
				});
				event.input.code = sanitized;
			}
		}
	});

	// Subagent execution tracking
	pi.on("tool_execution_start", (event, ctx) => {
		currentContext = ctx;
		if (event.toolName === "subagent") {
			const args = event.args || {};
			requestedAgents.set(event.toolCallId, Array.isArray(args.tasks)
				? args.tasks.map((item: any) => typeof item?.agent === "string" ? item.agent : "")
				: [typeof args.agent === "string" ? args.agent : ""]);
			const taskState: SubagentTaskState = {
				callId: event.toolCallId,
				parentCallId: event.toolCallId,
				label: "subagent",
				model: "",
				thinking: "",
				state: "running",
				startedAt: Date.now(),
				lastUpdateAt: Date.now(),
			};
			activeTasks.set(event.toolCallId, taskState);
			syncTicker();
			updateStatusline();
		}
	});

	pi.on("tool_execution_update", (event, ctx) => {
		currentContext = ctx;
		if (event.toolName === "subagent") {
			const task = Array.from(activeTasks.values()).find((entry) => entry.parentCallId === event.toolCallId);
			if (task) {
				task.lastUpdateAt = Date.now();
				syncTaskResults(event.toolCallId, event.partialResult?.details);
				updateStatusline();
			}
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		currentContext = ctx;
		if (event.toolName === "subagent") {
			const task = Array.from(activeTasks.values()).find((entry) => entry.parentCallId === event.toolCallId);
			const duration = formatDuration(event.durationMs ?? (task ? Date.now() - task.startedAt : 0));
			syncTaskResults(event.toolCallId, event.result?.details);
			let state: SubagentTaskState["state"] = event.isError ? "failed" : "completed";

			if (event.result?.details?.state) {
				const s = event.result.details.state;
				if (s === "cancelled") state = "interrupted";
				else if (s === "timeout") state = "timed_out";
				else if (s === "partial") state = "partial";
				else if (s === "failed") state = "failed";
				else if (s === "completed") state = "completed";
			}

			const finalTask = Array.from(activeTasks.values()).find((entry) => entry.parentCallId === event.toolCallId) ?? task;
			if (finalTask) {
				if (!event.result?.details?.results?.length) finalTask.state = state;
				finalTask.endedAt = Date.now();
				finalTask.duration = duration;
				for (const [key, entry] of activeTasks) {
					if (entry.parentCallId === event.toolCallId) activeTasks.delete(key);
				}
				requestedAgents.delete(event.toolCallId);

				recentTerminal = { ...finalTask };
				if (recentTerminalTimer) clearTimeout(recentTerminalTimer);
				recentTerminalTimer = setTimeout(() => {
					recentTerminal = null;
					syncTicker();
					updateStatusline();
				}, 5000);
				recentTerminalTimer.unref?.();
			}
			syncTicker();
			updateStatusline();
		}
	});
}
