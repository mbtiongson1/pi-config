import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Compatibility for prompt-triggered RESOURCE_EXHAUSTED on pi-antigravity 0.14.0.
 * Reword only known stock prompt fragments; keep instructions at system priority.
 * See pi-config/docs/antigravity-prompt-compat.md and upstream issue #137.
 */
export function rewriteAntigravitySystemText(text: string): string {
	return text
		.replace(
			/^You are a coding assistant (?:running|operating) inside [^.]*\.\s*Help users inspect files, run commands, and modify code\./i,
			"You are a coding agent helping the user with their project.",
		)
		.replace(/<docs>[\s\S]*?<\/docs>/g, block => block.replace(
			/codemode scripts and non-LLM models such as classifiers and image models \(docs\/codemode\.md\)/g,
			"programmatic tool use, classification, and image generation (docs/codemode.md)",
		));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return a replacement only when a supported provider and known text match. */
export function rewriteAntigravityPayload(provider: string | undefined, payload: unknown): unknown {
	if (provider !== "antigravity" && provider !== "google-antigravity") return undefined;
	if (!isRecord(payload) || !isRecord(payload.request)) return undefined;
	const request = payload.request;
	if (!isRecord(request.systemInstruction)) return undefined;
	const instruction = request.systemInstruction;
	if (!Array.isArray(instruction.parts)) return undefined;

	let changed = false;
	const parts = instruction.parts.map(part => {
		if (!isRecord(part) || typeof part.text !== "string") return part;
		const text = rewriteAntigravitySystemText(part.text);
		if (text === part.text) return part;
		changed = true;
		return { ...part, text };
	});
	if (!changed) return undefined;
	return {
		...payload,
		request: { ...request, systemInstruction: { ...instruction, parts } },
	};
}

export default function antigravityPromptCompatibility(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		if (/^(?:off|0|false)$/i.test(process.env.ANTIGRAVITY_PROMPT_COMPAT?.trim() ?? "")) return;
		return rewriteAntigravityPayload(ctx.model?.provider, event.payload);
	});
}
