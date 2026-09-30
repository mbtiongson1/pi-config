/**
 * Jev & Reflex Classifier Extension
 *
 * Provides a unified, selectable decision engine:
 *   - "actual": Real TypeSafe Jev classifier via System One / OpenRouter
 *   - "mimic-flash": Gemini 3.8 Flash with thinking: off (low latency, multimodal)
 *   - "mimic-luna": GPT-6 Luna with thinking: off (OpenAI lightweight tier)
 *   - "auto": Prefers actual Jev when authenticated, falls back to mimic-flash
 *
 * Registers:
 *   - Tool: `classify` — Evaluates discrete questions about JSON state in ~100–1500ms
 *   - Command: `/classifier` or `/jev` — Toggles between actual Jev and mimics
 *   - Statusline: Updates `jev-cost` indicator in footer
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type ClassifierEngine = "actual" | "mimic-flash" | "mimic-luna" | "auto";

interface ClassifierConfig {
	engine: ClassifierEngine;
}

const DEFAULT_CONFIG: ClassifierConfig = {
	engine: "auto",
};

function getConfigPath(): string {
	const baseDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(baseDir, "classifier.json");
}

function loadConfig(): ClassifierConfig {
	const p = getConfigPath();
	if (!existsSync(p)) return { ...DEFAULT_CONFIG };
	try {
		const raw = readFileSync(p, "utf-8");
		const data = JSON.parse(raw);
		const engine = ["actual", "mimic-flash", "mimic-luna", "auto"].includes(data.engine)
			? data.engine
			: DEFAULT_CONFIG.engine;
		return { engine };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(cfg: ClassifierConfig): void {
	const p = getConfigPath();
	try {
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
	} catch {}
}

const QuestionSchema = Type.Object({
	type: Type.String({ description: "'choice', 'bool', or 'score'" }),
	instructions: Type.String({ description: "Specific question instructions" }),
	choices: Type.Optional(Type.Array(Type.String(), { description: "Allowed choice labels for 'choice' type" })),
	criteria: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Criteria per label/outcome" })),
});

const ClassifyParameters = Type.Object({
	state: Type.Any({ description: "JSON state or context to evaluate (object, array, or string)" }),
	questions: Type.Record(Type.String(), QuestionSchema, { description: "Map of question keys to question schemas" }),
	engine: Type.Optional(
		Type.String({
			description: "Optional engine override: 'actual', 'mimic-flash', 'mimic-luna', or 'auto'",
		}),
	),
});

export default function jevClassifierExtension(pi: ExtensionAPI): void {
	let config = loadConfig();
	let totalDecisions = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCostUsd = 0;
	let lastEngineUsed: string = config.engine;

	function updateStatusline(ui: any): void {
		if (totalDecisions === 0) {
			const label = config.engine === "auto" ? "auto" : config.engine;
			ui.setStatus("jev-cost", ui.theme ? `${ui.theme.fg("muted", `⚡ Jev [${label}]: idle`)}` : `⚡ Jev [${label}]: idle`);
			return;
		}

		const costFormatted = totalCostUsd < 0.001 ? `$${totalCostUsd.toFixed(5)}` : `$${totalCostUsd.toFixed(4)}`;
		const inTok = totalInputTokens.toLocaleString();
		const tag = `⚡ Jev [${lastEngineUsed}]`;

		const text = ui.theme
			? `${ui.theme.fg("accent", tag)} ${inTok} tok (${ui.theme.fg("success", costFormatted)})`
			: `${tag} ${inTok} tok (${costFormatted})`;

		ui.setStatus("jev-cost", text);
	}

	// Resolve actual Jev classifier model from Pi registry
	async function findActualJev(ctx: ExtensionContext) {
		const candidates = [
			{ provider: "openrouter", id: "~typesafe/jev-latest" },
			{ provider: "openrouter", id: "typesafe/jev-1.13" },
			{ provider: "typesafe", id: "jev-latest" },
			{ provider: "opencode", id: "jev-1.13-free" },
			{ provider: "opencode", id: "jev-1.13" },
		];

		for (const cand of candidates) {
			try {
				const model = await ctx.modelRegistry.getModelOfType("classifier", cand.provider, cand.id);
				if (model) return model;
			} catch {}
		}
		return null;
	}

	// Execute via Actual Jev (System One / TypeSafe)
	async function executeActualJev(jevModel: any, state: any, questions: Record<string, any>, ctx: ExtensionContext) {
		// Ensure criteria exists for each question (System One requires criteria record)
		const normalizedQuestions: Record<string, any> = {};
		for (const [key, q] of Object.entries(questions)) {
			let criteria = q.criteria;
			if (!criteria && q.type === "choice" && Array.isArray(q.choices)) {
				criteria = {};
				for (const c of q.choices) {
					criteria[c] = `Selection for ${c}`;
				}
			} else if (!criteria && q.type === "bool") {
				criteria = { true: "Condition is true / verified", false: "Condition is false / unverified" };
			}
			normalizedQuestions[key] = {
				type: q.type,
				instructions: q.instructions,
				criteria: criteria || {},
			};
		}

		const t0 = Date.now();
		const result = await ctx.modelRegistry.classify(jevModel, {
			state,
			questions: normalizedQuestions,
		});
		const latencyMs = Date.now() - t0;

		const answers: Record<string, any> = {};
		for (const [k, ans] of Object.entries(result.answers || {})) {
			const a = ans as any;
			if (a.type === "choice") {
				answers[k] = {
					value: a.choice,
					confidence: a.confidence ?? 1.0,
					probabilities: a.probabilities,
				};
			} else if (a.type === "bool") {
				answers[k] = {
					value: a.boolean,
					confidence: a.confidence ?? 1.0,
					probabilities: a.probabilities,
				};
			} else {
				answers[k] = a;
			}
		}

		const usage = {
			input: result.usage?.input || 0,
			output: result.usage?.output || 0,
			total: result.usage?.totalTokens || (result.usage?.input || 0) + (result.usage?.output || 0),
			cost: result.usage?.cost?.total || (result.usage?.input || 0) * (0.042 / 1_000_000),
		};

		return {
			engine: "actual",
			model: `${jevModel.provider}/${jevModel.id}`,
			answers,
			latencyMs,
			usage,
		};
	}

	// Execute via Mimic LLM (Gemini 3.8 Flash or GPT-6 Luna)
	async function executeMimic(target: "mimic-flash" | "mimic-luna", state: any, questions: Record<string, any>, ctx: ExtensionContext) {
		const isFlash = target === "mimic-flash";
		const provider = isFlash ? "antigravity" : "openai";
		const modelId = isFlash ? "gemini-3.8-flash" : "gpt-6-luna";

		let physicalModel = ctx.modelRegistry.find(provider, modelId);
		if (!physicalModel && !isFlash) {
			// Try openai-codex fallback
			physicalModel = ctx.modelRegistry.find("openai-codex", modelId);
		}

		if (!physicalModel) {
			throw new Error(`Mimic model ${provider}/${modelId} not found in model registry or missing auth`);
		}

		const prompt = `You are a bounded decision classifier (Jev-mimic).
You do not engage in conversation, write explanations, or output markdown formatting.
Evaluate the given State against the Questions.
Return ONLY a valid single-line JSON object adhering to this schema:
{"answers":{"<question_key>":{"value":<boolean_or_choice_string>,"confidence":<float_between_0_and_1>}}}

State: ${JSON.stringify(state)}
Questions: ${JSON.stringify(questions)}`;

		const t0 = Date.now();
		const stream = await ctx.modelRegistry.streamSimple(
			physicalModel,
			{
				messages: [{ role: "user", content: prompt }],
			},
			{ reasoning: "off" },
		);

		const res = await stream.result();
		const latencyMs = Date.now() - t0;

		const rawText = res.content?.map((c: any) => c.text).join("") || "";
		const cleanText = rawText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

		let parsed: any = {};
		try {
			parsed = JSON.parse(cleanText);
		} catch (e) {
			throw new Error(`Failed to parse mimic JSON response: ${rawText}`);
		}

		const usage = {
			input: res.usage?.input || 0,
			output: res.usage?.output || 0,
			total: res.usage?.totalTokens || (res.usage?.input || 0) + (res.usage?.output || 0),
			cost: res.usage?.cost?.total || 0,
		};

		return {
			engine: target,
			model: `${physicalModel.provider}/${physicalModel.id}`,
			answers: parsed.answers || {},
			latencyMs,
			usage,
		};
	}

	// Register Tool: classify
	pi.registerTool({
		name: "classify",
		label: "Classify Decision",
		description:
			"Evaluate bounded decision questions (choice, bool, score) about arbitrary JSON state. Powered by TypeSafe Jev or lightweight Flash/Luna mimic.",
		parameters: ClassifyParameters,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			let effectiveEngine = (params.engine as ClassifierEngine) || config.engine;

			// Handle auto-resolution
			let actualJev: any = null;
			if (effectiveEngine === "auto" || effectiveEngine === "actual") {
				actualJev = await findActualJev(ctx);
				if (effectiveEngine === "actual" && !actualJev) {
					throw new Error("Actual Jev requested but no classifier model is authenticated in Pi.");
				}
				if (effectiveEngine === "auto") {
					effectiveEngine = actualJev ? "actual" : "mimic-flash";
				}
			}

			let result: any;
			if (effectiveEngine === "actual") {
				result = await executeActualJev(actualJev, params.state, params.questions, ctx);
			} else if (effectiveEngine === "mimic-luna") {
				result = await executeMimic("mimic-luna", params.state, params.questions, ctx);
			} else {
				result = await executeMimic("mimic-flash", params.state, params.questions, ctx);
			}

			// Accumulate telemetry
			totalDecisions += 1;
			totalInputTokens += result.usage.input;
			totalOutputTokens += result.usage.output;
			totalCostUsd += result.usage.cost;
			lastEngineUsed = result.engine;
			updateStatusline(ctx.ui);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								engine: result.engine,
								model: result.model,
								latencyMs: result.latencyMs,
								answers: result.answers,
								usage: result.usage,
							},
							null,
							2,
						),
					},
				],
				details: result,
			};
		},
	});

	// Register Command: /classifier or /jev
	const commandHandler = async (args: string, ctx: ExtensionContext) => {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const sub = parts[0]?.toLowerCase();

		if (sub === "mode" || sub === "engine") {
			const target = parts[1]?.toLowerCase() as ClassifierEngine;
			if (!["actual", "mimic-flash", "mimic-luna", "auto"].includes(target)) {
				ctx.ui.notify("Valid modes: 'actual', 'mimic-flash' (or flash), 'mimic-luna' (or luna), 'auto'", "error");
				return;
			}
			const mappedTarget: ClassifierEngine =
				target === ("flash" as any) ? "mimic-flash" : target === ("luna" as any) ? "mimic-luna" : target;

			config.engine = mappedTarget;
			saveConfig(config);
			ctx.ui.notify(`Classifier engine switched to: ${mappedTarget}`, "info");
			updateStatusline(ctx.ui);
			return;
		}

		if (sub === "reset") {
			totalDecisions = 0;
			totalInputTokens = 0;
			totalOutputTokens = 0;
			totalCostUsd = 0;
			updateStatusline(ctx.ui);
			ctx.ui.notify("Classifier usage telemetry reset", "info");
			return;
		}

		// Status / interactive picker
		const actualJev = await findActualJev(ctx);
		const actualLabel = actualJev ? `${actualJev.provider}/${actualJev.id} (Ready)` : "Not authenticated";

		const options = [
			`Auto (Currently: ${actualJev ? "actual" : "mimic-flash"})`,
			`Actual Jev (${actualLabel})`,
			"Mimic: Gemini 3.8 Flash (Antigravity)",
			"Mimic: GPT-6 Luna (OpenAI Platform / Codex)",
		];

		const selected = await ctx.ui.select(`Classifier Engine (Active: ${config.engine})`, options);
		if (!selected) return;

		if (selected.startsWith("Auto")) config.engine = "auto";
		else if (selected.startsWith("Actual")) config.engine = "actual";
		else if (selected.includes("Gemini")) config.engine = "mimic-flash";
		else if (selected.includes("Luna")) config.engine = "mimic-luna";

		saveConfig(config);
		ctx.ui.notify(`Classifier engine set to: ${config.engine}`, "info");
		updateStatusline(ctx.ui);
	};

	pi.registerCommand("classifier", {
		description: "Select decision classifier engine: actual Jev vs Gemini Flash vs GPT-6 Luna mimic",
		handler: commandHandler,
	});

	pi.registerCommand("jev", {
		description: "Alias for /classifier",
		handler: commandHandler,
	});

	pi.on("session_start", (_event, ctx) => {
		updateStatusline(ctx.ui);
	});
}
