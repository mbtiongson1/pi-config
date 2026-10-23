import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const UPDATE_INTERVAL_MS = 60_000;
const WARNING_AFTER_MINUTES = 30;
const ERROR_AFTER_MINUTES = 60;

function getLastMessageAt(ctx: ExtensionContext): number | undefined {
	const timestamps = ctx.sessionManager
		.getBranch()
		.filter((entry: SessionEntry) => entry.type === "message")
		.map(entry => Date.parse(entry.timestamp))
		.filter(timestamp => Number.isFinite(timestamp));

	return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

function renderStatus(ctx: ExtensionContext): void {
	const lastMessageAt = getLastMessageAt(ctx);
	if (lastMessageAt === undefined) {
		ctx.ui.setStatus("last-message", undefined);
		return;
	}

	const minutesAgo = Math.max(0, Math.floor((Date.now() - lastMessageAt) / 60_000));
	const age = `${minutesAgo} mins ago`;
	const color = minutesAgo >= ERROR_AFTER_MINUTES
		? "error"
		: minutesAgo >= WARNING_AFTER_MINUTES
			? "warning"
			: "dim";

	ctx.ui.setStatus("last-message", ctx.ui.theme.fg(color, age));
}

export default function lastMessageStatusExtension(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		renderStatus(ctx);
		timer = setInterval(() => renderStatus(ctx), UPDATE_INTERVAL_MS);
	});

	pi.on("message_end", (_event, ctx) => {
		if (ctx.mode === "tui") renderStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	});
}
