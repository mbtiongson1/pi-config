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
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PrDetails {
	number: number;
	title: string;
	state: string; // OPEN, MERGED, CLOSED
	headRefName?: string;
	baseRefName?: string;
	url?: string;
}

export interface MastheadState {
	enabled: boolean;
	title: string;
	started: string;
	prText: string;
	pr?: PrDetails;
	branch?: string;
	defaultBranch?: string;
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

/**
 * Resolve the default primary branch of a repository without hardcoding 'main'.
 * Follows Claude Code's approach:
 * 1. Checks git symbolic-ref refs/remotes/origin/HEAD
 * 2. Checks remote tracking heads (origin/main, origin/master, origin/develop, origin/trunk)
 * 3. Checks git config init.defaultBranch
 * 4. Checks local branch refs
 */
export async function resolveDefaultBranch(cwd: string): Promise<string | undefined> {
	// 1. Try remote HEAD symbolic-ref (most accurate)
	try {
		const { stdout } = await execFileAsync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd,
			timeout: 3000,
		});
		const match = stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
		if (match && match[1]) {
			return match[1].trim();
		}
	} catch {}

	// 2. Check remote tracking refs for common default branch names
	for (const candidate of ["main", "master", "develop", "trunk"]) {
		try {
			await execFileAsync("git", ["rev-parse", "--verify", `refs/remotes/origin/${candidate}`], {
				cwd,
				timeout: 2000,
			});
			return candidate;
		} catch {}
	}

	// 3. Check git config init.defaultBranch
	try {
		const { stdout } = await execFileAsync("git", ["config", "init.defaultBranch"], {
			cwd,
			timeout: 2000,
		});
		const trimmed = stdout.trim();
		if (trimmed) return trimmed;
	} catch {}

	// 4. Check local branches
	for (const candidate of ["main", "master"]) {
		try {
			await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${candidate}`], {
				cwd,
				timeout: 2000,
			});
			return candidate;
		} catch {}
	}

	return undefined;
}

export function parseRepoFromRemoteUrl(url?: string): string | undefined {
	if (!url) return undefined;
	const clean = url.trim().replace(/\.git$/, "");
	const match = clean.match(/[:/]([^/:]+\/[^/:]+)$/);
	return match ? match[1] : undefined;
}

/**
 * Checks out a pull request accurately without assuming or defaulting to 'main'.
 * Matches Claude Code's PR checkout workflow:
 * - Queries PR metadata via GitHub CLI
 * - Resolves exact headRefName and baseRefName
 * - Performs accurate checkout and tracking setup
 */
export async function checkoutPr(
	cwd: string,
	prTarget: string | number,
): Promise<{ success: boolean; message: string; branch?: string; pr?: PrDetails }> {
	try {
		const targetStr = String(prTarget).trim();
		if (!targetStr) {
			return { success: false, message: "No PR number or branch specified" };
		}

		// 1. Resolve PR details from GitHub
		const { stdout: viewOut } = await execFileAsync(
			"gh",
			["pr", "view", targetStr, "--json", "number,title,state,headRefName,headRepositoryOwner,baseRefName,url"],
			{ cwd, timeout: 10000 },
		);
		const prData = JSON.parse(viewOut);
		if (!prData || typeof prData.number !== "number") {
			return { success: false, message: `Could not find PR ${targetStr}` };
		}

		const pr: PrDetails = {
			number: prData.number,
			title: String(prData.title || "").trim(),
			state: String(prData.state || "OPEN").toUpperCase(),
			headRefName: prData.headRefName,
			baseRefName: prData.baseRefName,
			url: prData.url,
		};

		// 2. Checkout using gh pr checkout
		const { stdout: coOut, stderr: coErr } = await execFileAsync(
			"gh",
			["pr", "checkout", String(pr.number)],
			{ cwd, timeout: 20000 },
		);

		// 3. Resolve resulting branch
		let currentBranch = pr.headRefName;
		try {
			const { stdout: bOut } = await execFileAsync("git", ["branch", "--show-current"], { cwd, timeout: 3000 });
			const trimmed = bOut.trim();
			if (trimmed) currentBranch = trimmed;
		} catch {}

		const base = pr.baseRefName || "main";
		const outputMsg = coOut.trim() || coErr.trim() || `Checked out PR #${pr.number} (${currentBranch})`;

		return {
			success: true,
			message: `Checked out PR #${pr.number} [${pr.state}] onto branch '${currentBranch}' (base: '${base}')\n${outputMsg}`,
			branch: currentBranch,
			pr,
		};
	} catch (err: any) {
		return {
			success: false,
			message: `Failed to checkout PR ${prTarget}: ${err.message || String(err)}`,
		};
	}
}

/**
 * Accurately fetches git and PR metadata for a directory.
 * Implements Claude Code's PR resolution pattern:
 * 1. Checks current branch against GitHub PR
 * 2. Checks upstream tracking branch if different
 * 3. If not on default branch:
 *    a. Tests branch/directory name pattern (e.g. pr2147, fix/pr-2230)
 *    b. Tests commit SHA against GitHub API commits/:sha/pulls
 *    c. Tests recent commit messages for (#<number>)
 * 4. Resolves default branch dynamically without hardcoded 'main'
 */
export async function fetchGitPr(cwd: string): Promise<{
	isGitRepo: boolean;
	branch?: string;
	defaultBranch?: string;
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

	const defaultBranch = await resolveDefaultBranch(cwd);

	// 1. Direct gh pr view for current branch
	try {
		const { stdout: prOut } = await execFileAsync(
			"gh",
			["pr", "view", "--json", "number,title,state,headRefName,baseRefName,url"],
			{ cwd, timeout: 5000 },
		);
		const prData = JSON.parse(prOut);
		if (prData && typeof prData.number === "number") {
			const state = String(prData.state || "OPEN").toUpperCase();
			const title = String(prData.title || "").trim();
			const pr: PrDetails = {
				number: prData.number,
				title,
				state,
				headRefName: prData.headRefName,
				baseRefName: prData.baseRefName,
				url: prData.url,
			};
			return {
				isGitRepo: true,
				branch,
				defaultBranch,
				pr,
				prText: `#${pr.number}: ${title} [${state}]`,
			};
		}
	} catch {}

	// 2. Upstream tracking branch
	try {
		const { stdout: upOut } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
			cwd,
			timeout: 3000,
		});
		const upstream = upOut.trim().replace(/^[^/]+\//, "");
		if (upstream && upstream !== branch) {
			const { stdout: prOut } = await execFileAsync(
				"gh",
				["pr", "view", upstream, "--json", "number,title,state,headRefName,baseRefName,url"],
				{ cwd, timeout: 5000 },
			);
			const prData = JSON.parse(prOut);
			if (prData && typeof prData.number === "number") {
				const state = String(prData.state || "OPEN").toUpperCase();
				const title = String(prData.title || "").trim();
				const pr: PrDetails = {
					number: prData.number,
					title,
					state,
					headRefName: prData.headRefName,
					baseRefName: prData.baseRefName,
					url: prData.url,
				};
				return {
					isGitRepo: true,
					branch,
					defaultBranch,
					pr,
					prText: `#${pr.number}: ${title} [${state}]`,
				};
			}
		}
	} catch {}

	// Determine if current branch is the repository default branch
	const isDefaultBranch = defaultBranch ? branch === defaultBranch : branch === "main" || branch === "master";

	// If not on default branch (or in detached HEAD / worktree), search heuristics:
	if (!isDefaultBranch) {
		// 3. Extract PR number from branch name, cwd folder name, or worktree path
		const textToSearch = `${branch} ${path.basename(cwd)}`;
		const prMatch =
			textToSearch.match(/pr[-_/]?(\d{1,6})/i) ||
			textToSearch.match(/(?:^|[-_/])(\d{2,6})(?:[-_/]|$)/);
		if (prMatch && prMatch[1]) {
			const candidatePr = prMatch[1];
			try {
				const { stdout: prOut } = await execFileAsync(
					"gh",
					["pr", "view", candidatePr, "--json", "number,title,state,headRefName,baseRefName,url"],
					{ cwd, timeout: 5000 },
				);
				const prData = JSON.parse(prOut);
				if (prData && typeof prData.number === "number") {
					const state = String(prData.state || "OPEN").toUpperCase();
					const title = String(prData.title || "").trim();
					const pr: PrDetails = {
						number: prData.number,
						title,
						state,
						headRefName: prData.headRefName,
						baseRefName: prData.baseRefName,
						url: prData.url,
					};
					return {
						isGitRepo: true,
						branch,
						defaultBranch,
						pr,
						prText: `#${pr.number}: ${title} [${state}]`,
					};
				}
			} catch {}
		}

		// 4. Commit SHA lookup via GitHub API
		try {
			const { stdout: shaOut } = await execFileAsync("git", ["rev-parse", "HEAD"], {
				cwd,
				timeout: 3000,
			});
			const sha = shaOut.trim();
			const { stdout: remoteOut } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], {
				cwd,
				timeout: 3000,
			});
			const repo = parseRepoFromRemoteUrl(remoteOut);
			if (repo && sha) {
				const { stdout: apiOut } = await execFileAsync("gh", ["api", `repos/${repo}/commits/${sha}/pulls`], {
					cwd,
					timeout: 5000,
				});
				const prs = JSON.parse(apiOut);
				if (Array.isArray(prs) && prs.length > 0) {
					const prObj = prs.find((p: any) => p && p.state === "open") || prs[0];
					if (prObj && typeof prObj.number === "number") {
						const state = String(prObj.state || "OPEN").toUpperCase();
						const title = String(prObj.title || "").trim();
						const pr: PrDetails = {
							number: prObj.number,
							title,
							state,
							headRefName: prObj.head?.ref,
							baseRefName: prObj.base?.ref,
							url: prObj.html_url,
						};
						return {
							isGitRepo: true,
							branch,
							defaultBranch,
							pr,
							prText: `#${pr.number}: ${title} [${state}]`,
						};
					}
				}
			}
		} catch {}

		// 5. Recent commit message check for (#\d+)
		try {
			const { stdout: logOut } = await execFileAsync("git", ["log", "-3", "--pretty=%s"], {
				cwd,
				timeout: 3000,
			});
			const logMatch = logOut.match(/\(#(\d+)\)/) || logOut.match(/pull request #(\d+)/i);
			if (logMatch && logMatch[1]) {
				const candidatePr = logMatch[1];
				try {
					const { stdout: prOut } = await execFileAsync(
						"gh",
						["pr", "view", candidatePr, "--json", "number,title,state,headRefName,baseRefName,url"],
						{ cwd, timeout: 5000 },
					);
					const prData = JSON.parse(prOut);
					if (prData && typeof prData.number === "number") {
						const state = String(prData.state || "OPEN").toUpperCase();
						const title = String(prData.title || "").trim();
						const pr: PrDetails = {
							number: prData.number,
							title,
							state,
							headRefName: prData.headRefName,
							baseRefName: prData.baseRefName,
							url: prData.url,
						};
						return {
							isGitRepo: true,
							branch,
							defaultBranch,
							pr,
							prText: `#${pr.number}: ${title} [${state}]`,
						};
					}
				} catch {}
			}
		} catch {}
	}

	return {
		isGitRepo: true,
		branch,
		defaultBranch,
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
				state.defaultBranch = res.defaultBranch;
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
					? `No PR (branch: ${state.branch || "HEAD"}, default: ${state.defaultBranch || "unknown"})`
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

	const handlePrCommand = async (rawArgs: string, ctx: ExtensionCommandContext) => {
		const args = rawArgs.trim().split(/\s+/).filter(Boolean);
		const sub = (args[0] || "").toLowerCase();

		if (sub === "checkout" || sub === "co") {
			const target = args[1];
			if (!target) {
				ctx.ui.notify("Usage: /pr checkout <number|branch>", "warning");
				return;
			}
			ctx.ui.notify(`Checking out PR ${target}...`, "info");
			const result = await checkoutPr(ctx.cwd || process.cwd(), target);
			if (result.success) {
				triggerPrFetch(ctx.cwd || process.cwd(), true);
				ctx.ui.notify(`✓ ${result.message}`, "info");
			} else {
				ctx.ui.notify(`✗ ${result.message}`, "error");
			}
			activeTui?.requestRender();
			return;
		}

		if (sub === "view" || sub === "status" || !sub) {
			const prDetails = state.pr
				? `#${state.pr.number}: ${state.pr.title} [${state.pr.state}]`
				: state.isGitRepo
					? `No PR (Branch: ${state.branch || "HEAD"}, Default: ${state.defaultBranch || "unknown"})`
					: "Not a git repo";
			ctx.ui.notify(`Current PR Status:\n${prDetails}`, "info");
			return;
		}

		if (sub === "refresh") {
			triggerPrFetch(ctx.cwd || process.cwd(), true);
			ctx.ui.notify("PR status refreshed", "info");
			return;
		}

		// Direct number: /pr 2147 -> checkout 2147
		if (/^\d+$/.test(sub)) {
			ctx.ui.notify(`Checking out PR #${sub}...`, "info");
			const result = await checkoutPr(ctx.cwd || process.cwd(), sub);
			if (result.success) {
				triggerPrFetch(ctx.cwd || process.cwd(), true);
				ctx.ui.notify(`✓ ${result.message}`, "info");
			} else {
				ctx.ui.notify(`✗ ${result.message}`, "error");
			}
			activeTui?.requestRender();
			return;
		}

		ctx.ui.notify("Usage: /pr [status | checkout <num> | refresh | <num>]", "warning");
	};

	pi.registerCommand("header", {
		description: "Control topmost Pi header (refresh | toggle | status)",
		handler: handleHeaderCommand,
	});

	pi.registerCommand("masthead", {
		description: "Alias for /header",
		handler: handleHeaderCommand,
	});

	pi.registerCommand("pr", {
		description: "View or checkout PRs accurately (status | checkout <num> | refresh)",
		handler: handlePrCommand,
	});
}
