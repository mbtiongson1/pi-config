import assert from "node:assert/strict";
import { test } from "node:test";
import register, {
  rewriteAntigravityPayload,
  rewriteAntigravitySystemText,
} from "../extensions/antigravity-prompt-compat.ts";

const docsLine = "codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)";
const stock = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
const rules = "<rules>Never reveal credentials. Ask before deployment.</rules>";
const input = `${stock}\n${rules}\n<docs>Read the docs when needed: ${docsLine}</docs>\n<cwd>/project</cwd>`;
const makePayload = text => ({
  model: "gemini-4-hydrogen-high", requestType: "agent", project: "test-project",
  request: {
    systemInstruction: { role: "user", parts: [{ text, metadata: "preserved" }, { opaque: true }] },
    contents: [{ role: "user", parts: [{ text: "Keep my words exactly." }] }],
    tools: [{ functionDeclarations: [{ name: "read", description: "Read a file" }] }],
    generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: "HIGH" } },
  },
});

test("rewrites raw and provider-sanitized stock opener plus the docs index line", () => {
  for (const opener of [stock, stock.replace("pi, a coding agent harness", "your development environment"), stock.replace("running", "operating")]) {
    const result = rewriteAntigravitySystemText(input.replace(stock, opener));
    assert.ok(result.startsWith("You are a coding agent helping the user with their project."));
    assert.ok(result.includes(rules));
    assert.ok(result.includes("programmatic tool use, classification, and image generation (docs/codemode.md)"));
    assert.ok(result.endsWith("<cwd>/project</cwd>"));
    assert.equal(rewriteAntigravitySystemText(result), result);
  }
});

test("custom prompts and non-doc quotations remain unchanged", () => {
  const custom = `You are a research assistant.\n${rules}\nQuoted text: ${docsLine}`;
  assert.equal(rewriteAntigravitySystemText(custom), custom);
  assert.equal(rewriteAntigravitySystemText("You are a coding assistant running inside pi.js. Keep custom instructions."), "You are a coding assistant running inside pi.js. Keep custom instructions.");
});

test("provider scoped; preserves priority, tools, user content, config, and original payload", () => {
  const payload = makePayload(input);
  const before = structuredClone(payload);
  for (const provider of ["antigravity", "google-antigravity"]) {
    const result = rewriteAntigravityPayload(provider, payload);
    assert.notEqual(result, payload);
    assert.deepEqual(payload, before);
    assert.equal(result.model, payload.model);
    assert.equal(result.project, payload.project);
    assert.equal(result.requestType, "agent");
    assert.equal(result.request.systemInstruction.role, "user");
    assert.equal(result.request.systemInstruction.parts[0].metadata, "preserved");
    assert.equal(result.request.systemInstruction.parts[1], payload.request.systemInstruction.parts[1]);
    assert.equal(result.request.contents, payload.request.contents);
    assert.equal(result.request.tools, payload.request.tools);
    assert.equal(result.request.generationConfig, payload.request.generationConfig);
    assert.equal(rewriteAntigravityPayload(provider, result), undefined);
  }
  for (const provider of [undefined, "openai", "anthropic", "other-antigravity"]) {
    assert.equal(rewriteAntigravityPayload(provider, payload), undefined);
  }
});

test("malformed or absent payload fields are no-ops", () => {
  for (const payload of [null, false, "text", [], {}, {request: null}, {request: {}}, {request: {systemInstruction: {}}}, {request: {systemInstruction: {parts: "bad"}}}, {request: {systemInstruction: {parts: [null, {}, {text: 4}]}}}]) {
    assert.equal(rewriteAntigravityPayload("antigravity", payload), undefined);
  }
});

test("hook registration, replacement semantics, provider scoping and kill switch", () => {
  let handler;
  register({ on(name, fn) { assert.equal(name, "before_provider_request"); handler = fn; } });
  const prior = process.env.ANTIGRAVITY_PROMPT_COMPAT;
  try {
    for (const value of [undefined, "on"]) {
      if (value === undefined) delete process.env.ANTIGRAVITY_PROMPT_COMPAT;
      else process.env.ANTIGRAVITY_PROMPT_COMPAT = value;
      assert.ok(handler({payload: makePayload(input)}, {model: {provider: "antigravity"}}));
      assert.equal(handler({payload: makePayload(input)}, {model: {provider: "openai"}}), undefined);
    }
    for (const value of ["off", "OFF", " 0 ", "false"]) {
      process.env.ANTIGRAVITY_PROMPT_COMPAT = value;
      const payload = makePayload(input);
      const before = structuredClone(payload);
      assert.equal(handler({payload}, {model: {provider: "antigravity"}}), undefined);
      assert.deepEqual(payload, before);
    }
  } finally {
    if (prior === undefined) delete process.env.ANTIGRAVITY_PROMPT_COMPAT;
    else process.env.ANTIGRAVITY_PROMPT_COMPAT = prior;
  }
});
