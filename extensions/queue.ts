/**
 * Torrent Download Queue Extension for Pi
 *
 * Capabilities:
 * - /queue <title> [ep] [res] : Fast, offline queue addition (0 tokens)
 *   Ex: /queue Dark item 06 1080p
 * - /queue start : Process and download all queued torrents sequentially (when on Wi-Fi)
 * - /queue list / status : Inspect queued items and states (pending, downloading, complete, failed)
 * - /queue clear : Remove finished items from the queue
 * - /queue remove <id> : Remove specific item from the queue
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

function findQueueScript(): string | null {
	const home = process.env.HOME || "/data/data/com.termux/files/home";
	const candidates = [
		path.join(home, ".pi/agent/skills/download/scripts/queue.py"),
		path.join(home, "pi-config/skills/download/scripts/queue.py"),
		path.join(getAgentDir(), "skills/download/scripts/queue.py"),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	return null;
}

function runQueueCli(args: string[]): { success: boolean; data?: any; raw?: string; error?: string } {
	const script = findQueueScript();
	if (!script) {
		return { success: false, error: "queue.py script not found in skills/download/scripts" };
	}
	try {
		const proc = spawnSync("python3", [script, ...args], {
			encoding: "utf-8",
			timeout: 10000,
		});
		const stdout = (proc.stdout || "").trim();
		const stderr = (proc.stderr || "").trim();

		try {
			const json = JSON.parse(stdout);
			return { success: proc.status === 0 && json.success !== false, data: json, raw: stdout };
		} catch {
			return {
				success: proc.status === 0,
				raw: stdout || stderr,
				error: proc.status !== 0 ? (stderr || stdout || `Process exited with code ${proc.status}`) : undefined,
			};
		}
	} catch (err: any) {
		return { success: false, error: String(err?.message || err) };
	}
}

export default function queueExtension(pi: ExtensionAPI): void {
	pi.registerCommand("queue", {
		description: "Manage torrent download queue: /queue <title> [ep] [res] | /queue start | /queue list | /queue clear",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const subcommands = [
				{ name: "start", desc: "Download all queued torrents sequentially (when on Wi-Fi)" },
				{ name: "list", desc: "Show torrent download queue" },
				{ name: "status", desc: "Show queue status and counts" },
				{ name: "clear", desc: "Clear finished items from queue" },
				{ name: "remove", desc: "Remove an item by ID from queue" },
				{ name: "help", desc: "Show queue command help" },
			];
			return subcommands
				.filter(cmd => cmd.name.startsWith(query))
				.map(cmd => ({ value: `${cmd.name} `, label: `${cmd.name} - ${cmd.desc}` }));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const lower = trimmed.toLowerCase();

			// Case 1: Help
			if (lower === "help" || lower === "--help" || lower === "-h") {
				const helpMsg = [
					"📥 Torrent Download Queue Commands:",
					"  • /queue <title> [ep] [res]  Add item (e.g. /queue Dark item 06 1080p)",
					"  • /queue start               Download all pending queue items on Wi-Fi",
					"  • /queue list                Show all items in the queue",
					"  • /queue clear               Remove completed/failed items",
					"  • /queue remove <id>         Remove specific item by ID",
				].join("\n");
				ctx.ui.notify(helpMsg, "info");
				return;
			}

			// Case 2: List / Status / Empty
			if (!trimmed || lower === "list" || lower === "status" || lower === "show") {
				const res = runQueueCli(["list", "--json"]);
				if (!res.success && !res.data) {
					ctx.ui.notify(`Failed to inspect queue: ${res.error || "Unknown error"}`, "error");
					return;
				}
				const data = res.data || {};
				const items = data.items || [];
				const pending = data.pending_count || 0;
				const completed = data.completed_count || 0;
				const failed = data.failed_count || 0;

				if (items.length === 0) {
					ctx.ui.notify("Torrent queue is empty.\nAdd items: /queue <title> [ep] [res] (e.g. /queue Dark item 06 1080p)", "info");
					return;
				}

				const lines = [
					`📋 Queue: ${pending} pending, ${completed} completed, ${failed} failed (${items.length} total)`,
				];
				for (const item of items) {
					const icon = item.status === "completed" ? "✓" : item.status === "failed" ? "✗" : "⏳";
					const ep = item.is_url ? "URL" : `Ep ${item.episode}`;
					const resBadge = item.is_url ? "" : `(${item.resolution})`;
					lines.push(`  ${icon} [#${item.id}] [${item.status.toUpperCase()}] ${item.query} - ${ep} ${resBadge}`);
					if (item.error) {
						lines.push(`       Error: ${item.error}`);
					}
				}
				if (pending > 0) {
					lines.push(`\nTip: When connected to Wi-Fi, run '/queue start' to begin downloads.`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// Case 3: Start Queue Downloads
			if (lower === "start" || lower === "run") {
				const check = runQueueCli(["list", "--json"]);
				const pending = check.data?.pending_count || 0;
				if (pending === 0) {
					ctx.ui.notify("Torrent queue has no pending items to download.", "info");
					return;
				}

				ctx.ui.notify(`🚀 Starting downloads for ${pending} queued torrent(s)...`, "info");

				// Send user message to let the agent supervise and report verified pieces & locations
				if (ctx.isIdle()) {
					pi.sendUserMessage("/queue start");
				} else {
					pi.sendUserMessage("/queue start", { deliverAs: "followUp" });
				}
				return;
			}

			// Case 4: Clear Queue
			if (lower.startsWith("clear")) {
				const clearAll = lower.includes("--all");
				const res = runQueueCli(["clear", clearAll ? "--all" : "", "--json"].filter(Boolean));
				if (res.success && res.data) {
					ctx.ui.notify(`🧹 ${res.data.message} (${res.data.remaining_count} remaining)`, "info");
				} else {
					ctx.ui.notify(`Failed to clear queue: ${res.error || "Unknown error"}`, "error");
				}
				return;
			}

			// Case 5: Remove item
			if (lower.startsWith("remove ") || lower.startsWith("rm ") || lower.startsWith("delete ")) {
				const idStr = trimmed.split(/\s+/)[1];
				const itemId = parseInt(idStr, 10);
				if (isNaN(itemId)) {
					ctx.ui.notify("Usage: /queue remove <id>", "warning");
					return;
				}
				const res = runQueueCli(["remove", String(itemId), "--json"]);
				if (res.success && res.data) {
					ctx.ui.notify(`🗑️ ${res.data.message}`, "info");
				} else {
					ctx.ui.notify(`Failed to remove item #${itemId}: ${res.error || res.data?.message || "Not found"}`, "warning");
				}
				return;
			}

			// Case 6: Add to Queue (default for anything else, e.g. /queue Dark item 06 1080p)
			let queryToAdd = trimmed;
			if (queryToAdd.toLowerCase().startsWith("add ")) {
				queryToAdd = queryToAdd.slice(4).trim();
			}

			const addRes = runQueueCli(["add", queryToAdd, "--json"]);
			if (addRes.success && addRes.data) {
				const item = addRes.data.item;
				const pendingCount = addRes.data.pending_count;
				const epDisp = item.is_url ? "URL" : `Ep ${item.episode}`;
				const resDisp = item.is_url ? "" : `(${item.resolution})`;
				ctx.ui.notify(
					`📥 ${addRes.data.action === "already_queued" ? "Already in queue" : "Added to queue"} [item #${item.id}]:\n` +
					`   ${item.query} - ${epDisp} ${resDisp}\n` +
					`   Pending items: ${pendingCount}. Run '/queue start' when on Wi-Fi.`,
					"info"
				);
			} else {
				ctx.ui.notify(`Failed to add to queue: ${addRes.error || addRes.raw || "Invalid query"}`, "error");
			}
		},
	});
}
