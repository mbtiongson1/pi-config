import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, "..");
const EXTENSION_PATH = path.join(REPO_ROOT, "extensions", "durable-subagent-recovery.ts");

// Helper to create an isolated sandbox environment
function createTestSandbox() {
	const tmpRoot = path.join(os.tmpdir(), `pi-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
	const durableDir = path.join(tmpRoot, "durable");
	const sessionsDir = path.join(durableDir, "sessions");
	const vendorLocksDir = path.join(tmpRoot, "subagent-locks");
	const vendorSessionsDir = path.join(tmpRoot, "subagent-sessions");
	const agentDir = path.join(tmpRoot, "agent");
	const worktreeDir = path.join(tmpRoot, "worktree");

	fs.mkdirSync(durableDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(vendorLocksDir, { recursive: true });
	fs.mkdirSync(path.join(vendorLocksDir, "runs"), { recursive: true });
	fs.mkdirSync(vendorSessionsDir, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(worktreeDir, { recursive: true });

	const dbPath = path.join(durableDir, "subagents.sqlite");

	return {
		tmpRoot,
		durableDir,
		sessionsDir,
		vendorLocksDir,
		vendorSessionsDir,
		agentDir,
		worktreeDir,
		dbPath,
		cleanup() {
			try {
				fs.rmSync(tmpRoot, { recursive: true, force: true });
			} catch {}
		},
	};
}

test("Durable Subagent Recovery Mock Contract & Policy Test Fixture", async (t) => {
	// Sanitize credentials environment for isolated deterministic testing
	const savedEnv = { ...process.env };
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.OPENAI_API_KEY;
	delete process.env.GOOGLE_API_KEY;
	delete process.env.MISTRAL_API_KEY;
	delete process.env.GROQ_API_KEY;

	const sandbox = createTestSandbox();

	process.env.HOME = sandbox.tmpRoot;
	process.env.PI_CODING_AGENT_DIR = sandbox.agentDir;
	process.env.PI_DURABLE_DIR = sandbox.durableDir;
	process.env.PI_SUBAGENT_LOCK_DIR = sandbox.vendorLocksDir;
	process.env.PI_SUBAGENT_SESSION_DIR = sandbox.vendorSessionsDir;
	process.env.PI_SUBAGENT_CONFIG = path.join(sandbox.tmpRoot, "subagent.json");

	try {
		// Import durable subagent recovery extension
		const mod = await import(EXTENSION_PATH);
		const {
			DurableSubagentLedger,
			buildResumeSpec,
			buildResumeCommand,
			checkProcessLiveness,
			getProcessStartTimeTicks,
			getSystemBootId,
			default: registerDurableRecovery,
		} = mod;

		// Load native policy from @parke.dev/pi-subagent
		const createJiti = require("/data/data/com.termux/files/home/.pi/agent/install/releases/1.4.0/node_modules/jiti");
		const jiti = createJiti(__filename);
		const nativePolicy = jiti(
			"/data/data/com.termux/files/home/.pi/agent/npm/node_modules/@parke.dev/pi-subagent/src/policy.ts",
		);

		await t.test("A. Real Pi SDK event ordering and async correlation pipeline", async () => {
			const listeners = new Map();
			let registeredTool = null;
			let registeredCommand = null;

			const mockPi = {
				on(event, handler) {
					if (!listeners.has(event)) listeners.set(event, []);
					listeners.get(event).push(handler);
				},
				registerCommand(name, cmd) {
					if (name === "subagent-recover") registeredCommand = cmd;
				},
				registerTool(toolDef) {
					if (toolDef.name === "subagent_recover") registeredTool = toolDef;
				},
			};

			registerDurableRecovery(mockPi);

			assert.ok(registeredTool, "subagent_recover tool must be registered");
			assert.ok(registeredCommand, "subagent-recover slash command must be registered");

			const fire = async (event, payload, ctx = {}) => {
				const handlers = listeners.get(event) || [];
				for (const h of handlers) {
					await h(payload, {
						cwd: sandbox.worktreeDir,
						hasUI: false,
						sessionManager: {
							getSessionFile: () => path.join(sandbox.agentDir, "sessions", "parent.jsonl"),
							getSessionId: () => "parent-session-uuid",
						},
						...ctx,
					});
				}
			};

			// 1. Session start
			await fire("session_start", {});

			// 2. Pi SDK: tool_execution_start occurs BEFORE tool_call
			const toolCallId = "call_sdk_order_1";
			const taskDescription = "Analyze distributed lock safety and write proof report";
			await fire("tool_execution_start", {
				toolCallId,
				toolName: "subagent",
				args: {
					task: taskDescription,
					async: true,
					cwd: sandbox.worktreeDir,
				},
			});

			const ledger = new DurableSubagentLedger({
				durableDir: sandbox.durableDir,
				dbPath: sandbox.dbPath,
				sessionsDir: sandbox.sessionsDir,
				vendorLocksDir: sandbox.vendorLocksDir,
				vendorSessionsDir: sandbox.vendorSessionsDir,
			});

			// Verify job was admitted into SQLite
			let job = ledger.findJobByToolCallId(toolCallId);
			assert.ok(job, "Job must be admitted on tool_execution_start");
			assert.equal(job.state, "queued");
			assert.equal(job.is_async, 1);
			assert.equal(job.worktree_cwd, sandbox.worktreeDir);

			// 3. Pi SDK: tool_call occurs SECOND
			await fire("tool_call", {
				toolCallId,
				toolName: "subagent",
			});

			job = ledger.findJobByToolCallId(toolCallId);
			assert.equal(job.state, "running", "Job state transitions to running on tool_call");

			// 4. Native subagent writes lock record in vendor directory
			const nativeRunId = "a1b2c3d4-e5f6-47a8-b9c0-112233445566";
			const childSessionId = "child_trans_789";
			const childSessionFile = path.join(sandbox.vendorSessionsDir, `${childSessionId}.jsonl`);
			fs.writeFileSync(
				childSessionFile,
				JSON.stringify({ type: "session", id: childSessionId, text: "subagent execution progress" }) + "\n",
			);

			const vendorRunRecord = {
				runId: nativeRunId,
				parentSessionKey: "parent-session-uuid",
				childSessionId,
				worktreeCwd: sandbox.worktreeDir,
				process: {
					pid: process.pid,
					startTime: getProcessStartTimeTicks(process.pid),
					bootId: getSystemBootId(),
					hostname: os.hostname(),
				},
				startedAt: Date.now(),
				state: "running",
				updatedAt: Date.now(),
			};
			fs.writeFileSync(
				path.join(sandbox.vendorLocksDir, "runs", `${nativeRunId}.json`),
				JSON.stringify(vendorRunRecord, null, 2),
				"utf8",
			);

			// 5. Pi SDK: tool_execution_end occurs with async launch receipt
			await fire("tool_execution_end", {
				toolCallId,
				toolName: "subagent",
				result: {
					content: [
						{
							type: "text",
							text: `Started run ${nativeRunId}. You will be notified on completion; use status/wait/cancel with this full id, or open /subagents.`,
						},
					],
				},
			});

			// Correlate: ledger run_id must match native UUID and state remains running
			job = ledger.findJobByRunId(nativeRunId);
			assert.ok(job, "Ledger must correlate by native run ID");
			assert.equal(job.state, "running", "Async receipt must keep state as running");
			assert.equal(job.child_session_id, childSessionId);
			assert.ok(job.preserved_session_path, "Child session transcript must be preserved");
			assert.ok(fs.existsSync(job.preserved_session_path), "Preserved session file must exist on disk");

			// 6. Pi SDK: follow-up async completion arrives via kebab-case subagent-completion
			await fire("message_end", {
				message: {
					customType: "subagent-completion",
					details: {
						runs: [
							{
								id: nativeRunId,
								state: "completed",
								preview: "Distributed lock safety verified with 0 defects.",
								durationMs: 14200,
								tokens: 5800,
								cost: 0.0042,
							},
						],
					},
				},
			});

			job = ledger.findJobByRunId(nativeRunId);
			assert.equal(job.state, "completed", "Job must be marked completed on subagent-completion message");
			assert.equal(job.summary, "Distributed lock safety verified with 0 defects.");
			assert.equal(job.duration_ms, 14200);
			assert.equal(job.usage_cost, 0.0042);

			ledger.close();
		});

		await t.test("B. Interrupted job recovery, lease claiming, and native policy validation", async () => {
			const ledger = new DurableSubagentLedger({
				durableDir: sandbox.durableDir,
				dbPath: sandbox.dbPath,
				sessionsDir: sandbox.sessionsDir,
				vendorLocksDir: sandbox.vendorLocksDir,
				vendorSessionsDir: sandbox.vendorSessionsDir,
			});

			// Simulate a job interrupted mid-run whose process died
			const deadPid = 99999998;
			const interruptedRunId = "c8d7e6f5-a4b3-4210-9876-554433221100";
			const preservedPath = path.join(sandbox.sessionsDir, "interrupted_child.jsonl");
			fs.writeFileSync(preservedPath, JSON.stringify({ type: "session", id: "interrupted_child" }) + "\n");

			ledger.recordJobAdmission({
				jobId: "job_interrupted_001",
				runId: interruptedRunId,
				worktreeCwd: sandbox.worktreeDir,
				spec: { task: "Complete security audit of subagent recovery" },
				isAsync: true,
			});
			ledger.updateJobExecution({
				jobId: "job_interrupted_001",
				pid: deadPid,
				preservedSessionPath: preservedPath,
				state: "interrupted",
			});

			// 1. Recover via subagent_recover tool: action 'list'
			let toolResult;
			const listeners = new Map();
			let registeredTool = null;
			registerDurableRecovery({
				on() {},
				registerCommand() {},
				registerTool(t) {
					registeredTool = t;
				},
			});

			const listRes = await registeredTool.execute(
				"call_1",
				{ action: "list" },
				null,
				null,
				{ cwd: sandbox.worktreeDir },
			);
			assert.ok(listRes.details.count >= 1, "Must list at least 1 recoverable job");
			const found = listRes.details.jobs.find((j) => j.job_id === "job_interrupted_001");
			assert.ok(found, "Must find interrupted job");
			assert.ok(found.resume_command, "Must provide resume command");
			assert.ok(found.resume_spec, "Must provide resume spec");
			assert.ok(found.resume_spec.task.startsWith("Resume:"), "Must prefix with Resume:");

			// 2. Validate generated resume spec against REAL native policy from @parke.dev/pi-subagent
			const parentPolicyContext = {
				depth: 0,
				cwd: sandbox.worktreeDir,
				availableTools: ["read", "edit", "write", "bash", "subagent"],
				activeTools: ["read", "edit", "write", "bash", "subagent"],
			};

			const validated = nativePolicy.validateSubagentRequest(found.resume_spec, parentPolicyContext, {});
			assert.equal(validated.ok, true, `Resume spec must pass native policy: ${validated.error || ""}`);
			assert.equal(validated.mode, "single");
			assert.equal(validated.tasks[0].resume, preservedPath);
			assert.equal(validated.tasks[0].cwd, sandbox.worktreeDir);

			// 3. Claim resume lease via tool: action 'claim'
			const claimRes = await registeredTool.execute(
				"call_2",
				{ action: "claim", job_id: "job_interrupted_001" },
				null,
				null,
				{ cwd: sandbox.worktreeDir },
			);
			assert.equal(claimRes.details.ok, true, "Must successfully claim lease for dead process");
			assert.ok(claimRes.details.resume_spec, "Must include resume spec on lease claim");

			// 4. Second claimant should be rejected while lease is held
			const secondClaim = await registeredTool.execute(
				"call_3",
				{ action: "claim", job_id: "job_interrupted_001" },
				null,
				null,
				{ cwd: "/another/dir" },
			);
			assert.equal(secondClaim.details.ok, false, "Second claimant must be rejected");
			assert.equal(secondClaim.details.reason, "leased_by_another_process");

			ledger.close();
		});
	} finally {
		sandbox.cleanup();
		// Restore environment
		for (const k in process.env) {
			if (!(k in savedEnv)) delete process.env[k];
		}
		Object.assign(process.env, savedEnv);
	}
});
