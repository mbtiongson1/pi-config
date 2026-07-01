import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export default function agentsListExtension(pi: ExtensionAPI) {
	pi.registerCommand("agents", {
		description: "List all available subagents programmatically",
		handler: async (args, ctx) => {
			const agentsDir = path.join(getAgentDir(), "agents");
			if (!fs.existsSync(agentsDir)) {
				ctx.ui.notify(`Agents directory not found at ${agentsDir}`, "error");
				return;
			}

			let files: string[] = [];
			try {
				files = fs.readdirSync(agentsDir).filter(f => f.endsWith(".md"));
			} catch (e) {
				ctx.ui.notify(`Failed to read agents directory: ${e}`, "error");
				return;
			}

			const items: string[] = [];
			const agentDetails: Record<string, { model: string; desc: string; filePath: string }> = {};

			for (const file of files) {
				const filePath = path.join(agentsDir, file);
				try {
					const content = fs.readFileSync(filePath, "utf-8");
					const { frontmatter } = parseFrontmatter<Record<string, string>>(content);
					if (frontmatter.name) {
						const model = frontmatter.model || "default";
						const desc = frontmatter.description || "No description";
						const label = `${frontmatter.name} (model: ${model})`;
						items.push(label);
						agentDetails[label] = { model, desc, filePath };
					}
				} catch (err) {
					// ignore parsing issues for specific file
				}
			}

			if (items.length === 0) {
				ctx.ui.notify("No available subagents found", "info");
				return;
			}

			const selected = await ctx.ui.select("Available Subagents", items.sort());
			if (selected && agentDetails[selected]) {
				const details = agentDetails[selected];
				const confirmed = await ctx.ui.confirm(
					selected.split(" (")[0],
					`Description: ${details.desc}\nModel: ${details.model}\nPath: ${details.filePath}\n\nDo you want to notify this model info?`
				);
				if (confirmed) {
					ctx.ui.notify(`Agent: ${selected.split(" (")[0]} | Model: ${details.model}`, "info");
				}
			}
		}
	});
}
