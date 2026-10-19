#!/usr/bin/env bash
# Ensure Antigravity Gemini 4 Argon availability across environments.
# Patches pi-antigravity package, User-Agent, and model registries.
set -euo pipefail

TARGET_UA="antigravity/cli/1.21.9 (aidev_client; os_type=linux; arch=amd64; cl=999999999; auth_method=consumer)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

echo "=== Ensuring Antigravity Gemini 4 Argon Configuration ==="

# 1. Ensure shell profiles have only the Antigravity User-Agent.
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  if [[ -f "$rc" ]]; then
    if ! grep -q "ANTIGRAVITY_USER_AGENT" "$rc"; then
      echo "export ANTIGRAVITY_USER_AGENT=\"$TARGET_UA\"" >> "$rc"
      echo "✓ Added ANTIGRAVITY_USER_AGENT to $rc"
    else
      echo "✓ ANTIGRAVITY_USER_AGENT already present in $rc"
    fi
  fi
done

# 2. Patch pi-antigravity package if installed
node -e '
const fs = require("fs");
const path = require("path");

const agentDir = process.argv[1];
const targetUa = process.argv[2];

const clientPath = path.join(agentDir, "npm/node_modules/pi-antigravity/src/client/client.ts");
if (fs.existsSync(clientPath)) {
  let content = fs.readFileSync(clientPath, "utf-8");
  if (!content.includes("1.21.9")) {
    content = content.replace(/antigravity\/cli\/[0-9.]+[^\"]*/g, targetUa);
    fs.writeFileSync(clientPath, content, "utf-8");
    console.log("✓ Patched DEFAULT_USER_AGENT in pi-antigravity client.ts");
  } else {
    console.log("✓ pi-antigravity client.ts user agent up to date");
  }
}

const modelsPath = path.join(agentDir, "npm/node_modules/pi-antigravity/src/models/models.ts");
if (fs.existsSync(modelsPath)) {
  let content = fs.readFileSync(modelsPath, "utf-8");
  let modified = false;

  if (!content.includes("\"gemini-4-argon\": {")) {
    const routingSnippet = `  "gemini-4-argon": {
    off: "gemini-4-argon-low",
    routing: {
      minimal: "gemini-4-argon-low",
      low: "gemini-4-argon-low",
      medium: "gemini-4-argon-medium",
      high: "gemini-4-argon-high",
      xhigh: "gemini-4-argon-high",
      max: "gemini-4-argon-high",
    },
    defaultRequestId: "gemini-4-argon-high",
  },
`;
    content = content.replace("export const ANTIGRAVITY_ROUTING: Record<string, AntigravityRouting> = {", "export const ANTIGRAVITY_ROUTING: Record<string, AntigravityRouting> = {\n" + routingSnippet);
    modified = true;
  }

  if (!content.includes("const geminiArgonCost =")) {
    content = content.replace(
      "const geminiFlashCost =",
      "const geminiArgonCost = { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 0.1875 };\nconst geminiFlashCost ="
    );
    modified = true;
  }

  if (!content.includes("id: \"gemini-4-argon\"")) {
    const modelSnippet = `  {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon (Antigravity)",
    reasoning: true,
    thinkingLevelMap: { ...thinkingLevelMaps.lowMediumHigh, max: "high" },
    input: ["text", "image"],
    cost: geminiArgonCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
`;
    content = content.replace("export const ANTIGRAVITY_MODELS: ProviderModelConfig[] = [", "export const ANTIGRAVITY_MODELS: ProviderModelConfig[] = [\n" + modelSnippet);
    modified = true;
  } else if (content.includes("id: \"gemini-4-argon\"") && content.includes("cost: geminiFlashCost,")) {
    content = content.replace("cost: geminiFlashCost,\n    contextWindow: 1048576,\n    maxTokens: 65536,\n  },", "cost: geminiArgonCost,\n    contextWindow: 1048576,\n    maxTokens: 65536,\n  },");
    modified = true;
  }

  if (content.includes("if (effortKey === ThinkingEffort.Xhigh)") && !content.includes("effortKey === \"max\"")) {
    content = content.replace(
      "if (effortKey === ThinkingEffort.Xhigh)",
      "if (effortKey === ThinkingEffort.Xhigh || (effortKey as string) === \"max\")"
    );
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(modelsPath, content, "utf-8");
    console.log("✓ Patched gemini-4-argon into pi-antigravity models.ts");
  } else {
    console.log("✓ pi-antigravity models.ts up to date");
  }
}

// 3. Patch antigravity-model-catalog.json
const catalogPath = path.join(agentDir, "antigravity-model-catalog.json");
if (fs.existsSync(catalogPath)) {
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
    let catModified = false;
    const existingArgon = catalog.models.find(m => m.id === "gemini-4-argon");
    if (!existingArgon) {
      catalog.models.unshift({
        id: "gemini-4-argon",
        name: "Gemini 4 Argon (Antigravity)",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: null,
          max: "high"
        },
        input: ["text", "image"],
        cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0.1875 },
        contextWindow: 1048576,
        maxTokens: 65536
      });
      catModified = true;
    } else if (existingArgon.cost && (existingArgon.cost.input !== 2 || existingArgon.cost.output !== 10)) {
      existingArgon.cost = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0.1875 };
      catModified = true;
    }
    if (!catalog["gemini-4-argon"]) {
      catalog["gemini-4-argon"] = {
        off: "gemini-4-argon-low",
        routing: {
          minimal: "gemini-4-argon-low",
          low: "gemini-4-argon-low",
          medium: "gemini-4-argon-medium",
          high: "gemini-4-argon-high",
          xhigh: "gemini-4-argon-high",
          max: "gemini-4-argon-high"
        },
        defaultRequestId: "gemini-4-argon-high"
      };
      catModified = true;
    }
    if (catModified) {
      fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf-8");
      console.log("✓ Patched antigravity-model-catalog.json");
    } else {
      console.log("✓ antigravity-model-catalog.json up to date");
    }
  } catch (e) {
    console.error("! Could not patch antigravity-model-catalog.json:", e.message);
  }
}

// 4. Subagent format.ts KNOWN_MODELS
const subagentFormatPath = path.join(agentDir, "npm/node_modules/@parke.dev/pi-subagent/src/format.ts");
if (fs.existsSync(subagentFormatPath)) {
  let content = fs.readFileSync(subagentFormatPath, "utf-8");
  if (!content.includes("\"gemini-4-argon\":")) {
    content = content.replace("const KNOWN_MODELS: Record<string, string> = {", "const KNOWN_MODELS: Record<string, string> = {\n  \"gemini-4-argon\": \"Gemini 4 Argon\",");
    fs.writeFileSync(subagentFormatPath, content, "utf-8");
    console.log("✓ Added gemini-4-argon to @parke.dev/pi-subagent KNOWN_MODELS");
  } else {
    console.log("✓ @parke.dev/pi-subagent KNOWN_MODELS up to date");
  }
}
' "$agent_dir" "$TARGET_UA"

echo "Antigravity Gemini 4 Argon verification complete."
