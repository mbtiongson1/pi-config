/**
 * Bunny provider routing — pure, dependency-free core.
 *
 * The Bunny family has a stable internal identity (`bunny/minimax-m3.1-flash`)
 * that never changes. The physical provider/model behind it is resolved at
 * invocation time, so the OpenRouter-free -> Vercel AI Gateway transition
 * never requires renaming or editing an agent definition.
 *
 * This module contains no Pi imports on purpose: it is the unit-testable
 * decision layer used by `extensions/bunny-router.ts`.
 *
 * Safety rules encoded here:
 *   - The clock is a routing preference, never permission to spend money.
 *   - A route is only usable when its provider has credentials, the model
 *     exists in the local catalog, and local authorization state allows it.
 *   - Nothing falls back to a paid route without explicit authorization.
 *   - Every failure returns an actionable blocker string.
 */

/** Virtual provider that owns the stable Bunny identity. */
export const BUNNY_VIRTUAL_PROVIDER = "bunny";

/** Stable Bunny model id. The physical provider is resolved per request. */
export const BUNNY_VIRTUAL_MODEL_ID = "minimax-m3.1-flash";

/** Fully qualified stable Bunny selection used by agent definitions. */
export const BUNNY_MODEL_REFERENCE = `${BUNNY_VIRTUAL_PROVIDER}/${BUNNY_VIRTUAL_MODEL_ID}`;

/**
 * Every thinking level Pi knows.
 * The virtual model offers all of them on purpose: if a level were missing,
 * Pi would silently clamp the selection before the route ever saw it. The
 * route is the authority that decides whether the physical model supports the
 * pinned level, and it fails with an explicit diagnostic instead.
 */
export const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Thinking levels the Bunny agent family pins.
 * `off` and `minimal` are intentionally excluded: the OpenRouter free route
 * maps both to `null` (unsupported), and the family requires an explicit
 * effort level on every invocation.
 */
export const BUNNY_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** ISO-8601 cutoff shared by the published promotional windows. */
export const PROMOTION_CUTOFF = "2026-10-22T12:00:00Z";

/**
 * Published route schedule.
 *
 * `freeGuarantee`:
 *   - "no-charge"  the route can never bill (OpenRouter `:free` variant).
 *   - "promotional" free only while the promotion runs and only for requests
 *     the vendor actually serves; account credit eligibility is personal.
 */
export const BUNNY_ROUTES = [
	{
		id: "openrouter-free",
		provider: "openrouter",
		model: "minimax/minimax-m3.1-flash:free",
		api: "openai-completions",
		baseUrl: "https://openrouter.ai/api/v1",
		freeUntil: PROMOTION_CUTOFF,
		freeGuarantee: "no-charge",
		requiresFreeVerification: false,
		credential: "OPENROUTER_API_KEY, or /login openrouter",
		reference: "mbtiongson1/pi-config#9",
		note: "OpenRouter `:free` variant — served at $0, cannot bill.",
		// Verified against the published Pi model catalog: the OpenRouter entry
		// maps off/minimal to null, so those levels are not supported.
		thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
		// Position in the published route sequence.
		scheduleOrder: 1,
	},
	{
		id: "vercel-ai-gateway",
		provider: "vercel-ai-gateway",
		model: "minimax/minimax-m3.1-flash",
		api: "anthropic-messages",
		baseUrl: "https://ai-gateway.vercel.sh",
		freeUntil: PROMOTION_CUTOFF,
		freeGuarantee: "promotional",
		requiresFreeVerification: true,
		credential: "AI_GATEWAY_API_KEY, or /login vercel-ai-gateway",
		reference: "mbtiongson1/pi-config#10",
		note: "Vercel AI Gateway — free while MiniMax serves the request; account credit eligibility is personal.",
		// The published Vercel entry declares no thinking-level map. MiniMax
		// requires a reasoning budget, so only the family levels are enabled.
		thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
		scheduleOrder: 2,
	},
];

/** Route lookup by id. */
export const BUNNY_ROUTE_BY_ID = Object.fromEntries(BUNNY_ROUTES.map((route) => [route.id, route]));

/**
 * The published route sequence.
 *
 * Each route carries its own `freeUntil`, because the promotions do not
 * necessarily end at the same moment. The sequence itself is fixed: a route
 * that is still inside its published free window is used first, and when no
 * route is free any more the successor provider in the sequence takes over.
 */
export const BUNNY_SCHEDULE = [...BUNNY_ROUTES].sort((left, right) => left.scheduleOrder - right.scheduleOrder);

/**
 * Normalize a date-ish value to epoch milliseconds.
 * A missing or unparseable value falls back to "now" — use it only for
 * evaluation time, never for a recorded verification timestamp.
 */
export function toEpochMs(value) {
	if (value === undefined || value === null) return Date.now();
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") return value;
	const parsed = Date.parse(String(value));
	return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Parse a recorded timestamp. Returns undefined when the value is missing or
 * unparseable, so a missing verification date can never be read as
 * "verified just now".
 */
export function parseTimestamp(value) {
	if (value === undefined || value === null || value === "") return undefined;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.getTime();
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	const parsed = Date.parse(String(value));
	return Number.isNaN(parsed) ? undefined : parsed;
}

/** Format an epoch value as an ISO-8601 UTC timestamp. */
export function toIso(value) {
	return new Date(toEpochMs(value)).toISOString();
}

/**
 * Ordered candidate list for a point in time.
 *
 * The route that is still inside its published free window comes first. When
 * no route is free any more, the successor provider in the published sequence
 * takes over. A caller may pin an explicit route id.
 */
export function orderRoutes(now, preferredRouteId) {
	if (preferredRouteId && BUNNY_ROUTE_BY_ID[preferredRouteId]) {
		return [
			BUNNY_ROUTE_BY_ID[preferredRouteId],
			...BUNNY_SCHEDULE.filter((route) => route.id !== preferredRouteId),
		];
	}
	const timestamp = toEpochMs(now);
	const stillFree = BUNNY_SCHEDULE.find((route) => timestamp < Date.parse(route.freeUntil));
	const scheduled = stillFree ?? BUNNY_SCHEDULE[BUNNY_SCHEDULE.length - 1];
	return [scheduled, ...BUNNY_SCHEDULE.filter((route) => route.id !== scheduled.id)];
}

/** The route that is scheduled for a point in time. */
export function scheduledRoute(now, preferredRouteId) {
	return orderRoutes(now, preferredRouteId)[0];
}

/** Local routing state for one route, if the device recorded any. */
function routeState(state, routeId) {
	const routes = state?.routing?.routes;
	return routes && typeof routes === "object" ? routes[routeId] ?? {} : {};
}

/** True when the local state explicitly disables Bunny on this device. */
export function isBunnyEnabled(state) {
	if (!state || typeof state !== "object") return true;
	if (state.enabled === false) return false;
	return state.routing?.enabled !== false;
}

/**
 * Thinking levels a physical model accepts.
 * A missing `thinkingLevelMap` means "provider defaults" — every level is fine.
 */
export function supportedThinkingLevels(model, route) {
	const verified = route?.thinkingLevels ?? BUNNY_THINKING_LEVELS;
	const map = model?.thinkingLevelMap;
	const live = !map || typeof map !== "object"
		? [...ALL_THINKING_LEVELS]
		: ALL_THINKING_LEVELS.filter((level) => map[level] !== null && map[level] !== undefined);
	// The route's verified list is the floor; a live map can only narrow it.
	return verified.filter((level) => live.includes(level));
}

/**
 * Check that a pinned thinking level is supported by the physical model.
 * Returns `{ ok: true }` or `{ ok: false, message }` — never a silent downgrade.
 */
export function checkThinkingLevel(model, level, route) {
	if (!level) {
		return { ok: false, message: "Bunny invocations must pin an explicit thinking level (low, medium, high, xhigh, max)." };
	}
	if (!ALL_THINKING_LEVELS.includes(level)) {
		return { ok: false, message: `Unknown thinking level "${level}". Valid levels: ${ALL_THINKING_LEVELS.join(", ")}.` };
	}
	const supported = supportedThinkingLevels(model, route);
	if (!supported.includes(level)) {
		const modelRef = `${model?.provider ?? "?"}/${model?.id ?? "?"}`;
		return {
			ok: false,
			message: `Thinking level "${level}" is not supported by ${modelRef}. Supported levels: ${supported.join(", ")}.`,
		};
	}
	return { ok: true };
}

/**
 * Spend guard for a route that can bill.
 *
 * A route may bill when it is not guaranteed free, or when paid use was
 * explicitly authorized. The cap must be configured and must not be reached;
 * a missing cap is a blocker, not an unlimited allowance.
 */
function checkSpendCap(state, routeId) {
	const spend = state?.routing?.spend;
	const cap = spend ? Number(spend.capUsd) : NaN;
	if (!Number.isFinite(cap) || cap < 0) {
		return {
			ok: false,
			message: `route "${routeId}" can bill, but no spend cap is configured. Set routing.spend.capUsd in the local device state before using it.`,
		};
	}
	const totalUsed = Number(spend?.usedUsd ?? 0);
	const routeUsed = Number(spend?.routes?.[routeId]?.usedUsd ?? 0);
	if (routeUsed >= cap || totalUsed >= cap) {
		return {
			ok: false,
			message: `Bunny spend cap reached for route "${routeId}" (cap $${cap}, used $${Math.max(routeUsed, totalUsed)}). Raise the cap explicitly or use a free route.`,
		};
	}
	return { ok: true };
}

/**
 * Evaluate one route.
 * Returns `{ ok: true, route }` or `{ ok: false, blocker }`.
 */
export function evaluateRoute(route, options) {
	const { now, state, catalog, credentials } = options;
	const timestamp = toEpochMs(now);
	const local = routeState(state, route.id);

	const model = catalog?.[route.provider]?.[route.model];
	if (!model) {
		return {
			ok: false,
			blocker: `route "${route.id}": model ${route.provider}/${route.model} is not in the local Pi catalog (run "pi update --models").`,
		};
	}

	const credential = credentials?.[route.provider];
	if (!credential || credential.configured !== true) {
		return {
			ok: false,
			blocker: `route "${route.id}": no credentials for provider "${route.provider}" (set ${route.credential}).`,
		};
	}

	const inFreeWindow = timestamp < Date.parse(route.freeUntil);
	const freeVerified = local.freeVerified === true;
	const paidAuthorized = local.paidAuthorized === true;

	if (route.requiresFreeVerification && !freeVerified && !paidAuthorized) {
		return {
			ok: false,
			blocker: `route "${route.id}": free-credit eligibility is not verified and paid use is not authorized. Verify Vercel AI Gateway credit eligibility, or authorize paid use explicitly.`,
		};
	}

	// A route can bill unless it is guaranteed free. Guard those with the
	// configured spend cap, whatever the authorization flags say.
	const mayBill = route.freeGuarantee !== "no-charge" || paidAuthorized;
	if (mayBill) {
		const spend = checkSpendCap(state, route.id);
		if (!spend.ok) return { ok: false, blocker: spend.message };
	}

	// A promotional route that is no longer inside its published free window
	// needs a verification dated after the window, or explicit paid use.
	// A missing or unparseable verification date counts as stale: it can
	// never be read as "verified just now".
	if (route.freeGuarantee === "promotional" && !inFreeWindow && freeVerified && !paidAuthorized) {
		const verifiedAt = parseTimestamp(local.verifiedAt);
		if (verifiedAt === undefined) {
			return {
				ok: false,
				blocker: `route "${route.id}": the free-credit verification has no timestamp. Re-verify credit eligibility, or authorize paid use.`,
			};
		}
		if (verifiedAt < Date.parse(route.freeUntil)) {
			return {
				ok: false,
				blocker: `route "${route.id}": the free-credit verification predates the ${route.freeUntil} promotion cutoff. Re-verify credit eligibility or authorize paid use.`,
			};
		}
	}

	return {
		ok: true,
		route: {
			id: route.id,
			provider: route.provider,
			model: route.model,
			api: route.api,
			baseUrl: route.baseUrl,
			thinkingLevels: [...(route.thinkingLevels ?? BUNNY_THINKING_LEVELS)],
			inFreeWindow,
			freeVerified,
			paidAuthorized,
		},
	};
}

/**
 * Resolve the physical route for a Bunny request.
 *
 * Fail-closed policy: the route that is scheduled for the current period is
 * the one that is used. If it is unusable — missing credential, model absent
 * from the catalog, unverified free credit, spend cap reached — routing fails
 * with an actionable error that names the exact blocker. A second route is
 * only tried when the local state explicitly allows a verified free fallback.
 *
 * @param {Object} input
 * @param {string|number|Date} input.now        Evaluation time (injectable for tests).
 * @param {Object|null} input.state             Local device routing state.
 * @param {Object} input.catalog                provider -> modelId -> model
 * @param {Object} input.credentials            provider -> { configured, source }
 * @param {string} [input.preferredRouteId]     Pin a route.
 * @param {string} [input.reason]               "user" | "continuation" | "retry" | "direct"
 * @param {Object} [input.previous]             { provider, model } of the last served turn
 * @returns {{ ok: boolean, route?: Object, blockers: string[], order: string[] }}
 */
export function resolveBunnyRoute(input) {
	const { now, state, catalog, credentials, preferredRouteId, reason, previous } = input ?? {};
	const blockers = [];
	const pinned = preferredRouteId ?? state?.routing?.preferredRouteId ?? undefined;
	const order = orderRoutes(now, pinned);

	if (!isBunnyEnabled(state)) {
		return {
			ok: false,
			order: order.map((route) => route.id),
			blockers: [
				"Bunny routing is disabled on this device. Enable it with: bash bin/device-models.sh enroll <device-id>.",
			],
		};
	}

	// An in-flight job keeps the provider that already served its turn, so a
	// route change never interrupts running work. A new dispatch re-evaluates
	// the schedule.
	const sticky = stickyRoute(reason, previous);
	if (sticky) {
		const decision = evaluateRoute(sticky, { now, state, catalog, credentials });
		if (decision.ok) {
			return {
				ok: true,
				route: decision.route,
				blockers,
				order: [sticky.id, ...order.filter((route) => route.id !== sticky.id).map((route) => route.id)],
			};
		}
		if (reason === "continuation") {
			// The job must finish on its original provider. Report the blocker
			// instead of silently moving it to another provider.
			return {
				ok: false,
				order: [sticky.id, ...order.filter((route) => route.id !== sticky.id).map((route) => route.id)],
				blockers: [
					`the in-flight job is bound to route "${sticky.id}" and cannot continue there: ${decision.blocker}`,
				],
			};
		}
		// A retry is a fresh attempt: if the previous route is gone, the
		// scheduled route is used instead.
		blockers.push(`route "${sticky.id}" is no longer usable: ${decision.blocker}`);
	}

	const allowFallback = state?.routing?.allowVerifiedFallback === true;
	const candidates = allowFallback ? order : [order[0]];

	for (const route of candidates) {
		const decision = evaluateRoute(route, { now, state, catalog, credentials });
		if (decision.ok) {
			return { ok: true, route: decision.route, blockers, order: order.map((item) => item.id) };
		}
		blockers.push(decision.blocker);
	}

	if (!allowFallback) {
		// Report every other route's state too, so the operator sees the full
		// picture without the router silently switching providers.
		for (const route of order.slice(1)) {
			const decision = evaluateRoute(route, { now, state, catalog, credentials });
			if (!decision.ok) {
				blockers.push(`route "${route.id}" is not used automatically: ${decision.blocker}`);
			}
		}
		blockers.push(
			`route "${order[1]?.id}" is not used automatically. Verify it and enable a verified free fallback explicitly if you want the scheduled route to fail over to it.`,
		);
	}

	return { ok: false, order: order.map((route) => route.id), blockers };
}

/**
 * The route that served the previous turn, when the current request should
 * stay on it (tool follow-ups and retries).
 */
export function stickyRoute(reason, previous) {
	if (reason !== "continuation" && reason !== "retry") return undefined;
	if (!previous?.provider || !previous?.model) return undefined;
	return BUNNY_ROUTES.find((route) => route.provider === previous.provider && route.model === previous.model);
}

/**
 * Accumulate a route's spend in the local state.
 * Returns the updated spend object; the caller persists it.
 */
export function recordSpend(spend, routeId, costUsd) {
	const amount = Number(costUsd);
	if (!Number.isFinite(amount) || amount <= 0) return spend;
	const next = { ...(spend ?? {}) };
	next.usedUsd = Number(next.usedUsd ?? 0) + amount;
	next.routes = { ...(next.routes ?? {}) };
	next.routes[routeId] = {
		...(next.routes[routeId] ?? {}),
		usedUsd: Number(next.routes[routeId]?.usedUsd ?? 0) + amount,
	};
	return next;
}

/**
 * Human-readable failure message that names every blocker.
 */
export function formatRouteFailure(result) {
	const lines = ["Bunny routing could not select a provider."];
	for (const blocker of result?.blockers ?? []) lines.push(`  - ${blocker}`);
	lines.push("No paid fallback is attempted automatically. Resolve the blocker above or authorize the route explicitly.");
	return lines.join("\n");
}
