// antigravity-map: self-healing patch extension
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export default function fixAntigravityMap(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const homeDir = os.homedir();
		const packageDir = path.join(homeDir, ".pi/agent/npm/node_modules/@yofriadi/pi-antigravity-oauth");
		const modelsPath = path.join(packageDir, "src/models.ts");
		const cloudCodeAssistPath = path.join(packageDir, "src/cloud-code-assist.ts");

		if (!fs.existsSync(modelsPath) || !fs.existsSync(cloudCodeAssistPath)) {
			return;
		}

		try {
			// Patch models.ts
			const modelsContent = fs.readFileSync(modelsPath, "utf-8");
			const modelsResult = patchModelsFile(modelsContent);
			if (modelsResult.modified) {
				fs.writeFileSync(modelsPath, modelsResult.content, "utf-8");
				ctx.ui.notify("antigravity-map: patched models.ts", "info");
			}

			// Patch cloud-code-assist.ts
			const ccaContent = fs.readFileSync(cloudCodeAssistPath, "utf-8");
			const ccaResult = patchCloudCodeAssistFile(ccaContent);
			if (ccaResult.modified) {
				fs.writeFileSync(cloudCodeAssistPath, ccaResult.content, "utf-8");
				ctx.ui.notify("antigravity-map: patched cloud-code-assist.ts", "info");
			}
		} catch (error) {
			// Fail silently to not disrupt the user session
		}
	});
}

function patchModelsFile(content: string): { content: string; modified: boolean } {
	let modified = false;

	if (content.includes("// [antigravity-map-patch] gemini-3.6-flash")) {
		return { content, modified: false };
	}

	const patches = [
		{
			id: "claude-opus-4-6",
			map: `// [antigravity-map-patch] claude-opus-4-6
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
		},`
		},
		{
			id: "claude-sonnet-4-6",
			map: `// [antigravity-map-patch] claude-sonnet-4-6
		thinkingLevelMap: {
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
		},`
		},
		{
			id: "gemini-3.5-flash",
			map: `// [antigravity-map-patch] gemini-3.5-flash
		thinkingLevelMap: {
			off: "off",
			minimal: "minimal",
			low: "low",
			medium: null,
			high: null,
			xhigh: null,
		},`
		},
		{
			id: "gemini-3.1-pro",
			map: `// [antigravity-map-patch] gemini-3.1-pro
		thinkingLevelMap: {
			off: "low",
			minimal: "low",
			medium: null,
			xhigh: null,
		},`
		},
		{
			// gemini-3.6-flash: low/medium/high all valid; extra-low does not exist.
			id: "gemini-3.6-flash",
			map: `// [antigravity-map-patch] gemini-3.6-flash
		thinkingLevelMap: {
			xhigh: null,
		},`
		}
	];

	let newContent = content;

	for (const p of patches) {
		const idStr = `id: "${p.id}"`;
		const idIdx = newContent.indexOf(idStr);
		if (idIdx === -1) continue;

		let endIdx = newContent.indexOf('id: "', idIdx + idStr.length);
		if (endIdx === -1) {
			endIdx = newContent.indexOf('];', idIdx);
		}
		if (endIdx === -1) {
			endIdx = newContent.length;
		}

		const block = newContent.slice(idIdx, endIdx);
		const mapStart = block.indexOf("thinkingLevelMap:");
		if (mapStart !== -1) {
			const braceStart = block.indexOf("{", mapStart);
			let braceCount = 1;
			let currentIdx = braceStart + 1;
			while (braceCount > 0 && currentIdx < block.length) {
				if (block[currentIdx] === "{") {
					braceCount++;
				} else if (block[currentIdx] === "}") {
					braceCount--;
				}
				currentIdx++;
			}
			if (block[currentIdx] === ",") {
				currentIdx++;
			}
			const oldMapBlock = block.slice(mapStart, currentIdx);
			const updatedBlock = block.replace(oldMapBlock, p.map);
			newContent = newContent.slice(0, idIdx) + updatedBlock + newContent.slice(idIdx + block.length);
			modified = true;
		} else {
			const lastBraceIdx = block.lastIndexOf("}");
			if (lastBraceIdx !== -1) {
				const beforeBrace = block.slice(0, lastBraceIdx);
				const afterBrace = block.slice(lastBraceIdx);
				const insert = beforeBrace.trim().endsWith(",") ? `\n\t\t${p.map}` : `,\n\t\t${p.map}`;
				const updatedBlock = beforeBrace + insert + afterBrace;
				newContent = newContent.slice(0, idIdx) + updatedBlock + newContent.slice(idIdx + block.length);
				modified = true;
			}
		}
	}

	return { content: newContent, modified };
}

function patchCloudCodeAssistFile(content: string): { content: string; modified: boolean } {
	let modified = false;

	if (content.includes("[156]")) {
		return { content, modified: false };
	}

	const targetFunc = "function isGemini3FlashModel";
	const funcIdx = content.indexOf(targetFunc);
	if (funcIdx === -1) {
		return { content, modified: false };
	}

	const endIdx = content.indexOf("}", funcIdx);
	if (endIdx === -1) {
		return { content, modified: false };
	}

	const block = content.slice(funcIdx, endIdx + 1);
	// Match any of: original unpatched, or previously patched with [15] (upgrade to [156])
	const oldRegex1 = "/gemini-3(?:\\.1)?-flash/";
	const oldRegex2 = "/gemini-3(?:\\.[15])?-flash/";
	const newRegex = "/* [antigravity-map-patch] isGemini3FlashModel */ /gemini-3(?:\\.[156])?-flash/";
	if (block.includes(oldRegex1) || (block.includes(oldRegex2) && !block.includes("[156]"))) {
		const updatedBlock = block
			.replace(oldRegex1, newRegex)
			.replace(oldRegex2, newRegex);
		const newContent = content.slice(0, funcIdx) + updatedBlock + content.slice(endIdx + 1);
		return { content: newContent, modified: true };
	}

	return { content, modified };
}
