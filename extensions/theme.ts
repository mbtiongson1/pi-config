/**
 * Theme Manager & Random Boot Cycling Extension for Pi
 *
 * Capabilities:
 * 1. Boot-up random cycling:
 *    Every time Pi starts up, it randomly selects one of the custom themes
 *    (favor-dark, favor-cream, favor-indigo, favor-events, favor-finance-green,
 *    favor-watershed, finance-editorial, gaia-research, gaia-skill-tree)
 *    and applies it immediately.
 * 2. `/theme` command:
 *    - `/theme`: Opens an interactive theme picker ("like a model picker").
 *    - `/theme next`: Cycles to the next custom theme in the collection.
 *    - `/theme prev` / `/theme previous`: Cycles to the previous theme.
 *    - `/theme random`: Picks a random custom theme right away.
 *    - `/theme <name>`: Switches directly to the named theme (with fuzzy matching).
 * 3. `set_theme` tool:
 *    Allows the agent to programmatically switch or cycle themes on user request.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getSettingsPath } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

let hasBootstrapped = false;

function getThemeModule(): any {
	try {
		return require("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
	} catch {
		try {
			return require("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
		} catch {
			return null;
		}
	}
}

/**
 * Return all custom themes found in <agentDir>/themes/*.json
 */
function getCustomThemes(): string[] {
	const themesDir = path.join(getAgentDir(), "themes");
	if (!fs.existsSync(themesDir)) return [];
	try {
		const files = fs.readdirSync(themesDir);
		return files
			.filter(f => f.endsWith(".json"))
			.map(f => f.slice(0, -5))
			.filter(name => name.length > 0 && !name.includes("/"));
	} catch {
		return [];
	}
}

/**
 * Return all themes available (custom + built-ins)
 */
function getAllAvailableThemes(): string[] {
	const custom = getCustomThemes();
	const builtins = ["dark", "light", "system"];
	const combined = [...custom];
	for (const b of builtins) {
		if (!combined.includes(b)) combined.push(b);
	}
	return combined;
}

/**
 * Get current theme name from context, theme singleton, or settings.json
 */
function getCurrentTheme(ctx?: ExtensionContext): string {
	if (ctx?.ui && (ctx.ui as any).theme?.name) {
		return (ctx.ui as any).theme.name;
	}
	const themeMod = getThemeModule();
	if (themeMod?.theme?.name) {
		return themeMod.theme.name;
	}
	try {
		const settingsFile = getSettingsPath ? getSettingsPath() : path.join(getAgentDir(), "settings.json");
		if (fs.existsSync(settingsFile)) {
			const data = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
			if (typeof data.theme === "string") return data.theme;
		}
	} catch {}
	return "favor-dark";
}

/**
 * Persist the theme choice to ~/.pi/agent/settings.json
 */
function persistThemeSetting(themeName: string): void {
	try {
		const settingsFile = getSettingsPath ? getSettingsPath() : path.join(getAgentDir(), "settings.json");
		if (fs.existsSync(settingsFile)) {
			const content = fs.readFileSync(settingsFile, "utf-8");
			const json = JSON.parse(content);
			if (json.theme !== themeName) {
				json.theme = themeName;
				fs.writeFileSync(settingsFile, JSON.stringify(json, null, 2) + "\n", "utf-8");
			}
		}
	} catch (err) {
		// Non-fatal
	}
}

/**
 * Apply a theme to Pi runtime and persist it.
 */
function applyTheme(themeName: string, ctx?: ExtensionContext): boolean {
	let applied = false;

	// 1. Interactive UI controller (preferred if available)
	if (ctx?.ui && typeof (ctx.ui as any).setTheme === "function") {
		try {
			const res = (ctx.ui as any).setTheme(themeName);
			if (res?.success !== false) applied = true;
		} catch {}
	}

	// 2. Global theme singleton
	const themeMod = getThemeModule();
	if (themeMod && typeof themeMod.setTheme === "function") {
		try {
			const res = themeMod.setTheme(themeName);
			if (res?.success !== false) applied = true;
		} catch {}
	}

	// 3. Persist to settings.json
	persistThemeSetting(themeName);

	// 4. Update status line if available
	if (ctx?.ui && typeof ctx.ui.setStatus === "function") {
		ctx.ui.setStatus("theme", `🎨 ${themeName}`);
	}

	return applied;
}

/**
 * Match a user-supplied name to an available theme
 */
function resolveThemeTarget(input: string): string | undefined {
	const term = input.trim().toLowerCase();
	if (!term) return undefined;

	const all = getAllAvailableThemes();

	// 1. Exact match
	const exact = all.find(t => t.toLowerCase() === term);
	if (exact) return exact;

	// 2. Starts with
	const starts = all.find(t => t.toLowerCase().startsWith(term));
	if (starts) return starts;

	// 3. Substring match (e.g. "indigo" -> "favor-indigo")
	const sub = all.find(t => t.toLowerCase().includes(term));
	if (sub) return sub;

	return undefined;
}

export default function themeExtension(pi: ExtensionAPI): void {
	// =========================================================================
	// 1. Boot-up Random Cycling
	// =========================================================================
	pi.on("session_start", async (_event, ctx) => {
		if (hasBootstrapped) return;
		hasBootstrapped = true;

		// If user explicitly passed `--use-theme`, do not override
		const hasExplicitCliTheme = process.argv.some(
			arg => arg === "--use-theme" || arg.startsWith("--use-theme="),
		);
		if (hasExplicitCliTheme) return;

		const customThemes = getCustomThemes();
		if (customThemes.length === 0) return;

		const current = getCurrentTheme(ctx);
		// Prefer a different custom theme from current for visible freshness
		const candidates = customThemes.length > 1
			? customThemes.filter(t => t !== current)
			: customThemes;

		const randomTheme = candidates[Math.floor(Math.random() * candidates.length)];
		if (randomTheme) {
			applyTheme(randomTheme, ctx);
			if (ctx?.ui && typeof ctx.ui.notify === "function") {
				ctx.ui.notify(`🎨 Theme: ${randomTheme}`, "info");
			}
		}
	});

	// =========================================================================
	// 2. /theme Slash Command
	// =========================================================================
	pi.registerCommand("theme", {
		description: "Switch or cycle themes: /theme [next|prev|random|<name>] or open picker",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const subcommands = ["next", "prev", "previous", "random"];
			const themes = getAllAvailableThemes();
			const all = [...subcommands, ...themes];
			return all
				.filter(item => item.toLowerCase().startsWith(query))
				.map(item => ({ value: `${item} `, label: item }));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const customThemes = getCustomThemes();
			const allThemes = getAllAvailableThemes();
			const current = getCurrentTheme(ctx);

			// Case A: No arguments -> Interactive Theme Picker ("like a model picker")
			if (!trimmed) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Current theme: ${current}\nAvailable themes: ${allThemes.join(", ")}`, "info");
					return;
				}

				// Build options list with current theme checked
				const choices = allThemes.map(name => {
					const isCurrent = name === current;
					return isCurrent ? `✓ ${name} (current)` : `  ${name}`;
				});

				const selection = await ctx.ui.select("Select Theme", choices);
				if (!selection) return;

				const chosenName = selection
					.replace(/^[✓\s]+/, "")
					.replace(/\s+\(current\)$/, "")
					.trim();

				if (chosenName) {
					applyTheme(chosenName, ctx);
					ctx.ui.notify(`🎨 Theme: ${chosenName}`, "info");
				}
				return;
			}

			const lower = trimmed.toLowerCase();

			// Case B: /theme next
			if (lower === "next") {
				if (customThemes.length === 0) {
					ctx.ui.notify("No custom themes found.", "warning");
					return;
				}
				const idx = customThemes.indexOf(current);
				const nextIdx = idx === -1 ? 0 : (idx + 1) % customThemes.length;
				const nextTheme = customThemes[nextIdx];
				applyTheme(nextTheme, ctx);
				ctx.ui.notify(`🎨 Switched to theme: ${nextTheme}`, "info");
				return;
			}

			// Case C: /theme prev or previous
			if (lower === "prev" || lower === "previous") {
				if (customThemes.length === 0) {
					ctx.ui.notify("No custom themes found.", "warning");
					return;
				}
				const idx = customThemes.indexOf(current);
				const prevIdx = idx === -1 ? customThemes.length - 1 : (idx - 1 + customThemes.length) % customThemes.length;
				const prevTheme = customThemes[prevIdx];
				applyTheme(prevTheme, ctx);
				ctx.ui.notify(`🎨 Switched to theme: ${prevTheme}`, "info");
				return;
			}

			// Case D: /theme random
			if (lower === "random") {
				if (customThemes.length === 0) {
					ctx.ui.notify("No custom themes found.", "warning");
					return;
				}
				const candidates = customThemes.length > 1
					? customThemes.filter(t => t !== current)
					: customThemes;
				const randomTheme = candidates[Math.floor(Math.random() * candidates.length)];
				applyTheme(randomTheme, ctx);
				ctx.ui.notify(`🎲 Random theme: ${randomTheme}`, "info");
				return;
			}

			// Case E: /theme <name>
			const matched = resolveThemeTarget(trimmed);
			if (matched) {
				applyTheme(matched, ctx);
				ctx.ui.notify(`🎨 Switched to theme: ${matched}`, "info");
				return;
			}

			ctx.ui.notify(
				`Unknown theme "${trimmed}". Available themes:\n${allThemes.map(t => `  - ${t}`).join("\n")}`,
				"error",
			);
		},
	});

	// =========================================================================
	// 3. set_theme Tool (for Agent invocation)
	// =========================================================================
	pi.registerTool({
		name: "set_theme",
		description:
			"Switch or cycle the active Pi agent UI theme. Accepts 'next', 'prev', 'random', or a theme name (e.g. favor-dark, favor-cream, favor-indigo, favor-events, favor-finance-green, favor-watershed, finance-editorial).",
		parameters: Type.Object({
			theme: Type.String({
				description: "Theme name or directive: 'next', 'prev', 'random', or specific theme name",
			}),
		}),
		async execute({ theme: target }, ctx) {
			const lower = target.trim().toLowerCase();
			const customThemes = getCustomThemes();
			const current = getCurrentTheme(ctx);

			if (lower === "next") {
				if (customThemes.length === 0) return { content: [{ type: "text", text: "No custom themes available." }] };
				const idx = customThemes.indexOf(current);
				const nextTheme = customThemes[(idx + 1) % customThemes.length];
				applyTheme(nextTheme, ctx);
				return { content: [{ type: "text", text: `Switched theme to "${nextTheme}".` }] };
			}

			if (lower === "prev" || lower === "previous") {
				if (customThemes.length === 0) return { content: [{ type: "text", text: "No custom themes available." }] };
				const idx = customThemes.indexOf(current);
				const prevTheme = customThemes[(idx - 1 + customThemes.length) % customThemes.length];
				applyTheme(prevTheme, ctx);
				return { content: [{ type: "text", text: `Switched theme to "${prevTheme}".` }] };
			}

			if (lower === "random") {
				if (customThemes.length === 0) return { content: [{ type: "text", text: "No custom themes available." }] };
				const candidates = customThemes.length > 1 ? customThemes.filter(t => t !== current) : customThemes;
				const randomTheme = candidates[Math.floor(Math.random() * candidates.length)];
				applyTheme(randomTheme, ctx);
				return { content: [{ type: "text", text: `Switched to random theme "${randomTheme}".` }] };
			}

			const matched = resolveThemeTarget(target);
			if (matched) {
				applyTheme(matched, ctx);
				return { content: [{ type: "text", text: `Switched theme to "${matched}".` }] };
			}

			const available = getAllAvailableThemes().join(", ");
			return {
				isError: true,
				content: [{ type: "text", text: `Theme "${target}" not found. Available themes: ${available}` }],
			};
		},
	});
}
