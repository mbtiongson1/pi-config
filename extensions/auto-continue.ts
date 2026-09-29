// auto-continue: re-request the model when a turn fails with a non-retryable
// transient error such as "Antigravity API returned an empty response".
//
// Pi's built-in retry (settings `retry.*`) only retries errors whose text
// matches pi-ai's RETRYABLE_PROVIDER_ERROR_PATTERN. Empty-response errors do
// not match, so the turn fails fast. This extension hooks the
// `agent_before_settle` boundary and asks for one more model request.
//
// Per-session arming: /autocontinue [on|off|status|<maxRetries>]
// Defaults can be set in settings.json under "autoContinue".
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Structural view of an agent message (pi does not export AgentMessage from the package root). */
type MessageLike = { role?: string; stopReason?: string; errorMessage?: string };

interface AutoContinueSettings {
	enabled?: boolean;
	maxRetries?: number;
	/** Extra error substrings/regex sources to treat as retryable. */
	patterns?: string[];
	/** Send a short "continue where you left off" reminder with the retry. */
	nudge?: boolean;
	/** Show a notification for every automatic retry. */
	verbose?: boolean;
}

const DEFAULT_PATTERNS = [
	"empty response",
	"returned no content",
	"no content returned",
	"empty assistant message",
];

const state = {
	armed: true,
	maxRetries: 3,
	patterns: DEFAULT_PATTERNS as string[],
	nudge: false,
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
	if (Array.isArray(cfg.patterns) && cfg.patterns.length > 0) state.patterns = cfg.patterns;
	if (typeof cfg.nudge === "boolean") state.nudge = cfg.nudge;
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

		if (event.context?.canContinue === false) {
			ctx.ui?.notify?.("auto-continue: cannot continue (conversation ends on an assistant message)", "warning");
			return;
		}

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
			ctx.ui?.notify?.(`auto-continue: retrying (${state.attempts}/${state.maxRetries}) after: ${error}`, "info");
		}
		if (state.nudge) {
			return {
				continue: true,
				entries: [
					{
						type: "custom_message" as const,
						customType: "auto-continue",
						content: "Your previous response failed before completing. Continue where you left off.",
						display: true,
					},
				],
			};
		}
		return { continue: true };
	});

	pi.registerCommand("autocontinue", {
		description: "Arm/disarm automatic retry after empty-response errors (/autocontinue on|off|status|N)",
		handler: async (args, ctx) => {
			loadSettings();
			const arg = args.trim().toLowerCase();
			if (arg === "on") state.armed = true;
			else if (arg === "off") state.armed = false;
			else if (/^\d+$/.test(arg)) state.maxRetries = Number.parseInt(arg, 10);
			state.attempts = 0;

			const status = `auto-continue: ${state.armed ? "armed" : "disarmed"} (max ${state.maxRetries}, patterns: ${state.patterns.length})${
				state.lastError ? `, last error: ${state.lastError}` : ""
			}`;
			if (ctx.hasUI) ctx.ui.notify(status, "info");
			else console.log(status);
		},
	});
}
