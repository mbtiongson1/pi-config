import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface StatuslineConfig {
	showExtensions: boolean;
	hideAll: boolean;
	blockedKeys: string[];
	allowedKeys: string[];
}

const DEFAULT_CONFIG: StatuslineConfig = {
	showExtensions: false, // By default hide extension bloat unless specified
	hideAll: false,
	blockedKeys: [],
	allowedKeys: [],
};

function getConfigPath(): string {
	const baseDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(baseDir, "statusline.json");
}

function loadConfig(): StatuslineConfig {
	const configPath = getConfigPath();
	if (!existsSync(configPath)) {
		saveConfig(DEFAULT_CONFIG);
		return { ...DEFAULT_CONFIG };
	}
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			showExtensions: typeof parsed.showExtensions === "boolean" ? parsed.showExtensions : DEFAULT_CONFIG.showExtensions,
			hideAll: typeof parsed.hideAll === "boolean" ? parsed.hideAll : DEFAULT_CONFIG.hideAll,
			blockedKeys: Array.isArray(parsed.blockedKeys) ? parsed.blockedKeys.map(String) : [],
			allowedKeys: Array.isArray(parsed.allowedKeys) ? parsed.allowedKeys.map(String) : [],
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(cfg: StatuslineConfig): void {
	const configPath = getConfigPath();
	try {
		const dir = dirname(configPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
	} catch (e) {
		// Ignore write errors in read-only environments
	}
}

interface HookedFooterDataProvider {
	__statuslineOriginalGetExtensionStatuses?: () => ReadonlyMap<string, string>;
	getExtensionStatuses: () => ReadonlyMap<string, string>;
	[key: string]: any;
}

export default function statuslineExtension(pi: ExtensionAPI): void {
	let config: StatuslineConfig = loadConfig();
	let capturedFooterData: HookedFooterDataProvider | null = null;

	function hookFooterDataProvider(footerData: HookedFooterDataProvider): void {
		capturedFooterData = footerData;
		if (!footerData.__statuslineOriginalGetExtensionStatuses) {
			footerData.__statuslineOriginalGetExtensionStatuses = footerData.getExtensionStatuses.bind(footerData);
		}

		footerData.getExtensionStatuses = function (): ReadonlyMap<string, string> {
			const original = footerData.__statuslineOriginalGetExtensionStatuses?.() ?? new Map();
			if (!config.showExtensions) {
				return new Map();
			}

			if (config.allowedKeys.length === 0 && config.blockedKeys.length === 0) {
				return original;
			}

			const filtered = new Map<string, string>();
			for (const [key, value] of original) {
				if (config.allowedKeys.length > 0 && !config.allowedKeys.includes(key)) {
					continue;
				}
				if (config.blockedKeys.includes(key)) {
					continue;
				}
				filtered.set(key, value);
			}
			return filtered;
		};
	}

	function applyStatuslineUI(ctx: ExtensionContext | ExtensionCommandContext): void {
		if (ctx.mode !== "tui") return;

		if (!capturedFooterData) {
			ctx.ui.setFooter((_tui, _theme, footerData) => {
				hookFooterDataProvider(footerData as HookedFooterDataProvider);
				return { render: () => [] };
			});
		}

		if (config.hideAll) {
			ctx.ui.setFooter(() => ({
				render: () => [],
				invalidate() {},
				dispose() {},
			}));
		} else {
			ctx.ui.setFooter(undefined);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		config = loadConfig();
		applyStatuslineUI(ctx);
	});

	const commandCompletions = [
		{ value: "hide", label: "hide — Hide extension statusline bloat (default clean mode)" },
		{ value: "show", label: "show — Show extension statusline entries" },
		{ value: "hide all", label: "hide all — Hide the entire statusline/footer (cleanest view)" },
		{ value: "show all", label: "show all — Show entire statusline including all extension entries" },
		{ value: "toggle", label: "toggle — Toggle extension statusline visibility" },
		{ value: "toggle all", label: "toggle all — Toggle entire statusline visibility" },
		{ value: "status", label: "status — View current statusline visibility and active keys" },
		{ value: "list", label: "list — List all extension status keys currently in memory" },
		{ value: "block", label: "block <key> — Block a specific extension key from showing" },
		{ value: "allow", label: "allow <key> — Unblock / allow an extension key to show" },
		{ value: "only", label: "only <key> — Show only specific extension key(s)" },
		{ value: "reset", label: "reset — Reset statusline settings back to defaults (clean/hidden)" },
	];

	pi.registerCommand("statusline", {
		description: "Manage statusline visibility and filter extension statuses (hide | show | toggle | filter | reset)",
		getArgumentCompletions: (prefix: string) => {
			const cleanPrefix = prefix.trimStart();
			if (cleanPrefix.startsWith("block ") || cleanPrefix.startsWith("allow ") || cleanPrefix.startsWith("only ")) {
				const parts = cleanPrefix.split(/\s+/);
				const sub = parts[0];
				const keyPrefix = parts[1] ?? "";
				const rawMap = capturedFooterData?.__statuslineOriginalGetExtensionStatuses?.() ?? new Map();
				const keys = Array.from(rawMap.keys());
				return keys
					.filter((k) => k.startsWith(keyPrefix))
					.map((k) => ({
						value: `${sub} ${k}`,
						label: `${sub} ${k} (active key)`,
					}));
			}

			return commandCompletions.filter((cmd) => cmd.value.startsWith(cleanPrefix));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const rawArgs = args.trim();
			const lowerArgs = rawArgs.toLowerCase();

			function getActiveStatuses(): Map<string, string> {
				const orig = capturedFooterData?.__statuslineOriginalGetExtensionStatuses?.() ?? new Map();
				return new Map(orig);
			}

			function formatStatusReport(): string {
				const active = getActiveStatuses();
				const activeCount = active.size;
				const statusLines = [
					`Statusline Settings:`,
					`• Entire statusline: ${config.hideAll ? "⊘ HIDDEN" : "✓ VISIBLE"}`,
					`• Extension bloat:   ${config.showExtensions ? "✓ SHOWN" : "⊘ HIDDEN (default)"}`,
				];
				if (config.blockedKeys.length > 0) {
					statusLines.push(`• Blocked keys:      ${config.blockedKeys.join(", ")}`);
				}
				if (config.allowedKeys.length > 0) {
					statusLines.push(`• Allowed keys only: ${config.allowedKeys.join(", ")}`);
				}

				statusLines.push(`• Active extension keys (${activeCount}):`);
				if (activeCount === 0) {
					statusLines.push(`    (no extensions are currently setting status)`);
				} else {
					for (const [k, v] of active) {
						const isShown = config.showExtensions && (!config.allowedKeys.length || config.allowedKeys.includes(k)) && !config.blockedKeys.includes(k);
						const tag = isShown ? "[visible]" : "[hidden]";
						const preview = v.length > 40 ? `${v.slice(0, 37)}...` : v;
						statusLines.push(`    - ${k} ${tag}: "${preview}"`);
					}
				}
				return statusLines.join("\n");
			}

			// Interactive selector when invoked without arguments
			if (!rawArgs) {
				const options = [
					"Hide extension bloat (clean default)",
					"Show extension statuses",
					"Toggle extension statuses",
					"Hide entire statusline (zen)",
					"Show full statusline (all)",
					"View active status keys & current report",
					"Reset to default configuration",
				];

				const choice = await ctx.ui.select("Statusline Manager", options);
				if (!choice) return;

				if (choice.startsWith("Hide extension bloat")) {
					config.showExtensions = false;
					config.hideAll = false;
					saveConfig(config);
					applyStatuslineUI(ctx);
					ctx.ui.notify("Statusline: extension bloat hidden (clean mode)", "info");
					return;
				}
				if (choice.startsWith("Show extension statuses")) {
					config.showExtensions = true;
					config.hideAll = false;
					saveConfig(config);
					applyStatuslineUI(ctx);
					ctx.ui.notify("Statusline: extension statuses shown", "info");
					return;
				}
				if (choice.startsWith("Toggle extension statuses")) {
					config.showExtensions = !config.showExtensions;
					config.hideAll = false;
					saveConfig(config);
					applyStatuslineUI(ctx);
					ctx.ui.notify(`Statusline: extension statuses ${config.showExtensions ? "shown" : "hidden"}`, "info");
					return;
				}
				if (choice.startsWith("Hide entire statusline")) {
					config.hideAll = true;
					saveConfig(config);
					applyStatuslineUI(ctx);
					ctx.ui.notify("Statusline: entire footer hidden", "info");
					return;
				}
				if (choice.startsWith("Show full statusline")) {
					config.hideAll = false;
					config.showExtensions = true;
					config.blockedKeys = [];
					config.allowedKeys = [];
					saveConfig(config);
					applyStatuslineUI(ctx);
					ctx.ui.notify("Statusline: full statusline shown", "info");
					return;
				}
				if (choice.startsWith("View active")) {
					ctx.ui.notify(formatStatusReport(), "info");
					return;
				}
				if (choice.startsWith("Reset")) {
					config = { ...DEFAULT_CONFIG };
					saveConfig(config);
					applyStatuslineUI(ctx);
					ctx.ui.notify("Statusline: reset to default (extension bloat hidden)", "info");
					return;
				}
				return;
			}

			// Subcommand handling
			if (lowerArgs === "hide" || lowerArgs === "off" || lowerArgs === "clean") {
				config.showExtensions = false;
				config.hideAll = false;
				saveConfig(config);
				applyStatuslineUI(ctx);
				ctx.ui.notify("Statusline: extension bloat hidden (clean mode)", "info");
				return;
			}

			if (lowerArgs === "show" || lowerArgs === "on") {
				config.showExtensions = true;
				config.hideAll = false;
				saveConfig(config);
				applyStatuslineUI(ctx);
				ctx.ui.notify("Statusline: extension statuses shown", "info");
				return;
			}

			if (lowerArgs === "hide all" || lowerArgs === "hide-all" || lowerArgs === "none" || lowerArgs === "zen") {
				config.hideAll = true;
				saveConfig(config);
				applyStatuslineUI(ctx);
				ctx.ui.notify("Statusline: entire footer hidden", "info");
				return;
			}

			if (lowerArgs === "show all" || lowerArgs === "show-all" || lowerArgs === "all") {
				config.hideAll = false;
				config.showExtensions = true;
				config.blockedKeys = [];
				config.allowedKeys = [];
				saveConfig(config);
				applyStatuslineUI(ctx);
				ctx.ui.notify("Statusline: full statusline shown (all elements enabled)", "info");
				return;
			}

			if (lowerArgs === "toggle") {
				if (config.hideAll) {
					config.hideAll = false;
				} else {
					config.showExtensions = !config.showExtensions;
				}
				saveConfig(config);
				applyStatuslineUI(ctx);
				ctx.ui.notify(`Statusline: extension statuses ${config.showExtensions ? "shown" : "hidden"}`, "info");
				return;
			}

			if (lowerArgs === "toggle all" || lowerArgs === "toggle-all") {
				config.hideAll = !config.hideAll;
				saveConfig(config);
				applyStatuslineUI(ctx);
				ctx.ui.notify(`Statusline: entire footer ${config.hideAll ? "hidden" : "shown"}`, "info");
				return;
			}

			if (lowerArgs.startsWith("block ") || lowerArgs.startsWith("filter ")) {
				const keys = rawArgs.split(/\s+/).slice(1).filter(Boolean);
				if (keys.length === 0) {
					ctx.ui.notify("Usage: /statusline block <key1> [key2...]", "warning");
					return;
				}
				for (const k of keys) {
					if (!config.blockedKeys.includes(k)) config.blockedKeys.push(k);
				}
				saveConfig(config);
				applyStatuslineUI(ctx);
				ctx.ui.notify(`Statusline: blocked key(s): ${keys.join(", ")}`, "info");
				return;
			}

			if (lowerArgs.startsWith("allow ") || lowerArgs.startsWith("unblock ")) {
				const keys = rawArgs.split(/\s+/).slice(1).filter(Boolean);
				if (keys.length === 0) {
					ctx.ui.notify("Usage: /statusline allow <key1> [key2...]", "warning");
					return;
				}
				config.blockedKeys = config.blockedKeys.filter((k) => !keys.includes(k));
				for (const k of keys) {
					if (!config.allowedKeys.includes(k) && config.allowedKeys.length > 0) {
						config.allowedKeys.push(k);
					}
				}
				saveConfig(config);
				applyStatuslineUI(ctx);
				ctx.ui.notify(`Statusline: allowed key(s): ${keys.join(", ")}`, "info");
				return;
			}

			if (lowerArgs.startsWith("only ")) {
				const keys = rawArgs.split(/\s+/).slice(1).filter(Boolean);
				if (keys.length === 0) {
					ctx.ui.notify("Usage: /statusline only <key1> [key2...]", "warning");
					return;
				}
				config.allowedKeys = keys;
				config.showExtensions = true;
				config.hideAll = false;
				saveConfig(config);
				applyStatuslineUI(ctx);
				ctx.ui.notify(`Statusline: restricted to key(s): ${keys.join(", ")}`, "info");
				return;
			}

			if (lowerArgs === "reset") {
				config = { ...DEFAULT_CONFIG };
				saveConfig(config);
				applyStatuslineUI(ctx);
				ctx.ui.notify("Statusline: reset to default (extension bloat hidden)", "info");
				return;
			}

			if (lowerArgs === "status" || lowerArgs === "list" || lowerArgs === "info") {
				ctx.ui.notify(formatStatusReport(), "info");
				return;
			}

			ctx.ui.notify(`Unknown subcommand '${rawArgs}'. Usage: /statusline [hide | show | hide all | show all | toggle | status | block <key> | allow <key> | reset]`, "warning");
		},
	});
}
