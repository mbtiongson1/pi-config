"""Command Execution Safety Guard tests (`extensions/command-safety-guard.ts`).

Verifies:
  - Timeout tiers: 30s searches, 120s ordinary bash, 180s git, 600s tests/builds/Python, 1800s authorized deployments
  - Harness-level timeout clamping regardless of model-requested timeout
  - Blocking obvious runaway wide searches (/ and unbounded $HOME)
  - Actual timeout enforcement, process-tree termination, and blocking repeated identical timed-out retries
  - Lengthy Python execution and authorized deployment exceptions
"""

import subprocess
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
GUARD_TS = REPO_ROOT / "extensions" / "command-safety-guard.ts"
ENSURE_SCRIPT = REPO_ROOT / "bin" / "ensure-subagent-config.sh"


class TestCommandSafetyGuard(unittest.TestCase):
    def test_guard_files_and_installer(self):
        self.assertTrue(GUARD_TS.is_file(), "extensions/command-safety-guard.ts must exist")
        content = ENSURE_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("command-safety-guard.ts", content)

    def test_guard_tiers_wide_search_timeout_process_kill_and_deploy_exceptions(self):
        node_script = """
        async function run() {
            const assert = require("node:assert/strict");
            const os = require("node:os");
            const piDir = "/data/data/com.termux/files/home/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent";
            const { DefaultResourceLoader } = require(piDir + "/dist/core/resource-loader.js");
            const { SettingsManager } = require(piDir + "/dist/core/settings-manager.js");
            const { ExtensionRunner } = require(piDir + "/dist/core/extensions/runner.js");
            const { createBashToolDefinition } = require(piDir + "/dist/core/tools/bash.js");

            const cwd = process.cwd();
            const homeDir = os.homedir();
            const agentDir = "/data/data/com.termux/files/home/.pi/agent";
            const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
            const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
            await loader.reload();

            const extResult = loader.getExtensions();
            assert.equal(extResult.errors.length, 0, "Expected zero extension load errors: " + JSON.stringify(extResult.errors));

            const guardExt = extResult.extensions.find((e) => e.path.includes("command-safety-guard.ts"));
            assert.ok(guardExt, "command-safety-guard.ts must be discovered by DefaultResourceLoader");

            const runner = new ExtensionRunner(
                [guardExt],
                extResult.runtime,
                cwd,
                {
                    getSessionId: () => "test-session",
                    getSessionFile: () => undefined,
                    getBranch: () => [],
                },
                {},
            );

            runner.bindCore(
                {
                    sendMessage: () => {},
                    sendUserMessage: () => {},
                    appendEntry: () => {},
                    setSessionName: () => {},
                    getSessionName: () => undefined,
                    setLabel: () => {},
                    getActiveTools: () => ["read", "bash", "edit", "write"],
                    getAllTools: () => [],
                    getSettings: () => ({}),
                    setActiveTools: () => {},
                    refreshTools: () => {},
                    getCommands: () => [],
                    setModel: async () => true,
                    getThinkingLevel: () => "high",
                    setThinkingLevel: () => {},
                },
                {
                    getModel: () => ({ provider: "antigravity", id: "gemini-4-argon" }),
                    getScopedModels: () => [],
                    isIdle: () => true,
                    isProjectTrusted: () => true,
                    getSignal: () => undefined,
                    abort: () => {},
                    hasPendingMessages: () => false,
                    shutdown: () => {},
                    getContextUsage: () => undefined,
                    compact: () => {},
                    getSystemPrompt: () => "",
                },
            );

            // 1. Timeout tiers enforced & clamped at tool_call regardless of model request
            const cases = [
                { cmd: "rg -n 'guard' extensions/", req: 600, expected: 30 },
                { cmd: "find ~ -maxdepth 3 -name '*pi-config*'", req: undefined, expected: 30 },
                { cmd: "ls -la extensions", req: 500, expected: 120 },
                { cmd: "echo 'pytest wrangler deploy' && sleep 5", req: undefined, expected: 120 },
                { cmd: "git status -sb", req: 600, expected: 180 },
                { cmd: "git log --oneline -n 5 | grep 'feat'", req: undefined, expected: 180 },
                { cmd: "pytest tests/ | grep 'PASSED'", req: 3600, expected: 600 },
                { cmd: "python3 -c \\"import time; time.sleep(0.2); print('py_ok')\\"", req: undefined, expected: 600 },
            ];

            for (const c of cases) {
                const call = {
                    type: "tool_call",
                    toolName: "bash",
                    toolCallId: "call-" + Math.random(),
                    input: { command: c.cmd, ...(c.req !== undefined ? { timeout: c.req } : {}) },
                };
                const res = await runner.emitToolCall(call);
                assert.equal(res?.block, undefined, "Expected allowed for: " + c.cmd);
                assert.equal(call.input.timeout, c.expected, `Expected ${c.expected}s for: ${c.cmd}, got ${call.input.timeout}`);
            }

            // 2. Dangerous wide searches blocked
            for (const badCmd of ["rg 'secret' /", "grep -rn 'token' ~", "find / -name '*.conf'", "find ~ -name '*.py'", "rg -uuu 'foo' ."]) {
                const res = await runner.emitToolCall({
                    type: "tool_call",
                    toolName: "bash",
                    toolCallId: "wide-" + Math.random(),
                    input: { command: badCmd },
                });
                assert.equal(res?.block, true, "Expected wide search block for: " + badCmd);
                assert.match(res.reason, /Dangerous wide search blocked/);
            }

            // 3. Execute normal command & Python execution via Pi's built-in bash tool
            const bashDef = createBashToolDefinition(cwd);
            const pyCall = {
                type: "tool_call",
                toolName: "bash",
                toolCallId: "call-py",
                input: { command: "python3 -c \\"import time; time.sleep(0.3); print('python_done')\\" && rg --version | head -n 1" },
            };
            await runner.emitToolCall(pyCall);
            assert.equal(pyCall.input.timeout, 600); // python3 execution with rg --version check stays 600s
            const pyRes = await bashDef.execute("call-py", pyCall.input, undefined, undefined, runner.createToolContext("call-py", undefined));
            assert.equal(pyRes.structuredContent.exit_code, 0);
            assert.match(pyRes.structuredContent.output, /python_done/);
            assert.match(pyRes.structuredContent.output, /ripgrep/);

            // 4. Actual timeout enforcement, process-tree termination, and repeated-timeout blocking
            const slowCmd = "python3 -c 'import subprocess, time; p = subprocess.Popen([\\"sleep\\", \\"30\\"]); print(f\\"CHILD_PID={p.pid}\\", flush=True); time.sleep(30)'";
            const slowCall = {
                type: "tool_call",
                toolName: "bash",
                toolCallId: "call-slow",
                input: { command: slowCmd, timeout: 0.5 },
            };
            await runner.emitToolCall(slowCall);
            assert.equal(slowCall.input.timeout, 0.5);

            let slowError = "";
            try {
                await bashDef.execute("call-slow", slowCall.input, undefined, undefined, runner.createToolContext("call-slow", undefined));
                assert.fail("Expected timeout");
            } catch (err) {
                slowError = err.message;
            }
            assert.match(slowError, /Command timed out after 0.5 seconds/);
            const pidMatch = slowError.match(/CHILD_PID=(\\d+)/);
            assert.ok(pidMatch, "Expected CHILD_PID in partial output before timeout");
            const childPid = Number(pidMatch[1]);

            // Verify child process was killed by Pi's process-tree termination
            let childAlive = true;
            try {
                process.kill(childPid, 0);
            } catch {
                childAlive = false;
            }
            assert.equal(childAlive, false, `Expected child PID ${childPid} to be terminated on timeout`);

            // Feed timeout result through tool_result hook to record timed-out command and append recovery hint
            const hookResult = await runner.emitToolResult({
                type: "tool_result",
                toolName: "bash",
                toolCallId: "call-slow",
                input: slowCall.input,
                content: [{ type: "text", text: slowError }],
                isError: true,
            });
            assert.match(hookResult.content[0].text, /\\[Command Safety Guard:/);

            // Retry identical command -> blocked by tool_call
            const retryRes = await runner.emitToolCall({
                type: "tool_call",
                toolName: "bash",
                toolCallId: "call-slow-retry",
                input: { command: slowCmd + " # retry", timeout: 120 },
            });
            assert.equal(retryRes?.block, true, "Identical timed-out command must be blocked on retry");
            assert.match(retryRes.reason, /Blocked repeated identical timed-out command/);

            // 5. Deployment exception: blocked when unauthorized, 1800s (30m) when authorized
            const unauthDeploy = await runner.emitToolCall({
                type: "tool_call",
                toolName: "bash",
                toolCallId: "deploy-1",
                input: { command: "wrangler deploy" },
            });
            assert.equal(unauthDeploy?.block, true);
            assert.match(unauthDeploy.reason, /not authorized/);

            const guardCmd = guardExt.commands.get("guard");
            await guardCmd.handler("authorize-deploy", runner.createCommandContext());

            const authDeployInput = { command: "wrangler deploy", timeout: 3600 };
            const authDeploy = await runner.emitToolCall({
                type: "tool_call",
                toolName: "bash",
                toolCallId: "deploy-2",
                input: authDeployInput,
            });
            assert.equal(authDeploy?.block, undefined);
            assert.equal(authDeployInput.timeout, 1800, "Authorized deploy must receive 1800s (30m) ceiling");

            await guardCmd.handler("revoke-deploy", runner.createCommandContext());
            console.log("ALL_GUARD_CHECKS_OK");
        }
        run().catch((e) => {
            console.error(e);
            process.exit(1);
        });
        """
        proc = subprocess.run(
            ["node", "-e", node_script],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(
            proc.returncode,
            0,
            f"Guard verification failed:\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}",
        )
        self.assertIn("ALL_GUARD_CHECKS_OK", proc.stdout)


if __name__ == "__main__":
    unittest.main()
