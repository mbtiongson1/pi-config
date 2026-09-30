import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type CacheWarmingPolicy = "off" | "streaming" | "idle";

export interface PolicyResolution {
	policy: CacheWarmingPolicy;
	reason: string;
	source: "settings" | "rule" | "default";
}

/**
 * Check if the model matches an Antigravity Flash model.
 */
function isAntigravityFlash(provider: string, id: string): boolean {
	const prov = provider.toLowerCase();
	const mId = id.toLowerCase();
	const isAntigravity = prov.includes("antigravity") || prov === "google";
	const isFlash = mId.includes("flash");
	return isAntigravity && isFlash;
}

/**
 * Check if the model is gpt-6-luna.
 */
function isGpt6Luna(id: string): boolean {
	return id.toLowerCase().includes("gpt-6-luna");
}

/**
 * Match a glob/wildcard pattern like "antigravity/*flash*" or "*gpt-6-luna*".
 */
function matchWildcard(pattern: string, text: string): boolean {
	if (pattern === text) return true;
	if (!pattern.includes("*")) return pattern === text;
	const escaped = pattern.split("*").map((s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"));
	const regex = new RegExp(`^${escaped.join(".*")}$`, "i");
	return regex.test(text);
}

/**
 * Resolve the cache warming policy for a given model.
 */
export function resolveModelWarmingPolicy(
	model: { id?: string; provider?: string } | undefined,
	settings?: Record<string, any>,
): PolicyResolution {
	if (!model) {
		return { policy: "idle", reason: "No model selected (fallback to idle)", source: "default" };
	}

	const provider = (model.provider ?? "").toLowerCase();
	const id = (model.id ?? "").toLowerCase();
	const fullKey = `${provider}/${id}`;

	// 1. Check user-configured overrides in settings.json -> modelCacheWarming
	const customMap = settings?.modelCacheWarming as Record<string, string> | undefined;
	if (customMap && typeof customMap === "object") {
		for (const [pattern, rawPolicy] of Object.entries(customMap)) {
			const policy = rawPolicy.toLowerCase() as CacheWarmingPolicy;
			if (policy !== "off" && policy !== "streaming" && policy !== "idle") continue;

			if (matchWildcard(pattern, fullKey) || matchWildcard(pattern, id)) {
				return {
					policy,
					reason: `Matched settings.modelCacheWarming["${pattern}"]`,
					source: "settings",
				};
			}
		}
	}

	// 2. Canonical rules:
	// Flash / ultra-fast models (Antigravity Flash) -> streaming
	if (isAntigravityFlash(provider, id)) {
		return {
			policy: "streaming",
			reason: `Antigravity flash model (${fullKey}) -> streaming warming only (off during idle)`,
			source: "rule",
		};
	}

	// Luna / cheap workers (gpt-6-luna models only) -> streaming
	if (isGpt6Luna(id)) {
		return {
			policy: "streaming",
			reason: `gpt-6-luna model (${fullKey}) -> streaming warming only (off during idle)`,
			source: "rule",
		};
	}

	// 3. Default (Sol, Sonnet, Opus, unknown models) -> idle
	return {
		policy: "idle",
		reason: `Default policy for ${fullKey || "unrecognized model"} -> idle warming active`,
		source: "default",
	};
}

/**
 * Check if the session is currently idle between user turns.
 */
function isSessionIdle(
	event: { continuationProbability?: number },
	ctx: { isIdle?: () => boolean },
): boolean {
	if (typeof ctx.isIdle === "function") {
		return ctx.isIdle();
	}
	// Fall back to continuation probability heuristic (1 = streaming, 0.15 = idle)
	return typeof event.continuationProbability === "number" && event.continuationProbability < 1;
}

export default function modelCacheWarming(pi: ExtensionAPI): void {
	// Intercept cache warming decisions before Pi sends background keep-alive requests
	pi.on("cache_warming_decision", (event, ctx: ExtensionContext) => {
		const model = ctx.model;
		const settings = pi.getSettings?.() as unknown as Record<string, any> | undefined;
		const resolution = resolveModelWarmingPolicy(model, settings);

		// Policy: "off" -> unconditionally stop warming
		if (resolution.policy === "off") {
			return { action: "stop" };
		}

		// Policy: "streaming" -> allow during active streaming/turn runs, stop when idle
		if (resolution.policy === "streaming") {
			const idle = isSessionIdle(event, ctx);
			if (idle) {
				return { action: "stop" };
			}
			// While streaming, allow Pi's evaluated warming action to proceed
			return { action: event.action === "stop" ? "stop" : "warm" };
		}

		// Policy: "idle" -> allow warming both during streaming and while idle
		// Return Pi's evaluated economic action (or undefined to preserve decision)
		return undefined;
	});

	// Notify when model selection changes so the user is aware of the warming posture
	pi.on("model_select", (event, ctx: ExtensionContext) => {
		const settings = pi.getSettings?.() as unknown as Record<string, any> | undefined;
		const resolution = resolveModelWarmingPolicy(event.model, settings);
		if (ctx.hasUI && ctx.ui?.notify) {
			const label = `${event.model.provider}/${event.model.id}`;
			ctx.ui.notify(
				`Cache warming for ${label}: ${resolution.policy} (${resolution.reason})`,
				"info",
			);
		}
	});

	// Register /cachewarming command for inspection
	const handleStatus = async (_args: string, ctx: ExtensionCommandContext) => {
		const model = ctx.model;
		const settings = pi.getSettings?.() as unknown as Record<string, any> | undefined;
		const globalMode = settings?.cacheWarming ?? "idle";
		const resolution = resolveModelWarmingPolicy(model, settings);

		const fullId = model ? `${model.provider}/${model.id}` : "None";
		const statusText = [
			`Model Cache Warming:`,
			`  Active Model:   ${fullId}`,
			`  Resolved Policy: ${resolution.policy.toUpperCase()}`,
			`  Reason:         ${resolution.reason}`,
			`  Global Default: ${globalMode}`,
			``,
			`Policy behavior:`,
			`  - off:       Never warm cache`,
			`  - streaming: Warm during tool/turn execution only; stop when idle`,
			`  - idle:      Warm during streaming AND when idle waiting for user`,
		].join("\n");

		if (ctx.hasUI && ctx.ui?.notify) {
			ctx.ui.notify(
				`Cache Warming [${resolution.policy.toUpperCase()}]: ${resolution.reason}`,
				"info",
			);
		} else {
			console.log(statusText);
		}
	};

	pi.registerCommand("cachewarming", {
		description: "Display active model cache warming policy and status",
		handler: handleStatus,
	});

	pi.registerCommand("cachewarm", {
		description: "Alias for /cachewarming",
		handler: handleStatus,
	});
}
