// auto-continue: when a turn dies on a non-retryable transient error such as
// "Provider returned an empty response" (openrouter) or "Antigravity API
// returned an empty response", pi types a "continue" prompt into the agent and
// runs another turn.
//
// Why an extension is needed: pi's built-in retry only fires for errors whose
// text matches pi-ai's RETRYABLE_PROVIDER_ERROR_PATTERN (pi-ai/dist/utils/retry.js).
// Empty-response failures do not match, so those turns fail fast with no retry,
// regardless of the `retry.*` settings.
//
// Mechanism: the `agent_before_settle` boundary can append a session entry and
// request one more model request. A `custom_message` entry becomes a real user
// message in LLM context (core/messages.js convertToLlm maps role "custom" ->
// role "user"), so the agent receives a genuine "continue" prompt rather than a
// bare re-request.
//
// Commands:
//   /autocontinue            status
//   /autocontinue on|off     arm / disarm for this session
//   /autocontinue prompt     inject a "continue" prompt (default)
//   /autocontinue retry      silently re-request, no prompt injected
//   /autocontinue N          set the per-run retry budget
//   /autocontinue say <text> change the injected prompt text
//
// settings.json:
//   "autoContinue": { "enabled": true, "maxRetries": 3, "mode": "prompt",
//                     "promptText": "continue", "patterns": ["empty response"],
//                     "verbose": true }
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

/** Structural view of a message (pi does not export AgentMessage from the package root). */
type MessageLike = { role?: string; stopReason?: string; errorMessage?: string };

type Mode = "prompt" | "retry";

interface AutoContinueSettings {
	enabled?: boolean;
	maxRetries?: number;
	mode?: Mode;
	promptText?: string;
	patterns?: string[];
	verbose?: boolean;
}

const CUSTOM_TYPE = "auto-continue";

const DEFAULT_PATTERNS = [
	"empty response",
	"returned no content",
	"no content returned",
	"empty assistant message",
];

const state = {
	armed: true,
	maxRetries: 3,
	mode: "prompt" as Mode,
	promptText: "continue",
	patterns: DEFAULT_PATTERNS as string[],
	verbose: true,
	attempts: 0,
	lastError: "",
};

let api: ExtensionAPI;
let settingsLoaded = false;

function loadSettings(): void {
	// Only the first read wins, so `/autocontinue off` survives for the rest of
	// the session instead of being reset by settings on the next run. A `/reload`
	// re-imports this module and re-reads settings.
	if (settingsLoaded) return;
	settingsLoaded = true;
	const raw = api?.getSettings?.() as unknown as Record<string, unknown> | undefined;
	const cfg = (raw?.["autoContinue"] ?? {}) as AutoContinueSettings;
	if (typeof cfg.enabled === "boolean") state.armed = cfg.enabled;
	if (typeof cfg.maxRetries === "number" && cfg.maxRetries >= 0) state.maxRetries = cfg.maxRetries;
	if (cfg.mode === "prompt" || cfg.mode === "retry") state.mode = cfg.mode;
	if (typeof cfg.promptText === "string" && cfg.promptText.trim()) state.promptText = cfg.promptText;
	if (Array.isArray(cfg.patterns) && cfg.patterns.length > 0) state.patterns = cfg.patterns;
	if (typeof cfg.verbose === "boolean") state.verbose = cfg.verbose;
}

function isRetryableError(errorMessage: string): boolean {
	const text = errorMessage.toLowerCase();
	return state.patterns.some((p) => text.includes(p.toLowerCase()));
}

function errorOf(message: unknown): string | undefined {
	const m = message as MessageLike | undefined;
	if (!m || m.role !== "assistant") return undefined;
	if (m.stopReason !== "error") return undefined;
	return m.errorMessage || "Unknown error";
}

/**
 * Find the failed assistant message at a boundary.
 *
 * `context.pendingMessages` only holds queued and pending custom messages
 * (AgentSession._getPendingBoundaryMessages), so the errored assistant message
 * is never in it. The failed turn lives in `context.contextMessages`, with
 * pendingMessages checked as a fallback.
 */
function boundaryError(context: { contextMessages?: unknown[]; pendingMessages?: unknown[] } | undefined): string | undefined {
	const messages = [...(context?.contextMessages ?? []), ...(context?.pendingMessages ?? [])];
	for (let i = messages.length - 1; i >= 0 && i >= messages.length - 5; i--) {
		const error = errorOf(messages[i]);
		if (error) return error;
	}
	return undefined;
}

export default function autoContinue(pi: ExtensionAPI) {
	api = pi;
	// NOTE: settings cannot be read here. Action methods (including getSettings) throw
	// "Extension runtime not initialized" while the extension is being loaded, so
	// settings are read lazily from the first event that runs after startup.

	// A new user run resets the per-run retry budget.
	pi.on("before_agent_start", () => {
		loadSettings();
		state.attempts = 0;
		state.lastError = "";
	});

	// Any successful assistant message means the run recovered on its own.
	pi.on("turn_end", (event) => {
		if (!errorOf(event.message)) state.attempts = 0;
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (!state.armed) return;
		if (event.outcome !== "error") return;

		const error = boundaryError(event.context);
		if (!error || !isRetryableError(error)) return;

		// NOTE: `context.canContinue` is computed BEFORE drafts are applied, so it
		// reports false whenever the failed turn is the last message in context.
		// Appending the continue prompt (a custom_message entry, which becomes a
		// user message) is precisely what makes the context runnable again, so
		// this flag must not gate prompt mode.

		if (state.attempts >= state.maxRetries) {
			state.lastError = error;
			ctx.ui?.notify?.(
				`auto-continue: giving up after ${state.maxRetries} retr${state.maxRetries === 1 ? "y" : "ies"} (${error})`,
				"warning",
			);
			state.attempts = 0;
			return;
		}

		state.attempts += 1;
		state.lastError = error;
		if (state.verbose) {
			ctx.ui?.notify?.(
				`auto-continue: ${state.mode === "prompt" ? `sending "${state.promptText}"` : "retrying"} (${state.attempts}/${state.maxRetries}) after: ${error}`,
				"info",
			);
		}

		if (state.mode === "retry") {
			// A bare re-request only works when context does not already end on the
			// failed assistant message; otherwise fall back to the prompt, which
			// appends a user message and restores a runnable context.
			if (event.context?.canContinue === false) {
				ctx.ui?.notify?.("auto-continue: context ends on the failed turn, sending the continue prompt instead", "info");
			} else {
				return { continue: true };
			}
		}

		// Inject the continue prompt as a real user message and request one more turn.
		return {
			continue: true,
			entries: [
				{
					type: "custom_message" as const,
					customType: CUSTOM_TYPE,
					content: state.promptText,
					display: true,
					details: { attempt: state.attempts, maxRetries: state.maxRetries, error },
				},
			],
		};
	});

	// Render the injected prompt in the transcript so it reads as an automatic
	// "continue" rather than something the user typed.
	pi.registerMessageRenderer(CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
		const details = message.details as { attempt?: number; maxRetries?: number; error?: string } | undefined;
		const text = typeof message.content === "string" ? message.content : "";
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg("dim", "auto-continue")} ${theme.fg("accent", `> ${text}`)}`, 0, 0));
		if (expanded && details) {
			box.addChild(
				new Text(
					theme.fg("dim", `  retry ${details.attempt}/${details.maxRetries} after: ${details.error ?? "unknown error"}`),
					0,
					0,
				),
			);
		}
		return box;
	});

	pi.registerCommand("autocontinue", {
		description: "Auto-continue after empty-response errors (/autocontinue on|off|prompt|retry|N|say <text>)",
		handler: async (args, ctx) => {
			loadSettings();
			const arg = args.trim();
			const lower = arg.toLowerCase();

			if (lower === "on") state.armed = true;
			else if (lower === "off") state.armed = false;
			else if (lower === "prompt" || lower === "retry") state.mode = lower;
			else if (lower.startsWith("say ")) {
				const text = arg.slice(4).trim();
				if (text) state.promptText = text;
			} else if (/^\d+$/.test(lower)) state.maxRetries = Number.parseInt(lower, 10);
			else if (lower && lower !== "status") {
				const usage = "usage: /autocontinue [on|off|prompt|retry|N|say <text>|status]";
				if (ctx.hasUI) ctx.ui.notify(usage, "warning");
				else console.log(usage);
				return;
			}
			state.attempts = 0;

			const status = `auto-continue: ${state.armed ? "armed" : "disarmed"} (mode: ${state.mode}, max ${state.maxRetries}, prompt: "${state.promptText}", patterns: ${state.patterns.length})${
				state.lastError ? `, last error: ${state.lastError}` : ""
			}`;
			if (ctx.hasUI) ctx.ui.notify(status, "info");
			else console.log(status);
		},
	});
}
