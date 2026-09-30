import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// TypeSafe Jev pricing: $0.042 / 1M input tokens ($0.000000042 per token), $0 output tokens
const JEV_INPUT_PRICE_PER_TOKEN = 0.042 / 1_000_000;

export default function jevCostExtension(pi: ExtensionAPI): void {
	let totalInputTokens = 0;
	let totalCalls = 0;

	function updateStatus(ui: any): void {
		if (totalCalls === 0) {
			ui.setStatus("jev-cost", undefined);
			return;
		}

		const cost = totalInputTokens * JEV_INPUT_PRICE_PER_TOKEN;
		// e.g. "$0.00004" or "$0.0012"
		const costFormatted = cost < 0.001 ? `$${cost.toFixed(5)}` : `$${cost.toFixed(4)}`;
		const tokensFormatted = totalInputTokens.toLocaleString();

		const text = ui.theme
			? `${ui.theme.fg("accent", "⚡ Jev:")} ${tokensFormatted} in (${ui.theme.fg("success", costFormatted)})`
			: `⚡ Jev: ${tokensFormatted} in (${costFormatted})`;

		ui.setStatus("jev-cost", text);
	}

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "mcp") return;

		// Check if details contained semantic backend usage
		const details = event.details as Record<string, any> | undefined;
		if (!details) return;

		const backend = details.backend;
		if (backend && backend.used === "semantic" && backend.usage) {
			const inTokens = Number(backend.usage.inputTokens) || 0;
			if (inTokens > 0) {
				totalInputTokens += inTokens;
				totalCalls += 1;
				updateStatus(ctx.ui);
			}
		}
	});

	pi.on("session_start", (_event, ctx) => {
		totalInputTokens = 0;
		totalCalls = 0;
		updateStatus(ctx.ui);
	});
}
