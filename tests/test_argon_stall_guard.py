import unittest
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
NODE_MODULES = Path("/data/data/com.termux/files/home/.pi/agent/install/releases/1.3.0/node_modules")
JITI_PATH = NODE_MODULES / "jiti/lib/jiti.cjs"
PI_AI_PATH = NODE_MODULES / "@earendil-works/pi-ai/dist/compat.js"
PI_CODING_AGENT_PATH = NODE_MODULES / "@earendil-works/pi-coding-agent/dist/index.js"
PI_AGENT_CORE_PATH = NODE_MODULES / "@earendil-works/pi-agent-core/dist/index.js"
PI_TUI_PATH = NODE_MODULES / "@earendil-works/pi-tui/dist/index.js"
PI_ANTIGRAVITY_STREAM_PATH = Path("/data/data/com.termux/files/home/.pi/agent/npm/node_modules/pi-antigravity/src/stream/stream.ts")
ARGON_GUARD_PATH = REPO_ROOT / "extensions/argon-stall-guard.ts"

def run_node_eval(script: str, extra_env=None):
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    res = subprocess.run(
        ["node", "-e", script],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    return res

class TestArgonStallGuard(unittest.TestCase):
    def test_guard_is_opt_in_by_default(self):
        source = ARGON_GUARD_PATH.read_text()
        self.assertIn("armed: false,", source)
        self.assertIn("if (state.armed) applyArgonTimeouts(isArgon);", source)
        self.assertNotIn("// Ensure timeouts on extension load\n\tapplyArgonTimeouts(true);", source)

    def test_env_var_and_defaults(self):
        """Verify official stream stall and header timeouts from pi-antigravity."""
        script = f"""
const path = require("path");
const {{ createJiti }} = require("{JITI_PATH}");
const jiti = createJiti("{REPO_ROOT}/test_helper.js", {{
  alias: {{
    "@earendil-works/pi-ai": "{PI_AI_PATH}",
    "@earendil-works/pi-ai/compat": "{PI_AI_PATH}",
    "@earendil-works/pi-coding-agent": "{PI_CODING_AGENT_PATH}",
    "@earendil-works/pi-agent-core": "{PI_AGENT_CORE_PATH}",
    "@earendil-works/pi-tui": "{PI_TUI_PATH}",
  }}
}});

// Ensure clean env for default test
delete process.env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS;
delete process.env.NOAGY_STREAM_STALL_TIMEOUT_MS;
delete process.env.ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS;

const {{ streamStallTimeoutMs, streamHeaderTimeoutMs }} = jiti("{PI_ANTIGRAVITY_STREAM_PATH}");
const defaultStall = streamStallTimeoutMs();
const defaultHeader = streamHeaderTimeoutMs();

process.env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS = "300000";
const overriddenStall = streamStallTimeoutMs();

console.log(JSON.stringify({{ defaultStall, defaultHeader, overriddenStall }}));
"""
        res = run_node_eval(script)
        self.assertEqual(res.returncode, 0, f"Node script failed: {res.stderr}")
        data = json.loads(res.stdout.strip())
        self.assertEqual(data["defaultStall"], 120000, "Default stall timeout must be 120,000ms")
        self.assertEqual(data["defaultHeader"], 180000, "Default header timeout must be 180,000ms")
        self.assertEqual(data["overriddenStall"], 300000, "Configured stall timeout must be 300,000ms")

    def test_simulated_silence_stall_vs_survival(self):
        """Test simulated silence gap: shorter stall timeout fails; 300ms survives."""
        script = f"""
const path = require("path");
const {{ createJiti }} = require("{JITI_PATH}");
const jiti = createJiti("{REPO_ROOT}/test_helper.js", {{
  alias: {{
    "@earendil-works/pi-ai": "{PI_AI_PATH}",
    "@earendil-works/pi-ai/compat": "{PI_AI_PATH}",
    "@earendil-works/pi-coding-agent": "{PI_CODING_AGENT_PATH}",
    "@earendil-works/pi-agent-core": "{PI_AGENT_CORE_PATH}",
    "@earendil-works/pi-tui": "{PI_TUI_PATH}",
  }}
}});

const {{ fetchWithHeaderDeadline }} = jiti("{PI_ANTIGRAVITY_STREAM_PATH}");

async function run() {{
  const makeMockFetch = (silenceMs) => async () => {{
    let timer;
    const stream = new ReadableStream({{
      start(controller) {{
        controller.enqueue(new TextEncoder().encode("chunk-1\\n"));
        timer = setTimeout(() => {{
          controller.enqueue(new TextEncoder().encode("chunk-2\\n"));
          controller.close();
        }}, silenceMs);
      }},
      cancel() {{
        clearTimeout(timer);
      }}
    }});
    return new Response(stream, {{ status: 200 }});
  }};

  const results = {{}};

  // Case 1: 350ms silence with 100ms watchdog -> must stall
  try {{
    const res1 = await fetchWithHeaderDeadline("http://localhost", {{}}, undefined, 1000, 100, makeMockFetch(350));
    const reader1 = res1.body.getReader();
    await reader1.read();
    await reader1.read();
    results.case1 = "succeeded_unexpectedly";
  }} catch (err) {{
    results.case1 = err.message;
  }}

  // Case 2: 350ms silence with 800ms watchdog -> must survive
  try {{
    const res2 = await fetchWithHeaderDeadline("http://localhost", {{}}, undefined, 1000, 800, makeMockFetch(350));
    const reader2 = res2.body.getReader();
    const c1 = await reader2.read();
    const c2 = await reader2.read();
    const c3 = await reader2.read();
    results.case2 = (c3.done === true && !c1.done && !c2.done) ? "survived" : "unexpected_read";
  }} catch (err) {{
    results.case2 = err.message;
  }}

  console.log(JSON.stringify(results));
}}

run();
"""
        res = run_node_eval(script)
        self.assertEqual(res.returncode, 0, f"Node script failed: {res.stderr}")
        data = json.loads(res.stdout.strip())
        self.assertIn("stream stalled: no data for 100ms", data["case1"])
        self.assertEqual(data["case2"], "survived")

    def test_structured_diagnostics_classification(self):
        """Test error classification into provider_silence, network_disconnection, process_termination, timeout."""
        script = f"""
const path = require("path");
const {{ createJiti }} = require("{JITI_PATH}");
const jiti = createJiti("{REPO_ROOT}/test_helper.js", {{
  alias: {{
    "@earendil-works/pi-ai": "{PI_AI_PATH}",
    "@earendil-works/pi-ai/compat": "{PI_AI_PATH}",
    "@earendil-works/pi-coding-agent": "{PI_CODING_AGENT_PATH}",
    "@earendil-works/pi-agent-core": "{PI_AGENT_CORE_PATH}",
    "@earendil-works/pi-tui": "{PI_TUI_PATH}",
  }}
}});

const {{ classifyStreamFailure }} = jiti("{ARGON_GUARD_PATH}");

const cases = {{
  silence: classifyStreamFailure("Error: stream stalled: no data for 120000ms"),
  network_reset: classifyStreamFailure("Fetch failed: read ECONNRESET"),
  network_socket: classifyStreamFailure("Socket hang up (und_err_socket)"),
  process_kill: classifyStreamFailure("Process terminated with signal SIGKILL (exit code 137)"),
  process_term: classifyStreamFailure("Worker terminated unexpectedly"),
  header_timeout: classifyStreamFailure("no response headers within 180000ms"),
  general_timeout: classifyStreamFailure("Request timed out after deadline"),
  other: classifyStreamFailure("Model rejected prompt: invalid content block")
}};

console.log(JSON.stringify(cases));
"""
        res = run_node_eval(script)
        self.assertEqual(res.returncode, 0, f"Node script failed: {res.stderr}")
        data = json.loads(res.stdout.strip())
        self.assertEqual(data["silence"], "provider_silence")
        self.assertEqual(data["network_reset"], "network_disconnection")
        self.assertEqual(data["network_socket"], "network_disconnection")
        self.assertEqual(data["process_kill"], "process_termination")
        self.assertEqual(data["process_term"], "process_termination")
        self.assertEqual(data["header_timeout"], "timeout")
        self.assertEqual(data["general_timeout"], "timeout")
        self.assertEqual(data["other"], "other")

    def test_credential_redaction(self):
        """Test that sensitive OAuth tokens, Bearer headers, and API keys are redacted."""
        script = f"""
const path = require("path");
const {{ createJiti }} = require("{JITI_PATH}");
const jiti = createJiti("{REPO_ROOT}/test_helper.js", {{
  alias: {{
    "@earendil-works/pi-ai": "{PI_AI_PATH}",
    "@earendil-works/pi-ai/compat": "{PI_AI_PATH}",
    "@earendil-works/pi-coding-agent": "{PI_CODING_AGENT_PATH}",
    "@earendil-works/pi-agent-core": "{PI_AGENT_CORE_PATH}",
    "@earendil-works/pi-tui": "{PI_TUI_PATH}",
  }}
}});

const {{ redactSecrets }} = jiti("{ARGON_GUARD_PATH}");

const raw = 'Error on https://daily-cloudcode-pa.sandbox.googleapis.com with auth Authorization: Bearer ya29.a0AfH6SMB_secret_access_token_12345678 and refresh 1//0g4_secret_refresh_token_abcdef12345678 and key sk-abcdef1234567890abcdef1234 and github ghp_1234567890abcdefghijklmnopqrstuvwxyz';
const redacted = redactSecrets(raw);

console.log(JSON.stringify({{
  containsAccessToken: redacted.includes("ya29.a0AfH6SMB_secret_access_token_12345678"),
  containsRefreshToken: redacted.includes("1//0g4_secret_refresh_token_abcdef12345678"),
  containsBearer: redacted.includes("Bearer ya29"),
  containsApiKey: redacted.includes("sk-abcdef1234567890abcdef1234"),
  containsGithub: redacted.includes("ghp_1234567890abcdefghijklmnopqrstuvwxyz"),
  redacted
}}));
"""
        res = run_node_eval(script)
        self.assertEqual(res.returncode, 0, f"Node script failed: {res.stderr}")
        data = json.loads(res.stdout.strip())
        self.assertFalse(data["containsAccessToken"])
        self.assertFalse(data["containsRefreshToken"])
        self.assertFalse(data["containsBearer"])
        self.assertFalse(data["containsApiKey"])
        self.assertFalse(data["containsGithub"])
        self.assertIn("[redacted-access-token]", data["redacted"])
        self.assertIn("[redacted-refresh-token]", data["redacted"])

    def test_safe_recovery_rules_and_tool_call_guard(self):
        """Test safe recovery: pure reasoning allowed; replaying tool execution strictly blocked."""
        script = f"""
const path = require("path");
const {{ createJiti }} = require("{JITI_PATH}");
const jiti = createJiti("{REPO_ROOT}/test_helper.js", {{
  alias: {{
    "@earendil-works/pi-ai": "{PI_AI_PATH}",
    "@earendil-works/pi-ai/compat": "{PI_AI_PATH}",
    "@earendil-works/pi-coding-agent": "{PI_CODING_AGENT_PATH}",
    "@earendil-works/pi-agent-core": "{PI_AGENT_CORE_PATH}",
    "@earendil-works/pi-tui": "{PI_TUI_PATH}",
  }}
}});

const {{ evaluateRecoverySafety }} = jiti("{ARGON_GUARD_PATH}");

const results = {{}};

// Case 1: Pure reasoning on gemini-4-argon with stream stall -> SAFE
const msg1 = {{
  role: "assistant",
  model: "antigravity/gemini-4-argon",
  stopReason: "error",
  errorMessage: "Error: stream stalled: no data for 120000ms",
  content: [{{ type: "thinking", text: "Analyzing code..." }}]
}};
results.case1 = evaluateRecoverySafety(msg1, {{}}, "antigravity/gemini-4-argon");

// Case 2: Message contains toolCall -> UNSAFE (never blindly replay!)
const msg2 = {{
  role: "assistant",
  model: "antigravity/gemini-4-argon",
  stopReason: "error",
  errorMessage: "Error: stream stalled: no data for 120000ms",
  content: [
    {{ type: "thinking", text: "Writing file..." }},
    {{ type: "toolCall", name: "write", args: {{ path: "test.txt", content: "hello" }} }}
  ]
}};
results.case2 = evaluateRecoverySafety(msg2, {{}}, "antigravity/gemini-4-argon");

// Case 3: Turn already emitted tool results -> UNSAFE
results.case3 = evaluateRecoverySafety(msg1, {{ toolResults: [{{ id: "call1", output: "ok" }}] }}, "antigravity/gemini-4-argon");

// Case 4: Non-argon model -> UNSAFE (restricted to Argon)
const msg4 = {{
  role: "assistant",
  model: "anthropic/claude-sonnet-5-5",
  stopReason: "error",
  errorMessage: "Error: stream stalled: no data for 120000ms",
  content: [{{ type: "thinking", text: "Thinking..." }}]
}};
results.case4 = evaluateRecoverySafety(msg4, {{}}, "anthropic/claude-sonnet-5-5");

console.log(JSON.stringify(results));
"""
        res = run_node_eval(script)
        self.assertEqual(res.returncode, 0, f"Node script failed: {res.stderr}")
        data = json.loads(res.stdout.strip())

        self.assertTrue(data["case1"]["safe"], "Pure reasoning failure on Argon must be safe to recover")
        self.assertFalse(data["case2"]["safe"], "Turn containing toolCall must be blocked from auto-retry")
        self.assertIn("toolCall block", data["case2"]["reason"])
        self.assertFalse(data["case3"]["safe"], "Turn with existing tool results must be blocked from auto-retry")
        self.assertFalse(data["case4"]["safe"], "Non-argon models must not trigger automatic recovery")

    def test_argon_thinking_levels_configuration(self):
        """Test Argon Low, Medium, and High definitions and routing."""
        agents_dir = REPO_ROOT / "agents"
        for level in ["low", "medium", "high"]:
            agent_file = agents_dir / f"worker-argon-{level}.md"
            self.assertTrue(agent_file.exists(), f"Agent file missing: {agent_file}")
            content = agent_file.read_text(encoding="utf-8")
            self.assertIn(f"model: antigravity/gemini-4-argon:{level}", content)
            self.assertIn(f"name: worker-argon-{level}", content)

        # Verify models.json.template contains gemini-4-argon definition
        template = REPO_ROOT / "models.json.template"
        self.assertTrue(template.exists())
        tpl_data = json.loads(template.read_text(encoding="utf-8"))
        antigravity_cfg = tpl_data.get("providers", {}).get("antigravity", {}).get("modelOverrides", {})
        self.assertIn("gemini-4-argon", antigravity_cfg)
        argon_override = antigravity_cfg["gemini-4-argon"]
        self.assertEqual(argon_override.get("contextWindow"), 1048576)
        self.assertEqual(argon_override.get("maxTokens"), 65536)

    def test_termux_compatibility_and_subagent_unbounded(self):
        """Test Termux environment propagation and unbounded subagent turn counts."""
        # 1. Check subagent config stallAfterMs
        subagent_cfg_path = Path.home() / ".pi/subagent.json"
        if subagent_cfg_path.exists():
            cfg = json.loads(subagent_cfg_path.read_text(encoding="utf-8"))
            self.assertEqual(cfg.get("stallAfterMs"), 300000, "Subagent stallAfterMs must be 300,000ms")
            # Subagent max_turns should not be constrained to a low value by the stall guard
            self.assertNotIn("max_turns", cfg, "max_turns should remain unconstrained in subagent.json")

        # 2. Check bashrc exports
        bashrc = Path.home() / ".bashrc"
        if bashrc.exists():
            content = bashrc.read_text(encoding="utf-8")
            self.assertIn("ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS=300000", content)
            self.assertIn("ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS=180000", content)

if __name__ == "__main__":
    unittest.main()
