/**
 * Bunny provider routing — behavioural test matrix.
 *
 * Run with:  node --test tests/bunny-router.test.mjs
 *
 * The matrix mirrors the acceptance table in the mission:
 *   - OpenRouter before cutoff      -> free Bunny selected
 *   - Vercel after cutoff           -> Vercel Bunny selected
 *   - missing credentials           -> clear error
 *   - no free-credit verification   -> no unauthorized paid dispatch
 *   - unsupported thinking level    -> explicit failure
 *   - job running across cutoff     -> completes on its original route
 *   - new job after cutoff          -> uses the new verified route
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	ALL_THINKING_LEVELS,
	BUNNY_ROUTES,
	BUNNY_THINKING_LEVELS,
	PROMOTION_CUTOFF,
	checkThinkingLevel,
	evaluateRoute,
	formatRouteFailure,
	orderRoutes,
	resolveBunnyRoute,
	stickyRoute,
	supportedThinkingLevels,
} from "../extensions/bunny-route.mjs";

const CUTOFF = Date.parse(PROMOTION_CUTOFF);
const BEFORE = new Date(CUTOFF - 60_000).toISOString();
const AFTER = new Date(CUTOFF + 60_000).toISOString();

const OPENROUTER_MODEL = {
	id: "minimax/minimax-m3.1-flash:free",
	provider: "openrouter",
	api: "openai-completions",
	reasoning: true,
};

const VERCEL_MODEL = {
	id: "minimax/minimax-m3.1-flash",
	provider: "vercel-ai-gateway",
	api: "anthropic-messages",
	reasoning: true,
};

function catalog(providers = ["openrouter", "vercel-ai-gateway"]) {
	const result = {};
	if (providers.includes("openrouter")) result.openrouter = { [OPENROUTER_MODEL.id]: OPENROUTER_MODEL };
	if (providers.includes("vercel-ai-gateway")) {
		result["vercel-ai-gateway"] = { [VERCEL_MODEL.id]: VERCEL_MODEL };
	}
	return result;
}

function credentials(providers = ["openrouter", "vercel-ai-gateway"]) {
	const result = {};
	for (const provider of providers) result[provider] = { configured: true, source: "stored" };
	return result;
}

/** Local device state with a Vercel route whose free credit was verified. */
function state({ vercelFreeVerified = true, vercelVerifiedAt = BEFORE, paidAuthorized = false } = {}) {
	return {
		version: 1,
		device: "macbook-air-m1",
		enabled: true,
		routing: {
			enabled: true,
			routes: {
				"openrouter-free": { available: true, freeVerified: true, verifiedAt: BEFORE, paidAuthorized: false },
				"vercel-ai-gateway": {
					available: true,
					freeVerified: vercelFreeVerified,
					verifiedAt: vercelFreeVerified ? vercelVerifiedAt : null,
					paidAuthorized,
				},
			},
			spend: { capUsd: 5, usedUsd: 0 },
		},
	};
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

test("before the cutoff OpenRouter free is preferred", () => {
	const order = orderRoutes(BEFORE).map((route) => route.id);
	assert.deepEqual(order, ["openrouter-free", "vercel-ai-gateway"]);
});

test("after the cutoff Vercel AI Gateway is preferred", () => {
	const order = orderRoutes(AFTER).map((route) => route.id);
	assert.deepEqual(order, ["vercel-ai-gateway", "openrouter-free"]);
});

test("the cutoff is the published 2026-10-22T12:00:00Z boundary", () => {
	assert.equal(Date.parse(PROMOTION_CUTOFF), Date.parse("2026-10-22T12:00:00Z"));
	// 20:00 Asia/Manila (UTC+8) is the same instant.
	assert.equal(Date.parse(PROMOTION_CUTOFF), Date.parse("2026-10-22T20:00:00+08:00"));
});

test("the schedule handles both sides of the timezone boundary", () => {
	// One millisecond before and after the boundary, expressed in Manila time.
	const manilaBefore = new Date(CUTOFF - 1).toISOString();
	const manilaAfter = new Date(CUTOFF).toISOString();
	assert.equal(orderRoutes(manilaBefore)[0].id, "openrouter-free");
	assert.equal(orderRoutes(manilaAfter)[0].id, "vercel-ai-gateway");
});

// ---------------------------------------------------------------------------
// Route selection
// ---------------------------------------------------------------------------

test("OpenRouter free is selected before the cutoff", () => {
	const result = resolveBunnyRoute({
		now: BEFORE,
		state: state(),
		catalog: catalog(),
		credentials: credentials(),
	});
	assert.equal(result.ok, true);
	assert.equal(result.route.id, "openrouter-free");
	assert.equal(result.route.provider, "openrouter");
	assert.equal(result.route.model, "minimax/minimax-m3.1-flash:free");
	assert.equal(result.route.inFreeWindow, true);
});

test("Vercel AI Gateway is selected after the cutoff", () => {
	const result = resolveBunnyRoute({
		now: AFTER,
		state: state({ vercelVerifiedAt: AFTER }),
		catalog: catalog(),
		credentials: credentials(),
	});
	assert.equal(result.ok, true);
	assert.equal(result.route.id, "vercel-ai-gateway");
	assert.equal(result.route.provider, "vercel-ai-gateway");
	assert.equal(result.route.model, "minimax/minimax-m3.1-flash");
});

test("a missing OpenRouter credential produces a clear error", () => {
	const result = resolveBunnyRoute({
		now: BEFORE,
		state: state(),
		catalog: catalog(),
		credentials: { openrouter: { configured: false }, "vercel-ai-gateway": { configured: false } },
	});
	assert.equal(result.ok, false);
	assert.ok(result.blockers.some((blocker) => blocker.includes("no credentials for provider \"openrouter\"")));
	assert.ok(result.blockers.some((blocker) => blocker.includes("OPENROUTER_API_KEY")));
});

test("a missing Vercel credential produces a clear error", () => {
	const result = resolveBunnyRoute({
		now: AFTER,
		state: state({ vercelVerifiedAt: AFTER }),
		catalog: catalog(),
		credentials: { openrouter: { configured: true }, "vercel-ai-gateway": { configured: false } },
	});
	// The scheduled route is Vercel, so the request fails closed.
	assert.equal(result.ok, false);
	assert.ok(result.blockers.some((blocker) => blocker.includes("no credentials for provider \"vercel-ai-gateway\"")));
	assert.ok(result.blockers.some((blocker) => blocker.includes("AI_GATEWAY_API_KEY")));
});

test("no free-credit verification means no unauthorized paid dispatch", () => {
	const result = resolveBunnyRoute({
		now: AFTER,
		state: state({ vercelFreeVerified: false }),
		catalog: catalog(),
		credentials: credentials(),
	});
	// The scheduled Vercel route is blocked and nothing is dispatched.
	assert.equal(result.ok, false);
	assert.ok(result.blockers.some((blocker) => blocker.includes("free-credit eligibility is not verified")));
	assert.ok(formatRouteFailure(result).includes("No paid fallback is attempted automatically"));
});

test("a verified free fallback is used only when it is enabled explicitly", () => {
	const withFallback = state({ vercelFreeVerified: false });
	withFallback.routing.allowVerifiedFallback = true;
	const result = resolveBunnyRoute({
		now: AFTER,
		state: withFallback,
		catalog: catalog(),
		credentials: credentials(),
	});
	assert.equal(result.ok, true);
	assert.equal(result.route.id, "openrouter-free");
	assert.ok(result.blockers.some((blocker) => blocker.includes("free-credit eligibility is not verified")));
});

test("without any usable route the failure names every blocker", () => {
	const result = resolveBunnyRoute({
		now: AFTER,
		state: state({ vercelFreeVerified: false }),
		catalog: { openrouter: {}, "vercel-ai-gateway": { [VERCEL_MODEL.id]: VERCEL_MODEL } },
		credentials: { openrouter: { configured: true }, "vercel-ai-gateway": { configured: false } },
	});
	assert.equal(result.ok, false);
	const message = formatRouteFailure(result);
	assert.ok(message.includes("not in the local Pi catalog"));
	assert.ok(message.includes("no credentials"));
	assert.ok(message.includes("No paid fallback is attempted automatically"));
});
test("a model missing from the local catalog is reported, not guessed", () => {
	const result = resolveBunnyRoute({
		now: BEFORE,
		state: state(),
		catalog: {},
		credentials: credentials(),
	});
	assert.equal(result.ok, false);
	assert.ok(result.blockers.some((blocker) => blocker.includes("pi update --models")));
});

test("a paid route is used only with explicit authorization", () => {
	const paid = state({ vercelFreeVerified: false, paidAuthorized: true });
	const result = resolveBunnyRoute({
		now: AFTER,
		state: paid,
		catalog: catalog(),
		credentials: credentials(),
	});
	assert.equal(result.ok, true);
	assert.equal(result.route.id, "vercel-ai-gateway");
	assert.equal(result.route.paidAuthorized, true);
});

test("a paid route is refused once the spend cap is reached", () => {
	const paid = state({ vercelFreeVerified: false, paidAuthorized: true });
	paid.routing.spend.capUsd = 5;
	paid.routing.spend.usedUsd = 5;
	const result = resolveBunnyRoute({
		now: AFTER,
		state: paid,
		catalog: catalog(),
		credentials: credentials(),
	});
	assert.equal(result.ok, false);
	assert.ok(result.blockers.some((blocker) => blocker.includes("spend cap reached")));
});

test("a promotional route needs a verification newer than the promotion cutoff", () => {
	const stale = state({ vercelVerifiedAt: BEFORE });
	const result = resolveBunnyRoute({
		now: AFTER,
		state: stale,
		catalog: catalog(),
		credentials: credentials(),
	});
	assert.equal(result.ok, false);
	assert.ok(result.blockers.some((blocker) => blocker.includes("predates the")));
});

// ---------------------------------------------------------------------------
// Device state
// ---------------------------------------------------------------------------

test("a disabled device state blocks routing with an actionable message", () => {
	const disabled = state();
	disabled.enabled = false;
	disabled.routing.enabled = false;
	const result = resolveBunnyRoute({
		now: BEFORE,
		state: disabled,
		catalog: catalog(),
		credentials: credentials(),
	});
	assert.equal(result.ok, false);
	assert.ok(result.blockers[0].includes("device-models.sh enroll"));
});

test("an unenrolled device uses the published schedule and nothing device-specific", () => {
	const result = resolveBunnyRoute({
		now: BEFORE,
		state: null,
		catalog: catalog(),
		credentials: credentials(),
	});
	assert.equal(result.ok, true);
	assert.equal(result.route.id, "openrouter-free");
	// No device authorization means the promotional route stays blocked and
	// nothing is dispatched to it.
	const afterResult = resolveBunnyRoute({
		now: AFTER,
		state: null,
		catalog: catalog(),
		credentials: credentials(),
	});
	assert.equal(afterResult.ok, false);
	assert.ok(afterResult.blockers.some((blocker) => blocker.includes("free-credit eligibility is not verified")));
});

// ---------------------------------------------------------------------------
// In-flight jobs across the cutoff
// ---------------------------------------------------------------------------

test("a job running across the cutoff stays on its original route", () => {
	const previous = { provider: "openrouter", model: OPENROUTER_MODEL.id };
	const result = resolveBunnyRoute({
		now: AFTER,
		state: state({ vercelVerifiedAt: AFTER }),
		catalog: catalog(),
		credentials: credentials(),
		reason: "continuation",
		previous,
	});
	assert.equal(result.ok, true);
	assert.equal(result.route.id, "openrouter-free");
});

test("a new job after the cutoff uses the new verified route", () => {
	const result = resolveBunnyRoute({
		now: AFTER,
		state: state({ vercelVerifiedAt: AFTER }),
		catalog: catalog(),
		credentials: credentials(),
		reason: "user",
	});
	assert.equal(result.ok, true);
	assert.equal(result.route.id, "vercel-ai-gateway");
});

test("a retry stays on the route that failed", () => {
	const previous = { provider: "vercel-ai-gateway", model: VERCEL_MODEL.id };
	const result = resolveBunnyRoute({
		now: AFTER,
		state: state({ vercelVerifiedAt: AFTER }),
		catalog: catalog(),
		credentials: credentials(),
		reason: "retry",
		previous,
	});
	assert.equal(result.ok, true);
	assert.equal(result.route.id, "vercel-ai-gateway");
});

test("stickiness only applies to continuation and retry", () => {
	const previous = { provider: "openrouter", model: OPENROUTER_MODEL.id };
	assert.equal(stickyRoute("user", previous), undefined);
	assert.equal(stickyRoute("direct", previous), undefined);
	assert.equal(stickyRoute("continuation", previous)?.id, "openrouter-free");
	assert.equal(stickyRoute("retry", previous)?.id, "openrouter-free");
	assert.equal(stickyRoute("continuation", undefined), undefined);
});

// ---------------------------------------------------------------------------
// Thinking levels
// ---------------------------------------------------------------------------

test("the family pins explicit thinking levels", () => {
	assert.deepEqual(BUNNY_THINKING_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
	for (const level of BUNNY_THINKING_LEVELS) assert.ok(ALL_THINKING_LEVELS.includes(level));
});

test("an unsupported thinking level fails explicitly instead of downgrading", () => {
	const route = BUNNY_ROUTES[0];
	const check = checkThinkingLevel(OPENROUTER_MODEL, "off", route);
	assert.equal(check.ok, false);
	assert.ok(check.message.includes('Thinking level "off" is not supported'));
	assert.ok(check.message.includes("low, medium, high, xhigh, max"));
});

test("a supported thinking level passes for every family level", () => {
	for (const route of BUNNY_ROUTES) {
		for (const level of BUNNY_THINKING_LEVELS) {
			const model = route.provider === "openrouter" ? OPENROUTER_MODEL : VERCEL_MODEL;
			assert.equal(checkThinkingLevel(model, level, route).ok, true, `${route.id}/${level}`);
		}
	}
});

test("a live catalog map narrows the verified levels further", () => {
	const model = { ...OPENROUTER_MODEL, thinkingLevelMap: { off: null, minimal: null, low: "low" } };
	assert.deepEqual(supportedThinkingLevels(model, BUNNY_ROUTES[0]), ["low"]);
	assert.equal(checkThinkingLevel(model, "high", BUNNY_ROUTES[0]).ok, false);
});

test("a missing thinking level is rejected", () => {
	const check = checkThinkingLevel(OPENROUTER_MODEL, undefined, BUNNY_ROUTES[0]);
	assert.equal(check.ok, false);
	assert.ok(check.message.includes("must pin an explicit thinking level"));
});

// ---------------------------------------------------------------------------
// Route table invariants
// ---------------------------------------------------------------------------

test("every route declares a cutoff, a guarantee and a credential hint", () => {
	for (const route of BUNNY_ROUTES) {
		assert.ok(route.id);
		assert.ok(route.provider);
		assert.ok(route.model);
		assert.ok(Date.parse(route.freeUntil) > 0);
		assert.ok(["no-charge", "promotional"].includes(route.freeGuarantee));
		assert.ok(route.credential);
		assert.deepEqual(route.thinkingLevels, BUNNY_THINKING_LEVELS);
	}
});

test("the OpenRouter route cannot bill and the Vercel route needs verification", () => {
	const openrouter = BUNNY_ROUTES.find((route) => route.id === "openrouter-free");
	const vercel = BUNNY_ROUTES.find((route) => route.id === "vercel-ai-gateway");
	assert.equal(openrouter.freeGuarantee, "no-charge");
	assert.equal(openrouter.requiresFreeVerification, false);
	assert.equal(vercel.freeGuarantee, "promotional");
	assert.equal(vercel.requiresFreeVerification, true);
});

test("the Vercel route is blocked without a free-credit verification", () => {
	const decision = evaluateRoute(BUNNY_ROUTES[1], {
		now: AFTER,
		state: state({ vercelFreeVerified: false }),
		catalog: catalog(),
		credentials: credentials(),
	});
	assert.equal(decision.ok, false);
	assert.ok(decision.blocker.includes("free-credit eligibility is not verified"));
});
