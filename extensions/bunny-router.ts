/**
 * Bunny router — registers the stable `bunny/minimax-m3.1-flash` virtual model.
 *
 * The Bunny family keeps one internal identity. This extension resolves the
 * physical provider/model per request, so the published transition from
 * OpenRouter free to the Vercel AI Gateway never requires renaming or editing
 * an agent definition.
 *
 * Safety posture:
 *   - The clock selects a preference; it never authorizes spending.
 *   - A route is used only when the provider has credentials, the model exists
 *     in the local catalog, and the local device state allows the route.
 *   - No paid route is used without explicit local authorization, and there is
 *     no automatic purchase, top-up, or paid fallback.
 *   - Continuation and retry requests stay on the provider that already served
 *     the turn, so a route change never interrupts an in-flight job.
 *
 * Local state lives in `<agent-dir>/device-profile.json` and is never
 * committed. See `device-profiles/README.md` and `docs/bunny-routing.md`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	ALL_THINKING_LEVELS,
	BUNNY_MODEL_REFERENCE,
	BUNNY_ROUTES,
	BUNNY_THINKING_LEVELS,
	BUNNY_VIRTUAL_MODEL_ID,
	BUNNY_VIRTUAL_PROVIDER,
	checkThinkingLevel,
	formatRouteFailure,
	resolveBunnyRoute,
	supportedThinkingLevels,
} from "./bunny-route.mjs";

const STATE_FILE = "device-profile.json";

/** Read the local device state. Missing or malformed state is not fatal. */
function readDeviceState(): Record<string, unknown> | null {
	try {
		const file = path.join(getAgentDir(), STATE_FILE);
		if (!fs.existsSync(file)) return null;
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Catalog view used by the routing core: provider -> modelId -> model. */
function buildCatalog(ctx: ExtensionContext): Record<string, Record<string, unknown>> {
	const catalog: Record<string, Record<string, unknown>> = {};
	for (const route of BUNNY_ROUTES) {
		const model = ctx.modelRegistry.find(route.provider, route.model);
		if (!model) continue;
		catalog[route.provider] ??= {};
		catalog[route.provider][route.model] = model;
	}
	return catalog;
}

/** Credential view used by the routing core: provider -> { configured, source }. */
function buildCredentials(ctx: ExtensionContext): Record<string, { configured: boolean; source?: string }> {
	const credentials: Record<string, { configured: boolean; source?: string }> = {};
	for (const route of BUNNY_ROUTES) {
		try {
			const status = ctx.modelRegistry.getProviderAuthStatus(route.provider);
			credentials[route.provider] = {
				configured: status?.configured === true,
				source: status?.source ?? status?.label,
			};
		} catch {
			credentials[route.provider] = { configured: false };
		}
	}
	return credentials;
}

export default function bunnyRouterExtension(pi: ExtensionAPI) {
	pi.registerVirtualModel({
		provider: BUNNY_VIRTUAL_PROVIDER,
		id: BUNNY_VIRTUAL_MODEL_ID,
		name: "MiniMax M3.1 Flash (Bunny, routed)",
		// Every level is offered so Pi never clamps a selection behind our
		// back. The route checks the physical model and fails explicitly.
		thinkingLevels: [...ALL_THINKING_LEVELS],
		contextWindow: 1_000_000,
		maxTokens: 524_288,
		input: ["text"],
		route(request, ctx) {
			const state = readDeviceState();
			const catalog = buildCatalog(ctx);
			const credentials = buildCredentials(ctx);

			// A continuation or retry stays on the provider that already served
			// the turn, so a route change never interrupts an in-flight job. A
			// new dispatch re-evaluates the published schedule.
			const resolved = resolveBunnyRoute({
				now: new Date(),
				state,
				catalog,
				credentials,
				reason: request.reason,
				previous: request.previous
					? { provider: request.previous.model.provider, model: request.previous.model.id }
					: undefined,
			});
			if (!resolved.ok) {
				throw new Error(formatRouteFailure(resolved));
			}
			return finalize(resolved.route, request.thinkingLevel, ctx);
		},
	});

	pi.registerCommand("bunny", {
		description: "Show the resolved Bunny provider route and its authorization state",
		handler: async (_args, ctx) => {
			const state = readDeviceState();
			const catalog = buildCatalog(ctx as unknown as ExtensionContext);
			const credentials = buildCredentials(ctx as unknown as ExtensionContext);
			const resolved = resolveBunnyRoute({ now: new Date(), state, catalog, credentials });
			const lines: string[] = [];
			lines.push(`Bunny identity: ${BUNNY_MODEL_REFERENCE}`);
			lines.push(`Thinking levels: ${BUNNY_THINKING_LEVELS.join(", ")}`);
			lines.push(`Device state: ${state ? `enrolled (${String(state.device ?? "unknown")})` : "not enrolled"}`);
			if (resolved.ok) {
				const route = resolved.route!;
				lines.push(
					`Active route: ${route.id} -> ${route.provider}/${route.model}` +
						` (${route.inFreeWindow ? "inside published free window" : "past published free window"})`,
				);
				for (const candidate of BUNNY_ROUTES) {
					const model = catalog[candidate.provider]?.[candidate.model];
					const levels = model ? supportedThinkingLevels(model, candidate).join(", ") : "model not in catalog";
					lines.push(`  - ${candidate.id}: catalog=${model ? "yes" : "no"}, credentials=${credentials[candidate.provider]?.configured ? "yes" : "no"}, levels=${levels}`);
				}
			} else {
				lines.push("Active route: none");
				lines.push(formatRouteFailure(resolved));
			}
			const text = lines.join("\n");
			if (ctx.hasUI) ctx.ui.notify(text, resolved.ok ? "info" : "error");
			else process.stdout.write(`${text}\n`);
		},
	});
}

/** Validate the pinned thinking level and return the physical route. */
function finalize(
	route: { provider: string; model: string; thinkingLevels?: string[] },
	thinkingLevel: string | undefined,
	ctx: ExtensionContext,
): { model: unknown; thinkingLevel: string } {
	const model = ctx.modelRegistry.find(route.provider, route.model);
	if (!model) {
		throw new Error(`Bunny routing selected ${route.provider}/${route.model}, but it is not in the local Pi catalog. Run "pi update --models".`);
	}
	const check = checkThinkingLevel(model, thinkingLevel, { thinkingLevels: route.thinkingLevels });
	if (!check.ok) {
		throw new Error(check.message);
	}
	return { model, thinkingLevel: thinkingLevel as string };
}
