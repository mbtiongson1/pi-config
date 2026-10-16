// argon-stall-guard.ts
//
// Durable, upgrade-safe protection for Gemini 4 Argon ("gemini-4-argon") stream stalls in Pi.
//
// Problem:
//   During extended thinking, Gemini 4 Argon can legitimately pause SSE chunk emission
//   for >120s between reasoning steps. pi-antigravity defaults to STREAM_STALL_TIMEOUT_DEFAULT_MS=120_000,
//   aborting valid reasoning runs with: "Error: stream stalled: no data for 120000ms".
//
// Solution:
//   1. Target 300 seconds (300,000ms) of stream inactivity for Argon via the provider's
//      official ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS configuration option.
//   2. Maintain an independent finite request header deadline (180,000ms default via
//      ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS) so actual dead connections terminate predictably.
//   3. Structured, credential-redacted diagnostics to distinguish:
//      - provider_silence: upstream server silent during extended reasoning
//      - network_disconnection: TCP reset / socket drop / fetch failed
//      - process_termination: SIGKILL / SIGTERM / abnormal process exit
//      - timeout: request header deadline or connect timeout exceeded
//   4. Safe recovery: Retries ONLY when demonstrably safe (pure reasoning prior to any
//      tool dispatch). NEVER blindly replays tool calls or non-idempotent writes (edit, write, bash).
//   5. Invariants: Never escalates models, never changes thinking effort, unbounded subagent turns.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export type FailureCategory =
	| "provider_silence"
	| "network_disconnection"
	| "process_termination"
	| "timeout"
	| "other";

export interface ArgonDiagnostic {
	id: string;
	timestamp: string;
	category: FailureCategory;
	model: string;
	thinkingLevel: string;
	error: string;
	durationMs?: number;
	tokensReceived?: number;
	safeToRecover: boolean;
	unrecoverableReason?: string;
	toolCallsAttempted?: number;
	recoveryActionTaken?: "retry" | "none";
}

export interface ArgonStallGuardSettings {
	enabled?: boolean;
	stallTimeoutMs?: number;
	headerTimeoutMs?: number;
	maxRetries?: number;
	promptText?: string;
	verbose?: boolean;
}

const CUSTOM_TYPE = "argon-stall-guard";
const DEFAULT_STALL_TIMEOUT_MS = 300_000; // 300 seconds (5 minutes)
const DEFAULT_HEADER_TIMEOUT_MS = 180_000; // 180 seconds (3 minutes)
const MAX_DIAGNOSTICS_HISTORY = 20;

export const state = {
	armed: true,
	stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
	headerTimeoutMs: DEFAULT_HEADER_TIMEOUT_MS,
	maxRetries: 1, // Strictly bounded: max 1 safe retry
	promptText: "continue",
	verbose: true,
	attempts: 0,
	lastError: "",
	diagnosticsHistory: [] as ArgonDiagnostic[],
};

/** Redact credentials, auth headers, and API keys from error messages. */
export function redactSecrets(text: string): string {
	if (!text) return "";
	return text
		.replace(/\bya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted-access-token]")
		.replace(/\b1\/+[A-Za-z0-9_\/-]{20,}/g, "[redacted-refresh-token]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
		.replace(/\b(?:gho|ghp|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}/g, "[redacted-github-token]")
		.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[redacted-api-key]")
		.replace(
			/("?(?:access_token|refresh_token|id_token|token|client_secret|authorization|apiKey|key)"?\s*[:=]\s*")[^"]*(")/gi,
			"$1[redacted]$2",
		)
		.replace(
			/("?(?:access_token|refresh_token|id_token|token|client_secret|authorization|apiKey|key)"?\s*[:=]\s*)[^\s&,}]+/gi,
			"$1[redacted]",
		);
}

/** Classify error into one of the 4 required failure categories. */
export function classifyStreamFailure(errorMessage: string): FailureCategory {
	const text = (errorMessage || "").toLowerCase();

	// 1. Provider silence: headers arrived, connection established, but SSE stream stalled
	if (text.includes("stream stalled") || text.includes("no data for") || text.includes("inactivity")) {
		return "provider_silence";
	}

	// 2. Network disconnection: socket drop, TCP reset, DNS failure, aborted fetch
	if (
		text.includes("econnreset") ||
		text.includes("epipe") ||
		text.includes("etimedout") ||
		text.includes("und_err_socket") ||
		text.includes("socket hang up") ||
		text.includes("socketerror") ||
		text.includes("fetch failed") ||
		text.includes("network error") ||
		text.includes("enotfound") ||
		text.includes("err_stream_premature_close")
	) {
		return "network_disconnection";
	}

	// 3. Process termination: abnormal exit, OS signals (SIGKILL / 137, SIGTERM / 143, SIGSEGV / 139)
	if (
		text.includes("sigkill") ||
		text.includes("sigterm") ||
		text.includes("sigint") ||
		text.includes("sigsegv") ||
		text.includes("exit code 137") ||
		text.includes("exit code 139") ||
		text.includes("exit code 143") ||
		text.includes("worker terminated") ||
		text.includes("process exited unexpectedly")
	) {
		return "process_termination";
	}

	// 4. Timeout: request header deadline, connect timeout, explicit overall deadline
	if (
		text.includes("no response headers within") ||
		text.includes("timed out") ||
		text.includes("timeout") ||
		text.includes("deadline exceeded")
	) {
		return "timeout";
	}

	return "other";
}

/** Determine whether an operation is demonstrably safe to retry. */
export function evaluateRecoverySafety(
	failedMessage: any,
	context: any,
	currentModelId: string,
): { safe: boolean; reason: string; toolCallsCount: number } {
	const model = failedMessage?.model || currentModelId || "";

	// Check if this is an Argon model
	const isArgon = model.includes("argon");
	if (!isArgon) {
		return {
			safe: false,
			reason: `Model "${model}" is not gemini-4-argon; automatic recovery restricted to Argon reasoning runs.`,
			toolCallsCount: 0,
		};
	}

	// Check for any toolCall blocks in the failed assistant message
	const content = failedMessage?.content;
	let toolCallsCount = 0;
	if (Array.isArray(content)) {
		for (const part of content) {
			if (part && part.type === "toolCall") {
				toolCallsCount++;
			}
		}
	}

	// NEVER replay if the message requested or contained tool calls
	if (toolCallsCount > 0) {
		return {
			safe: false,
			reason: `Failed turn contains ${toolCallsCount} toolCall block(s). Blind replay is refused to prevent duplicate tool execution or non-idempotent writes.`,
			toolCallsCount,
		};
	}

	// Check if any tool results exist in the turn
	const toolResults = context?.toolResults || [];
	if (Array.isArray(toolResults) && toolResults.length > 0) {
		return {
			safe: false,
			reason: `Turn already emitted ${toolResults.length} tool result(s). Replaying could duplicate subsequent actions.`,
			toolCallsCount,
		};
	}

	// Check error classification
	const errorText = failedMessage?.errorMessage || "";
	const category = classifyStreamFailure(errorText);

	if (category !== "provider_silence" && category !== "network_disconnection" && category !== "timeout") {
		return {
			safe: false,
			reason: `Error category "${category}" is not an eligible transient streaming failure.`,
			toolCallsCount,
		};
	}

	// All checks pass: turn was in pure reasoning before any tool call was emitted
	return {
		safe: true,
		reason: "Turn failed during reasoning/thinking prior to any tool call dispatch. No side-effects occurred.",
		toolCallsCount: 0,
	};
}

let api: ExtensionAPI;
let settingsLoaded = false;

function loadSettings(): void {
	if (settingsLoaded) return;
	settingsLoaded = true;
	const raw = api?.getSettings?.() as unknown as Record<string, unknown> | undefined;
	const cfg = (raw?.["argonStallGuard"] ?? {}) as ArgonStallGuardSettings;
	if (typeof cfg.enabled === "boolean") state.armed = cfg.enabled;
	if (typeof cfg.stallTimeoutMs === "number" && cfg.stallTimeoutMs > 0) {
		state.stallTimeoutMs = cfg.stallTimeoutMs;
	}
	if (typeof cfg.headerTimeoutMs === "number" && cfg.headerTimeoutMs > 0) {
		state.headerTimeoutMs = cfg.headerTimeoutMs;
	}
	if (typeof cfg.maxRetries === "number" && cfg.maxRetries >= 0) {
		state.maxRetries = cfg.maxRetries;
	}
	if (typeof cfg.promptText === "string" && cfg.promptText.trim()) {
		state.promptText = cfg.promptText;
	}
	if (typeof cfg.verbose === "boolean") state.verbose = cfg.verbose;
}

/** Apply environment variables to ensure pi-antigravity uses 300s stall watchdog. */
export function applyArgonTimeouts(isArgon = true): void {
	const targetStall = isArgon ? String(state.stallTimeoutMs) : process.env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS || String(state.stallTimeoutMs);
	process.env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS = targetStall;
	if (!process.env.ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS) {
		process.env.ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS = String(state.headerTimeoutMs);
	}
}

function recordDiagnostic(diag: ArgonDiagnostic): void {
	state.diagnosticsHistory.unshift(diag);
	if (state.diagnosticsHistory.length > MAX_DIAGNOSTICS_HISTORY) {
		state.diagnosticsHistory.pop();
	}
}

function findFailedAssistantMessage(context: { contextMessages?: unknown[]; pendingMessages?: unknown[] } | undefined): any {
	const messages = [...(context?.contextMessages ?? []), ...(context?.pendingMessages ?? [])];
	for (let i = messages.length - 1; i >= 0 && i >= messages.length - 5; i--) {
		const m = messages[i] as any;
		if (m && m.role === "assistant" && m.stopReason === "error") {
			return m;
		}
	}
	return undefined;
}

export default function argonStallGuard(pi: ExtensionAPI): void {
	api = pi;

	// Ensure timeouts on extension load
	applyArgonTimeouts(true);

	pi.on("session_start", () => {
		loadSettings();
		applyArgonTimeouts(true);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		loadSettings();
		const currentModel = ctx?.getModel?.();
		const isArgon = currentModel?.id?.includes("argon") ?? true;
		applyArgonTimeouts(isArgon);
		state.attempts = 0;
		state.lastError = "";
	});

	pi.on("turn_start", (_event, ctx) => {
		const currentModel = ctx?.getModel?.();
		const isArgon = currentModel?.id?.includes("argon") ?? true;
		applyArgonTimeouts(isArgon);
	});

	pi.on("turn_end", (event) => {
		const m = event.message as any;
		if (m && m.role === "assistant" && m.stopReason !== "error") {
			state.attempts = 0;
		}
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (!state.armed) return;
		if (event.outcome !== "error") return;

		const failedMessage = findFailedAssistantMessage(event.context);
		if (!failedMessage) return;

		const rawError = failedMessage.errorMessage || "Unknown stream error";
		const redactedError = redactSecrets(rawError);
		const category = classifyStreamFailure(rawError);
		const currentModel = ctx?.getModel?.();
		const modelId = failedMessage.model || currentModel?.id || "unknown";
		const thinkingLevel = ctx?.getThinkingLevel?.() || "default";

		const safety = evaluateRecoverySafety(failedMessage, event.context, modelId);

		const diagnostic: ArgonDiagnostic = {
			id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			timestamp: new Date().toISOString(),
			category,
			model: modelId,
			thinkingLevel: String(thinkingLevel),
			error: redactedError,
			durationMs: failedMessage.durationMs,
			tokensReceived: failedMessage.usage?.output || 0,
			safeToRecover: safety.safe,
			unrecoverableReason: safety.safe ? undefined : safety.reason,
			toolCallsAttempted: safety.toolCallsCount,
			recoveryActionTaken: "none",
		};

		recordDiagnostic(diagnostic);
		state.lastError = redactedError;

		if (!safety.safe) {
			if (state.verbose) {
				ctx.ui?.notify?.(
					`[Argon Guard] ${category.toUpperCase()} on ${modelId} (${thinkingLevel}): ${safety.reason}`,
					"warning",
				);
			}
			return;
		}

		// Strictly bounded retries
		if (state.attempts >= state.maxRetries) {
			if (state.verbose) {
				ctx.ui?.notify?.(
					`[Argon Guard] Max safe recovery attempts reached (${state.maxRetries}) for ${modelId}. Halting turn.`,
					"warning",
				);
			}
			state.attempts = 0;
			return;
		}

		state.attempts += 1;
		diagnostic.recoveryActionTaken = "retry";

		if (state.verbose) {
			ctx.ui?.notify?.(
				`[Argon Guard] Detected ${category} during pure reasoning (${failedMessage.durationMs ? `${Math.round(failedMessage.durationMs / 1000)}s` : "stream"}). Safe recovery attempt ${state.attempts}/${state.maxRetries} on ${modelId}:${thinkingLevel}.`,
				"info",
			);
		}

		// Inject continuation prompt to resume reasoning safely with identical model and thinking effort
		return {
			continue: true,
			entries: [
				{
					type: "custom_message" as const,
					customType: CUSTOM_TYPE,
					content: state.promptText,
					display: true,
					details: {
						attempt: state.attempts,
						maxRetries: state.maxRetries,
						diagnostic,
					},
				},
			],
		};
	});

	// Render the injected safe recovery prompt in the transcript
	pi.registerMessageRenderer(CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
		const details = message.details as { attempt?: number; maxRetries?: number; diagnostic?: ArgonDiagnostic } | undefined;
		const text = typeof message.content === "string" ? message.content : "";
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg("dim", "argon-guard")} ${theme.fg("accent", `> ${text}`)}`, 0, 0));
		if (expanded && details?.diagnostic) {
			const d = details.diagnostic;
			box.addChild(
				new Text(
					theme.fg(
						"dim",
						`  safe recovery ${details.attempt}/${details.maxRetries} after ${d.category} (${d.model}:${d.thinkingLevel})`,
					),
					0,
					0,
				),
			);
		}
		return box;
	});

	pi.registerCommand("argonguard", {
		description: "Gemini 4 Argon stream stall watchdog and safe recovery status (/argonguard [status|diag|on|off])",
		handler: async (args, ctx) => {
			loadSettings();
			const arg = args.trim().toLowerCase();

			if (arg === "on") {
				state.armed = true;
				applyArgonTimeouts(true);
				emitOutput(ctx, "Argon Stall Guard armed (watchdog: 300s, safe recovery enabled)", "info");
				return;
			}
			if (arg === "off") {
				state.armed = false;
				emitOutput(ctx, "Argon Stall Guard disarmed", "warning");
				return;
			}
			if (arg === "diag" || arg === "diagnostics") {
				if (state.diagnosticsHistory.length === 0) {
					emitOutput(ctx, "No stream diagnostics recorded yet in this session.", "info");
					return;
				}
				const report = state.diagnosticsHistory
					.slice(0, 5)
					.map((d, i) => {
						return `${i + 1}. [${d.category}] ${d.timestamp} model=${d.model} thinking=${d.thinkingLevel}\n   error: ${d.error}\n   safe=${d.safeToRecover}${d.unrecoverableReason ? ` (${d.unrecoverableReason})` : ""}`;
					})
					.join("\n\n");
				emitOutput(ctx, `Recent Argon Diagnostics:\n\n${report}`, "info");
				return;
			}

			// Default status
			const currentStall = process.env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS || "unset";
			const currentHeader = process.env.ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS || "unset";
			const status = [
				`Argon Stall Guard: ${state.armed ? "armed" : "disarmed"}`,
				`Watchdog Stall Timeout: ${state.stallTimeoutMs}ms (env: ${currentStall})`,
				`Header Deadline: ${state.headerTimeoutMs}ms (env: ${currentHeader})`,
				`Safe Recovery: ${state.maxRetries} retry max (tool execution replay blocked)`,
				`Diagnostics Count: ${state.diagnosticsHistory.length}`,
				state.lastError ? `Last Error: ${state.lastError}` : null,
			]
				.filter(Boolean)
				.join("\n• ");

			emitOutput(ctx, `• ${status}`, "info");
		},
	});
}

function emitOutput(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, type);
	} else if (type === "error" || type === "warning") {
		console.error(text);
	} else {
		console.log(text);
	}
}
