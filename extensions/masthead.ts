/**
 * Masthead Extension for Pi
 *
 * Displays a summarized session title, start date and time, and current GitHub PR
 * on the topmost masthead (TUI header) of Pi.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PrDetails {
	number: number;
	title: string;
	state: string; // OPEN, MERGED, CLOSED
}

export interface MastheadState {
	enabled: boolean;
	title: string;
	started: string;
	prText: string;
	pr?: PrDetails;
	branch?: string;
	isGitRepo: boolean;
	loadingPr: boolean;
	lastFetchTime: number;
	cwd: string;
}

export function formatSessionStart(isoTimestamp?: string): string {
	if (!isoTimestamp) {
		const now = new Date();
		return formatLocalDateTime(now);
	}
	const d = new Date(isoTimestamp);
	if (Number.isNaN(d.getTime())) return isoTimestamp;
	return formatLocalDateTime(d);
}

export function formatLocalDateTime(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const year = d.getFullYear();
	const month = pad(d.getMonth() + 1);
	const day = pad(d.getDate());
	const hours = pad(d.getHours());
	const mins = pad(d.getMinutes());
	const secs = pad(d.getSeconds());
	return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
}

export function resolveSessionTitle(sessionManager?: SessionManager): string {
	if (!sessionManager) return "New Session";

	const customName = sessionManager.getSessionName?.();
	if (customName && customName.trim()) {
		return customName.trim();
	}

	const branch = sessionManager.getBranch?.() ?? [];
	for (const entry of branch) {
		if (entry.type === "message" && entry.message && entry.message.role === "user") {
			const rawContent = entry.message.content;
			let text = "";
			if (typeof rawContent === "string") {
				text = rawContent;
			} else if (Array.isArray(rawContent)) {
				text = rawContent
					.filter((p: any) => p && p.type === "text" && typeof p.text === "string")
					.map((p: any) => p.text)
					.join(" ");
			}
			const firstLine = text.replace(/[\r\n]+/g, " ").trim();
			if (firstLine) {
				return firstLine;
			}
		}
	}

	return "New Session";
}

export async function fetchGitPr(cwd: string): Promise<{
	isGitRepo: boolean;
	branch?: string;
	pr?: PrDetails;
	prText: string;
}> {
	try {
		const { stdout: isGit } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd,
			timeout: 3000,
		});
		if (isGit.trim() !== "true") {
			return { isGitRepo: false, prText: "None (not a git repo)" };
		}
	} catch {
		return { isGitRepo: false, prText: "None (not a git repo)" };
	}

	let branch = "HEAD";
	try {
		const { stdout: branchOut } = await execFileAsync("git", ["branch", "--show-current"], {
			cwd,
			timeout: 3000,
		});
		const trimmed = branchOut.trim();
		if (trimmed) {
			branch = trimmed;
		} else {
			const { stdout: headOut } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
				cwd,
				timeout: 3000,
			});
			branch = headOut.trim() || "HEAD";
		}
	} catch {
		branch = "HEAD";
	}

	try {
		const { stdout: prOut } = await execFileAsync("gh", ["pr", "view", "--json", "number,title,state"], {
			cwd,
			timeout: 5000,
		});
		const prData = JSON.parse(prOut);
		if (prData && typeof prData.number === "number") {
			const state = String(prData.state || "OPEN").toUpperCase();
			const title = String(prData.title || "").trim();
			return {
				isGitRepo: true,
				branch,
				pr: {
					number: prData.number,
					title,
					state,
				},
				prText: `#${prData.number}: ${title} [${state}]`,
			};
		}
	} catch {
		// gh pr view returns non-zero when no PR is open on current branch or if gh is unauthenticated
		return {
			isGitRepo: true,
			branch,
			prText: `No PR (${branch})`,
		};
	}

	return {
		isGitRepo: true,
		branch,
		prText: `No PR (${branch})`,
	};
}

export class MastheadComponent implements Component {
	public state: MastheadState;
	private theme: Theme;

	constructor(state: MastheadState, theme: Theme) {
		this.state = state;
		this.theme = theme;
	}

	render(width: number): string[] {
		if (!this.state.enabled) {
			return [];
		}

		const title = this.state.title;
		const started = this.state.started;
		const prText = this.state.prText;

		// Compact single-line fallback for very narrow terminals (e.g. mobile portrait < 38 cols)
		if (width < 38) {
			return [
				this.theme.fg("accent", "π ") + this.theme.fg("text", truncateToWidth(title, Math.max(0, width - 2), "...")),
				this.theme.fg("accent", "Started: ") + this.theme.fg("muted", truncateToWidth(started, Math.max(0, width - 9), "...")),
				this.theme.fg("accent", "PR: ") + this.theme.fg("muted", truncateToWidth(prText, Math.max(0, width - 4), "...")),
				"",
			];
		}

		const badgeText = " π Pi ";
		const topPrefix = "┌─" + badgeText;
		const topDashesCount = Math.max(0, width - visibleWidth(topPrefix) - 1);
		const topBorder =
			this.theme.fg("border", "┌─") +
			this.theme.fg("accent", this.theme.bold(badgeText)) +
			this.theme.fg("border", "─".repeat(topDashesCount) + "┐");
		const bottomBorder = this.theme.fg("border", "└" + "─".repeat(Math.max(0, width - 2)) + "┘");

		const innerWidth = Math.max(10, width - 4); // "│ " and " │"

		// Helper to format generic row with exact right-border alignment
		const formatRow = (
			label: string,
			plainValue: string,
			stylizeValue?: (val: string) => string,
		): string => {
			const labelWidth = visibleWidth(label);
			const maxValWidth = Math.max(0, innerWidth - labelWidth);
			const truncated = truncateToWidth(plainValue, maxValWidth, "...");
			const valWidth = visibleWidth(truncated);
			const pad = Math.max(0, innerWidth - labelWidth - valWidth);

			const styledVal = stylizeValue ? stylizeValue(truncated) : this.theme.fg("text", truncated);
			return (
				this.theme.fg("border", "│ ") +
				this.theme.fg("accent", label) +
				styledVal +
				" ".repeat(pad) +
				this.theme.fg("border", " │")
			);
		};

		// Helper to format PR row with custom color-coded badges
		const formatPrRow = (): string => {
			const label = "PR:      ";
			const labelWidth = visibleWidth(label);
			const maxValWidth = Math.max(0, innerWidth - labelWidth);

			if (this.state.pr) {
				const pr = this.state.pr;
				const stateColor = pr.state === "OPEN" ? "accent" : pr.state === "MERGED" ? "muted" : "dim";
				const prefix = `#${pr.number}: `;
				const suffix = ` [${pr.state}]`;
				const fixedWidth = visibleWidth(prefix) + visibleWidth(suffix);

				if (maxValWidth < fixedWidth) {
					const plain = truncateToWidth(`#${pr.number} [${pr.state}]`, maxValWidth, "...");
					const pad = Math.max(0, maxValWidth - visibleWidth(plain));
					return (
						this.theme.fg("border", "│ ") +
						this.theme.fg("accent", label) +
						this.theme.fg("muted", plain) +
						" ".repeat(pad) +
						this.theme.fg("border", " │")
					);
				}

				const availTitleWidth = maxValWidth - fixedWidth;
				const truncatedTitle = truncateToWidth(pr.title, availTitleWidth, "...");
				const styled =
					this.theme.fg("success", prefix) +
					this.theme.fg("text", truncatedTitle) +
					this.theme.fg(stateColor, suffix);

				const contentWidth = labelWidth + fixedWidth + visibleWidth(truncatedTitle);
				const pad = Math.max(0, innerWidth - contentWidth);
				return (
					this.theme.fg("border", "│ ") +
					this.theme.fg("accent", label) +
					styled +
					" ".repeat(pad) +
					this.theme.fg("border", " │")
				);
			}

			const plain = truncateToWidth(prText, maxValWidth, "...");
			const pad = Math.max(0, innerWidth - labelWidth - visibleWidth(plain));
			const color = !this.state.isGitRepo ? "dim" : "muted";
			return (
				this.theme.fg("border", "│ ") +
				this.theme.fg("accent", label) +
				this.theme.fg(color, plain) +
				" ".repeat(pad) +
				this.theme.fg("border", " │")
			);
		};

		const titleRow = formatRow("Title:   ", title, (val) => this.theme.fg("text", val));
		const startedRow = formatRow("Started: ", started, (val) => this.theme.fg("muted", val));
		const prRow = formatPrRow();

		return [topBorder, titleRow, startedRow, prRow, bottomBorder, ""];
	}
}

export default function mastheadExtension(pi: ExtensionAPI): void {
	const state: MastheadState = {
		enabled: true,
		title: "New Session",
		started: formatLocalDateTime(new Date()),
		prText: "Checking PR...",
		isGitRepo: false,
		loadingPr: false,
		lastFetchTime: 0,
		cwd: "",
	};

	let activeTui: TUI | undefined;

	const updateSessionMetadata = (ctx: ExtensionContext) => {
		if (ctx.sessionManager) {
			const headerTime = ctx.sessionManager.getHeader?.()?.timestamp;
			state.started = formatSessionStart(headerTime);
			state.title = resolveSessionTitle(ctx.sessionManager);
		}
	};

	const triggerPrFetch = (cwd: string, force = false) => {
		const now = Date.now();
		if (!force && state.loadingPr) return;
		if (!force && state.cwd === cwd && now - state.lastFetchTime < 15000) return;

		state.cwd = cwd;
		state.loadingPr = true;
		state.lastFetchTime = now;

		fetchGitPr(cwd)
			.then((res) => {
				state.loadingPr = false;
				state.isGitRepo = res.isGitRepo;
				state.branch = res.branch;
				state.pr = res.pr;
				state.prText = res.prText;
				activeTui?.requestRender();
			})
			.catch(() => {
				state.loadingPr = false;
				state.prText = "Unavailable";
				activeTui?.requestRender();
			});
	};

	pi.on("session_start", async (_event, ctx) => {
		updateSessionMetadata(ctx);
		state.cwd = ctx.cwd || process.cwd();
		triggerPrFetch(state.cwd, true);

		if (ctx.mode === "tui" || ctx.hasUI) {
			ctx.ui.setHeader((tui, theme) => {
				activeTui = tui;
				return new MastheadComponent(state, theme);
			});
		}
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		updateSessionMetadata(ctx);
		activeTui?.requestRender();
	});

	pi.on("session_tree", async (_event, ctx) => {
		updateSessionMetadata(ctx);
		activeTui?.requestRender();
	});

	pi.on("message_end", async (event, ctx) => {
		if ((event as any)?.message?.role === "user") {
			updateSessionMetadata(ctx);
			activeTui?.requestRender();
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateSessionMetadata(ctx);
		// Opportunistic PR check after tool actions (throttled to 30s)
		const now = Date.now();
		if (now - state.lastFetchTime > 30000) {
			triggerPrFetch(ctx.cwd || process.cwd());
		} else {
			activeTui?.requestRender();
		}
	});

	pi.on("session_shutdown", () => {
		activeTui = undefined;
	});

	const handleHeaderCommand = async (rawArgs: string, ctx: ExtensionCommandContext) => {
		const sub = rawArgs.trim().toLowerCase();

		if (sub === "toggle") {
			state.enabled = !state.enabled;
			if (state.enabled) {
				ctx.ui.setHeader((tui, theme) => {
					activeTui = tui;
					return new MastheadComponent(state, theme);
				});
				ctx.ui.notify("Pi header enabled", "info");
			} else {
				ctx.ui.setHeader(undefined);
				ctx.ui.notify("Pi header disabled (default header restored)", "info");
			}
			activeTui?.requestRender();
			return;
		}

		if (sub === "status") {
			const prDetails = state.pr
				? `#${state.pr.number} (${state.pr.state})`
				: state.isGitRepo
					? `No PR (${state.branch || "HEAD"})`
					: "Not a git repo";
			ctx.ui.notify(
				`Pi Header State:\n• Title: ${state.title}\n• Started: ${state.started}\n• PR: ${prDetails}\n• Visible: ${state.enabled ? "Yes" : "No"}`,
				"info",
			);
			return;
		}

		// Default action or "refresh"
		triggerPrFetch(ctx.cwd || process.cwd(), true);
		updateSessionMetadata(ctx);
		activeTui?.requestRender();
		ctx.ui.notify("Pi header refreshed", "info");
	};

	pi.registerCommand("header", {
		description: "Control topmost Pi header (refresh | toggle | status)",
		handler: handleHeaderCommand,
	});

	pi.registerCommand("masthead", {
		description: "Alias for /header",
		handler: handleHeaderCommand,
	});
}
