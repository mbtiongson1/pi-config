import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync, execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, "..");
const EXTENSION_PATH = path.join(REPO_ROOT, "extensions", "durable-subagent-recovery.ts");

// Helper to create an isolated sandbox environment
function createTestSandbox() {
	const tmpRoot = path.join(os.tmpdir(), `pi-test-durable-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
	const durableDir = path.join(tmpRoot, "durable");
	const sessionsDir = path.join(durableDir, "sessions");
	const vendorLocksDir = path.join(tmpRoot, "subagent-locks");
	const vendorSessionsDir = path.join(tmpRoot, "subagent-sessions");
	const agentDir = path.join(tmpRoot, "agent");

	fs.mkdirSync(durableDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(vendorLocksDir, { recursive: true });
	fs.mkdirSync(path.join(vendorLocksDir, "runs"), { recursive: true });
	fs.mkdirSync(vendorSessionsDir, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });

	const dbPath = path.join(durableDir, "subagents.sqlite");

	return {
		tmpRoot,
		durableDir,
		sessionsDir,
		vendorLocksDir,
		vendorSessionsDir,
		agentDir,
		dbPath,
		cleanup() {
			try {
				fs.rmSync(tmpRoot, { recursive: true, force: true });
			} catch {}
		},
	};
}

test("Durable Subagent Recovery Test Suite", async (t) => {
	const mod = await import(EXTENSION_PATH);
	const {
		DurableSubagentLedger,
		DatabaseCorruptError,
		checkProcessLiveness,
		getProcessStartTimeTicks,
		getSystemBootId,
		protectVendorOrphanRecords,
		preserveSessionFile,
		resolveSessionFilePath,
		isSessionDistilled,
		buildResumeSpec,
		buildResumeCommand,
		default: registerDurableSubagentRecovery,
	} = mod;

	await t.test("1. Database initialization, WAL mode & FULL synchronous durability", () => {
		const sandbox = createTestSandbox();
		try {
			const ledger = new DurableSubagentLedger({
				durableDir: sandbox.durableDir,
				dbPath: sandbox.dbPath,
				sessionsDir: sandbox.sessionsDir,
				vendorLocksDir: sandbox.vendorLocksDir,
				vendorSessionsDir: sandbox.vendorSessionsDir,
			});

			const journalMode = ledger.db.prepare("PRAGMA journal_mode").get();
			const syncMode = ledger.db.prepare("PRAGMA synchronous").get();
			const userVersion = ledger.db.prepare("PRAGMA user_version").get();

			assert.equal(journalMode.journal_mode, "wal", "Journal mode must be WAL");
			assert.equal(syncMode.synchronous, 2, "Synchronous mode must be FULL (2)");
			assert.equal(userVersion.user_version, 3, "Schema version must be 3");

			// Check table exists
			const tableInfo = ledger.db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='subagent_jobs'").get();
			assert.equal(tableInfo.count, 1, "Table subagent_jobs must exist");

			// Check file permissions
			const stat = fs.statSync(sandbox.dbPath);
			const mode = stat.mode & 0o777;
			assert.equal(mode, 0o600, "Database file permissions must be 0600");

			ledger.close();
		} finally {
			sandbox.cleanup();
		}
	});

	await t.test("2. Real synthetic process crash (parent kill -9) & non-destructive reconcile", async () => {
		const sandbox = createTestSandbox();
		let child;
		let parent;
		try {
			// Spawn a real long-running child process simulating a subagent
			const childScript = `
				const fs = require("node:fs");
				const sessionFile = process.argv[1];
				fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "child-session-123" }) + "\\n");
				setInterval(() => {}, 1000);
			`;
			const childSessionFile = path.join(sandbox.vendorSessionsDir, "child-session-123.jsonl");
			child = spawn(process.execPath, ["-e", childScript, childSessionFile], {
				detached: true,
				stdio: "ignore",
			});
			child.unref();

			const childPid = child.pid;
			assert.ok(childPid && childPid > 0, "Child process must have valid PID");

			// Wait up to 2 seconds for child process to write session file
			for (let i = 0; i < 40; i++) {
				if (fs.existsSync(childSessionFile)) break;
				await new Promise((r) => setTimeout(r, 50));
			}
			assert.ok(fs.existsSync(childSessionFile), "Child session file must exist");

			// Get child process identity
			const bootId = getSystemBootId();
			const ticks = getProcessStartTimeTicks(childPid);

			// Write a vendor lock run record simulating native @parke.dev/pi-subagent record
			const vendorRunRecord = {
				runId: "run_synthetic_1",
				parentSessionKey: "parent_session_abc",
				childSessionId: "child-session-123",
				process: { pid: childPid, startTime: ticks, hostname: os.hostname(), bootId },
				startedAt: Date.now(),
				state: "running",
				updatedAt: Date.now(),
			};
			const vendorLockFile = path.join(sandbox.vendorLocksDir, "runs", "run_synthetic_1.json");
			fs.writeFileSync(vendorLockFile, JSON.stringify(vendorRunRecord, null, 2), "utf8");

			// Spawn a synthetic parent process that records the admission in our ledger, then gets killed with kill -9
			const parentScript = `
				const mod = await import("${EXTENSION_PATH}");
				const ledger = new mod.DurableSubagentLedger({
					durableDir: "${sandbox.durableDir}",
					dbPath: "${sandbox.dbPath}",
					sessionsDir: "${sandbox.sessionsDir}",
					vendorLocksDir: "${sandbox.vendorLocksDir}",
					vendorSessionsDir: "${sandbox.vendorSessionsDir}",
				});
				ledger.recordJobAdmission({
					jobId: "job_synthetic_1",
					runId: "run_synthetic_1",
					worktreeCwd: "${sandbox.tmpRoot}",
					spec: { task: "synthetic background task", agent: "worker-test" },
					isAsync: true,
				});
				ledger.updateJobExecution({
					jobId: "job_synthetic_1",
					pid: ${childPid},
					childSessionId: "child-session-123",
					childSessionPath: "${childSessionFile}",
					state: "running",
				});
				ledger.close();
				// Signal readiness to test
				process.stdout.write("READY\\n");
				// Block so test can kill -9
				setInterval(() => {}, 1000);
			`;

			parent = spawn(process.execPath, ["--input-type=module", "-e", parentScript], {
				stdio: ["ignore", "pipe", "inherit"],
			});

			await new Promise((resolve) => {
				parent.stdout.once("data", () => resolve());
			});

			// Now KILL THE PARENT WITH -9!
			parent.kill("SIGKILL");
			await new Promise((r) => setTimeout(r, 200));

			// Verify child process is STILL ALIVE after parent hard crash!
			let childLiveness = checkProcessLiveness({ pid: childPid, startTimeTicks: ticks, bootId });
			assert.equal(childLiveness.alive, true, "Child process must still be alive after parent kill -9");

			// Start a NEW Pi session from a completely different CWD
			const unrelatedCwd = path.join(sandbox.tmpRoot, "other-worktree");
			fs.mkdirSync(unrelatedCwd, { recursive: true });

			const freshLedger = new DurableSubagentLedger({
				durableDir: sandbox.durableDir,
				dbPath: sandbox.dbPath,
				sessionsDir: sandbox.sessionsDir,
				vendorLocksDir: sandbox.vendorLocksDir,
				vendorSessionsDir: sandbox.vendorSessionsDir,
			});

			// Run startup reconciliation
			const report = freshLedger.reconcileOnStartup();

			// Vendor lock stays untouched; native running state retains busy/worktree protection.
			const updatedLockRecord = JSON.parse(fs.readFileSync(vendorLockFile, "utf8"));
			assert.equal(updatedLockRecord.state, "running", "Observer must preserve native running state");
			assert.equal(updatedLockRecord.terminalState, undefined);
			assert.equal(report.protectedFromVendor, 1, "Report must reflect 1 observed worker");

			// 2. Verify child process is STILL ALIVE (never killed!)
			childLiveness = checkProcessLiveness({ pid: childPid, startTimeTicks: ticks, bootId });
			assert.equal(childLiveness.alive, true, "Child process must NOT have been killed by reconciler");
			assert.equal(report.aliveWorkers.length, 1, "Reconciler must detect 1 live worker");

			// 3. Now terminate the child process
			try {
				process.kill(childPid, "SIGTERM");
			} catch {}
			await new Promise((r) => setTimeout(r, 200));

			// Re-run reconcile: now child is dead, state should be marked interrupted/dead
			const report2 = freshLedger.reconcileOnStartup();
			assert.equal(report2.orphanedDead.length, 1, "Child should now be recognized as dead");

			freshLedger.close();
		} finally {
			if (child?.pid) {
				try { process.kill(child.pid, "SIGKILL"); } catch {}
			}
			if (parent?.pid) {
				try { process.kill(parent.pid, "SIGKILL"); } catch {}
			}
			sandbox.cleanup();
		}
	});

	await t.test("3. Process liveness: alive vs dead vs PID reuse vs unknown identity", () => {
		const bootId = getSystemBootId();
		const currentPid = process.pid;
		const currentTicks = getProcessStartTimeTicks(currentPid);

		// Case A: Alive and verified
		const livenessAlive = checkProcessLiveness({ pid: currentPid, startTimeTicks: currentTicks, bootId });
		assert.equal(livenessAlive.alive, true);
		assert.equal(livenessAlive.verified, true);

		// Case B: Dead (non-existent PID)
		const deadPid = 99999999;
		const livenessDead = checkProcessLiveness({ pid: deadPid, startTimeTicks: 12345, bootId });
		assert.equal(livenessDead.alive, false);
		assert.equal(livenessDead.reason, "not_found");

		// Case C: PID reuse (PID exists, but ticks differ)
		const fakeTicks = currentTicks + 999999;
		const livenessReused = checkProcessLiveness({ pid: currentPid, startTimeTicks: fakeTicks, bootId });
		assert.equal(livenessReused.alive, false, "Reused PID must NOT be considered our process");
		assert.equal(livenessReused.reason, "pid_reused");

		// Case D: Rebooted (bootId mismatch)
		const fakeBootId = "00000000-0000-0000-0000-000000000000";
		const livenessReboot = checkProcessLiveness({ pid: currentPid, startTimeTicks: currentTicks, bootId: fakeBootId });
		assert.equal(livenessReboot.alive, false);
		assert.equal(livenessReboot.reason, "rebooted");

		// Case E: Unknown identity (ticks is 0 / unverifiable) -> must NOT mark dead, must NOT kill
		const livenessUnverifiable = checkProcessLiveness({ pid: currentPid, startTimeTicks: 0, bootId });
		assert.equal(livenessUnverifiable.alive, true, "Unverifiable process must not be marked dead");
		assert.equal(livenessUnverifiable.verified, false);
	});

	await t.test("4. Absolute path session resumption & preservation across directory boundaries", () => {
		const sandbox = createTestSandbox();
		try {
			const ledger = new DurableSubagentLedger({
				durableDir: sandbox.durableDir,
				dbPath: sandbox.dbPath,
				sessionsDir: sandbox.sessionsDir,
				vendorLocksDir: sandbox.vendorLocksDir,
				vendorSessionsDir: sandbox.vendorSessionsDir,
			});

			// Create a child session file in vendor dir
			const childSessionFile = path.join(sandbox.vendorSessionsDir, "child_uuid_456.jsonl");
			fs.writeFileSync(childSessionFile, JSON.stringify({ type: "session", id: "child_uuid_456", cwd: "/orig/worktree" }) + "\n");

			// Preserve the session file into our managed private store
			const preservedPath = preserveSessionFile(childSessionFile, sandbox.sessionsDir);
			assert.ok(preservedPath && fs.existsSync(preservedPath), "Preserved session file must exist");
			assert.equal(path.basename(preservedPath), "child_uuid_456.jsonl");

			// Record in ledger
			ledger.recordJobAdmission({
				jobId: "job_resume_test",
				runId: "run_resume_test",
				worktreeCwd: "/orig/worktree",
				spec: { task: "fix bugs in worktree" },
				isAsync: true,
			});
			ledger.updateJobExecution({
				jobId: "job_resume_test",
				childSessionId: "child_uuid_456",
				childSessionPath: childSessionFile,
				preservedSessionPath: preservedPath,
				state: "orphaned_dead",
			});

			// Simulate query from an unrelated working directory
			const recoverable = ledger.listRecoverableJobs();
			assert.equal(recoverable.length, 1);
			const targetJob = recoverable[0];

			// Verify absolute paths are returned (not bare UUID)
			assert.equal(targetJob.preserved_session_path, preservedPath);
			assert.ok(targetJob.preserved_session_path.startsWith("/"), "Must be absolute path");

			// Verify that even if vendor session is pruned/deleted, preserved file remains
			fs.unlinkSync(childSessionFile);
			assert.equal(fs.existsSync(childSessionFile), false, "Vendor session deleted");
			assert.equal(fs.existsSync(targetJob.preserved_session_path), true, "Preserved session still intact");

			ledger.close();
		} finally {
			sandbox.cleanup();
		}
	});

	await t.test("5. Async launch receipt != worker completion tracking (Gap 2)", () => {
		const sandbox = createTestSandbox();
		try {
			const ledger = new DurableSubagentLedger({
				durableDir: sandbox.durableDir,
				dbPath: sandbox.dbPath,
				sessionsDir: sandbox.sessionsDir,
				vendorLocksDir: sandbox.vendorLocksDir,
				vendorSessionsDir: sandbox.vendorSessionsDir,
			});

			// 1. Admission
			ledger.recordJobAdmission({
				jobId: "async_job_1",
				runId: "async_run_1",
				worktreeCwd: sandbox.tmpRoot,
				spec: { task: "long async work", async: true },
				isAsync: true,
			});

			let job = ledger.getJob("async_job_1");
			assert.equal(job.state, "queued");
			assert.equal(job.is_async, 1);

			// 2. Execution start
			ledger.updateJobExecution({ jobId: "async_job_1", state: "running" });
			job = ledger.getJob("async_job_1");
			assert.equal(job.state, "running");

			// 3. Tool execution end emits launch receipt: must NOT mark completed!
			ledger.updateJobExecution({ jobId: "async_job_1", state: "running" });
			job = ledger.getJob("async_job_1");
			assert.equal(job.state, "running", "Async launch receipt must not mark job as completed");

			// 4. Actual worker completion arrives later via terminal event
			ledger.recordJobCompletion({
				jobId: "async_job_1",
				state: "completed",
				summary: "Async work completed successfully",
				durationMs: 45000,
				usage: { input: 1000, output: 500, cost: 0.005 },
			});

			job = ledger.getJob("async_job_1");
			assert.equal(job.state, "completed");
			assert.equal(job.summary, "Async work completed successfully");
			assert.equal(job.usage_input, 1000);
			assert.equal(job.usage_output, 500);

			ledger.close();
		} finally {
			sandbox.cleanup();
		}
	});

	await t.test("6. Concurrent admission and resume claims (4 writers, atomic CAS lease)", async () => {
		const sandbox = createTestSandbox();
		try {
			const ledger = new DurableSubagentLedger({
				durableDir: sandbox.durableDir,
				dbPath: sandbox.dbPath,
				sessionsDir: sandbox.sessionsDir,
				vendorLocksDir: sandbox.vendorLocksDir,
				vendorSessionsDir: sandbox.vendorSessionsDir,
			});

			const dummySession = path.join(sandbox.sessionsDir, "contended.jsonl");
			fs.writeFileSync(dummySession, '{"type":"session","id":"contended"}\n');

			ledger.recordJobAdmission({
				jobId: "contended_job",
				runId: "contended_run",
				worktreeCwd: sandbox.tmpRoot,
				spec: { task: "contended task" },
				isAsync: false,
			});
			ledger.updateJobExecution({
				jobId: "contended_job",
				pid: 999999,
				startTimeTicks: 1,
				bootId: getSystemBootId(),
				preservedSessionPath: dummySession,
				state: "orphaned_dead",
			});

			// 4 concurrent writers attempt to claim the resume lease simultaneously
			const writers = ["writer-A", "writer-B", "writer-C", "writer-D"];
			const results = await Promise.all(
				writers.map((writerId) => {
					return new Promise((resolve) => {
						const writerLedger = new DurableSubagentLedger({
							durableDir: sandbox.durableDir,
							dbPath: sandbox.dbPath,
							sessionsDir: sandbox.sessionsDir,
							vendorLocksDir: sandbox.vendorLocksDir,
							vendorSessionsDir: sandbox.vendorSessionsDir,
						});
						const owner = { pid: process.pid, ticks: getProcessStartTimeTicks(process.pid), bootId: getSystemBootId(), hostname: os.hostname(), sessionId: writerId, sessionFile: path.join(sandbox.tmpRoot, `${writerId}.jsonl`), cwd: path.resolve(sandbox.tmpRoot) };
						const leaseOwner = `session_${owner.pid}_${owner.ticks}_${owner.sessionId}_${owner.cwd}`;
						const outcome = writerLedger.claimResumeLease("contended_job", leaseOwner, owner, 30000);
						writerLedger.close();
						resolve({ writerId, outcome });
					});
				})
			);

			const successes = results.filter((r) => r.outcome.ok === true);
			const failures = results.filter((r) => r.outcome.ok === false);

			assert.equal(successes.length, 1, "Exactly one writer must acquire the lease");
			assert.equal(failures.length, 3, "All other writers must be rejected");

			const winnerLeaseOwner = successes[0].outcome.job.resume_lease_owner;
			const finalJob = ledger.getJob("contended_job");
			assert.equal(finalJob.resume_lease_owner, winnerLeaseOwner);
			assert.equal(finalJob.state, "resuming");
			assert.equal(finalJob.resume_count, 1);

			// Active running job must refuse resume claim!
			ledger.updateJobExecution({
				jobId: "contended_job",
				pid: process.pid,
				startTimeTicks: getProcessStartTimeTicks(process.pid),
				bootId: getSystemBootId(),
				state: "running",
			});

			const activeOwner = { pid: process.pid, ticks: getProcessStartTimeTicks(process.pid), bootId: getSystemBootId(), hostname: os.hostname(), sessionId: "writer-E", sessionFile: path.join(sandbox.tmpRoot, "writer-E.jsonl"), cwd: path.resolve(sandbox.tmpRoot) };
			const refuseOutcome = ledger.claimResumeLease("contended_job", `session_${activeOwner.pid}_${activeOwner.ticks}_${activeOwner.sessionId}_${activeOwner.cwd}`, activeOwner);
			assert.equal(refuseOutcome.ok, false);
			assert.ok(["job_state_not_recoverable", "reservation_already_issued", "process_still_running"].includes(refuseOutcome.reason), "Active/pending reservation must remain nonclaimable");

			ledger.close();
		} finally {
			sandbox.cleanup();
		}
	});

	await t.test("7. Interrupted SQLite WAL integrity check", () => {
		const sandbox = createTestSandbox();
		try {
			const ledger = new DurableSubagentLedger({
				durableDir: sandbox.durableDir,
				dbPath: sandbox.dbPath,
				sessionsDir: sandbox.sessionsDir,
				vendorLocksDir: sandbox.vendorLocksDir,
				vendorSessionsDir: sandbox.vendorSessionsDir,
			});

			for (let i = 0; i < 50; i++) {
				ledger.recordJobAdmission({
					jobId: `job_${i}`,
					runId: `run_${i}`,
					worktreeCwd: sandbox.tmpRoot,
					spec: { task: `task ${i}` },
					isAsync: false,
				});
			}

			const walFile = `${sandbox.dbPath}-wal`;
			assert.ok(fs.existsSync(walFile), "WAL file must exist");

			const integrity = ledger.db.prepare("PRAGMA integrity_check").get();
			assert.equal(integrity.integrity_check, "ok", "Database integrity must be ok");

			ledger.close();
		} finally {
			sandbox.cleanup();
		}
	});

	await t.test("8. Corrupt DB fail-closed by default + safe offline refusal (P1-3 & P1-3 repair)", () => {
		const sandbox = createTestSandbox();
		try {
			// Write garbage bytes to database file
			fs.writeFileSync(sandbox.dbPath, "CORRUPT GARBAGE NOT SQLITE DATA AT ALL");

			// 1. By default, fail closed! Must throw DatabaseCorruptError and NOT wipe/rotate
			assert.throws(
				() =>
					new DurableSubagentLedger({
						durableDir: sandbox.durableDir,
						dbPath: sandbox.dbPath,
						sessionsDir: sandbox.sessionsDir,
						vendorLocksDir: sandbox.vendorLocksDir,
						vendorSessionsDir: sandbox.vendorSessionsDir,
					}),
				(err) => err instanceof DatabaseCorruptError,
				"Must fail closed by throwing DatabaseCorruptError",
			);
			assert.equal(
				fs.readFileSync(sandbox.dbPath, "utf8"),
				"CORRUPT GARBAGE NOT SQLITE DATA AT ALL",
				"Original corrupt file must remain untouched",
			);

			// 2. Doctor --quarantine-corrupt with active writer refuses mutation
			const doctorScript = path.join(REPO_ROOT, "bin", "durable-subagent-doctor.sh");
			const env = {
				...process.env,
				PI_DURABLE_DIR: sandbox.durableDir,
				PI_CODING_AGENT_DIR: sandbox.agentDir,
			};

			// Start a child holding an open file descriptor on dbPath
			const fdHolder = spawn(process.execPath, [
				"-e",
				`const fs = require("fs"); const fd = fs.openSync("${sandbox.dbPath}", "r"); setInterval(() => {}, 1000);`,
			]);

			try {
				// Give child time to open fd
				execSync("sleep 0.1");

				const doctorActiveWriterRes = spawnSync(doctorScript, ["--quarantine-corrupt"], { env, encoding: "utf8" });
				assert.equal(doctorActiveWriterRes.status, 1, "Doctor must refuse when active writer is detected");
				assert.ok(
					doctorActiveWriterRes.stderr.includes("Refusing database quarantine: active processes holding open descriptors") ||
					doctorActiveWriterRes.stdout.includes("Refusing database quarantine"),
					"Must report active writer refusal",
				);
			} finally {
				fdHolder.kill();
			}

			// 3. When no active writer, doctor refuses automated mutation and outputs offline diagnostic procedure
			const doctorOfflineRes = spawnSync(doctorScript, ["--quarantine-corrupt"], { env, encoding: "utf8" });
			assert.equal(doctorOfflineRes.status, 1, "Doctor refuses automated mutating reset");
			assert.ok(doctorOfflineRes.stdout.includes("Offline Diagnostic & Manual Recovery Procedure"));
			assert.equal(
				fs.readFileSync(sandbox.dbPath, "utf8"),
				"CORRUPT GARBAGE NOT SQLITE DATA AT ALL",
				"Database must remain untouched even after offline procedure notice",
			);
		} finally {
			sandbox.cleanup();
		}
	});

	await t.test("9. Retention sweep rules & distillation detection", () => {
		const sandbox = createTestSandbox();
		try {
			const ledger = new DurableSubagentLedger({
				durableDir: sandbox.durableDir,
				dbPath: sandbox.dbPath,
				sessionsDir: sandbox.sessionsDir,
				vendorLocksDir: sandbox.vendorLocksDir,
				vendorSessionsDir: sandbox.vendorSessionsDir,
				retentionDays: 7,
			});

			const now = Date.now();
			const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

			// Old completed job -> should be pruned
			ledger.recordJobAdmission({
				jobId: "old_completed",
				runId: "run_old",
				worktreeCwd: sandbox.tmpRoot,
				spec: { task: "old" },
				isAsync: false,
			});
			ledger.db.prepare("UPDATE subagent_jobs SET state = 'completed', updated_at = ? WHERE job_id = 'old_completed'").run(tenDaysAgo);

			// Old RUNNING job -> must NEVER be pruned!
			ledger.recordJobAdmission({
				jobId: "old_running",
				runId: "run_running",
				worktreeCwd: sandbox.tmpRoot,
				spec: { task: "running" },
				isAsync: true,
			});
			ledger.db.prepare("UPDATE subagent_jobs SET state = 'running', updated_at = ? WHERE job_id = 'old_running'").run(tenDaysAgo);

			// Run retention sweep
			const sweep = ledger.sweepRetention();
			assert.equal(sweep.removed, 1, "Only completed job should be removed");

			assert.equal(ledger.getJob("old_completed"), undefined, "Old completed job was pruned");
			assert.ok(ledger.getJob("old_running"), "Active running job must NEVER be pruned regardless of age");

			// Test distillation detection
			const distilledSessionId = "distilled_session_999";
			const digestFile = path.join(sandbox.vendorSessionsDir, `${distilledSessionId}.digest.json`);
			fs.writeFileSync(digestFile, JSON.stringify({ task: "distilled task", turns: 5 }));

			assert.equal(isSessionDistilled(sandbox.vendorSessionsDir, distilledSessionId), true);

			ledger.close();
		} finally {
			sandbox.cleanup();
		}
	});

	await t.test("10. Installer idempotence and hash-safe rollback verification", () => {
		const sandbox = createTestSandbox();
		try {
			const ensureScript = path.join(REPO_ROOT, "bin", "ensure-durable-recovery.sh");
			const doctorScript = path.join(REPO_ROOT, "bin", "durable-subagent-doctor.sh");

			const env = {
				...process.env,
				PI_DURABLE_DIR: sandbox.durableDir,
				PI_CODING_AGENT_DIR: sandbox.agentDir,
			};

			// Scenario A: Pre-existing custom TS installed TWICE, then rollback restores exact bytes and mode (P1-2 repair)
			const extDir = path.join(sandbox.agentDir, "extensions");
			fs.mkdirSync(extDir, { recursive: true });
			const deployedExt = path.join(extDir, "durable-subagent-recovery.ts");
			const customContent = "// PRE-EXISTING CUSTOM SUBAGENT EXTENSION\nexport const customValue = 42;\n";
			fs.writeFileSync(deployedExt, customContent, "utf8");
			fs.chmodSync(deployedExt, 0o644);
			const origCustomSha = execSync(`sha256sum "${deployedExt}"`, { encoding: "utf8" }).split(" ")[0];
			const origCustomMode = (fs.statSync(deployedExt).mode & 0o777).toString(8);
			assert.equal(origCustomMode, "644");

			// Install pass 1
			const pass1 = spawnSync(ensureScript, { env, encoding: "utf8" });
			assert.equal(pass1.status, 0, `Pass 1 failed: ${pass1.stderr}`);
			const deployedSha1 = execSync(`sha256sum "${deployedExt}"`, { encoding: "utf8" }).split(" ")[0];
			assert.notEqual(deployedSha1, origCustomSha, "Deployed extension should be our repo extension");

			// Verify manifest has backup info
			const manifestPath = path.join(sandbox.durableDir, "deployment-manifest.json");
			assert.ok(fs.existsSync(manifestPath), "Manifest must exist");
			let m1 = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			assert.equal(m1.backupSha256, origCustomSha, "Manifest must record true original preimage SHA");
			assert.equal(m1.backupMode, "644", "Manifest must record true original preimage mode");

			// Install pass 2 (IDEMPOTENT RERUN on same version dest_sha == src_sha)
			const pass2 = spawnSync(ensureScript, { env, encoding: "utf8" });
			assert.equal(pass2.status, 0, `Pass 2 failed: ${pass2.stderr}`);
			const deployedSha2 = execSync(`sha256sum "${deployedExt}"`, { encoding: "utf8" }).split(" ")[0];
			assert.equal(deployedSha1, deployedSha2, "Installer must be idempotent");

			// CRITICAL ASSERTION: Pass 2 must NOT have overwritten backupPath/backupSha256 with null!
			let m2 = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			assert.equal(m2.backupSha256, origCustomSha, "Pass 2 must retain true preimage backupSha256");
			assert.equal(m2.backupPath, m1.backupPath, "Pass 2 must retain true preimage backupPath");
			assert.equal(m2.backupMode, "644", "Pass 2 must retain true preimage backupMode");

			// Rollback: MUST restore exact bytes and mode
			const roll1 = spawnSync(doctorScript, ["--rollback"], { env, encoding: "utf8" });
			assert.equal(roll1.status, 0, `Rollback failed: ${roll1.stderr}`);
			assert.ok(roll1.stdout.includes("Restored prior extension"), "Rollback must restore prior version");

			const restoredSha = execSync(`sha256sum "${deployedExt}"`, { encoding: "utf8" }).split(" ")[0];
			assert.equal(restoredSha, origCustomSha, "Restored extension must match exact original bytes");
			const restoredMode = (fs.statSync(deployedExt).mode & 0o777).toString(8);
			assert.equal(restoredMode, "644", "Restored extension must match exact original mode");

			// Scenario B: manifests are data, never shell source (regression for reproduced eval injection).
			const marker = path.join(sandbox.tmpRoot, "manifest-eval-marker");
			fs.writeFileSync(deployedExt, customContent, "utf8");
			const isolatedInstall = spawnSync(ensureScript, { env, encoding: "utf8" });
			assert.equal(isolatedInstall.status, 0, isolatedInstall.stderr);
			const attack = `$(printf owned > ${marker})`;
			const poisoned = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			poisoned.backupPath = attack;
			fs.writeFileSync(manifestPath, JSON.stringify(poisoned));
			const poisonedInstall = spawnSync(ensureScript, { env, encoding: "utf8" });
			assert.notEqual(poisonedInstall.status, 0, "Tampered manifest must fail closed on reinstall");
			assert.equal(fs.existsSync(marker), false, "Installer must not execute manifest shell text");
			const poisonedRollback = spawnSync(doctorScript, ["--rollback"], { env, encoding: "utf8" });
			assert.notEqual(poisonedRollback.status, 0, "Tampered manifest must fail closed on rollback");
			assert.equal(fs.existsSync(marker), false, "Doctor must not execute manifest shell text");
			assert.match(fs.readFileSync(deployedExt, "utf8"), /durable-subagent-recovery/);

			// Scenario C: Symlink target refusal
			// Replace deployed extension with a symlink
			fs.rmSync(deployedExt);
			const dummyTarget = path.join(sandbox.tmpRoot, "dummy.txt");
			fs.writeFileSync(dummyTarget, "dummy", "utf8");
			fs.symlinkSync(dummyTarget, deployedExt);

			// Installer should refuse to overwrite symlink directly
			const symlinkInstall = spawnSync(ensureScript, { env, encoding: "utf8" });
			assert.equal(symlinkInstall.status, 1, "Installer must refuse to overwrite symlink directly");
			assert.ok(symlinkInstall.stderr.includes("is a symlink. Refusing to overwrite symlink directly"));

			// Rollback should also refuse symlink
			const symlinkRollback = spawnSync(doctorScript, ["--rollback"], { env, encoding: "utf8" });
			assert.equal(symlinkRollback.status, 1, "Rollback must refuse symlink");
			assert.ok(symlinkRollback.stderr.includes("is a symlink; refusing rollback"));

			// Verify database is still intact after rollback (runtime jobs never wiped)
			assert.ok(fs.existsSync(sandbox.dbPath), "Database must be preserved across rollbacks");
		} finally {
			sandbox.cleanup();
		}
	});

	await t.test("11. Mock ExtensionAPI callback-order contract (not real SDK integration)", async () => {
		const sandbox = createTestSandbox();
		try {
			// Mock ExtensionAPI
			const listeners = new Map();
			let registeredTool = null;
			const mockPi = {
				on(event, handler) {
					if (!listeners.has(event)) listeners.set(event, []);
					listeners.get(event).push(handler);
				},
				registerCommand() {},
				registerTool(toolDef) {
					registeredTool = toolDef;
				},
			};

			process.env.PI_DURABLE_DIR = sandbox.durableDir;
			process.env.PI_SUBAGENT_LOCK_DIR = sandbox.vendorLocksDir;
			process.env.PI_SUBAGENT_SESSION_DIR = sandbox.vendorSessionsDir;

			registerDurableSubagentRecovery(mockPi);

			const fireEvent = async (name, event, ctx = {}) => {
				const list = listeners.get(name) || [];
				for (const fn of list) {
					await fn(event, { ...ctx, cwd: sandbox.tmpRoot, hasUI: false });
				}
			};

			await fireEvent("session_start", {});

			// Contract callback 1: tool_execution_start fires first in this synthetic harness.
			const toolCallId = "call_real_sdk_001";
			await fireEvent("tool_execution_start", {
				toolCallId,
				toolName: "subagent",
				args: { task: "Benchmark database recovery", async: true },
			});

			const ledger = new DurableSubagentLedger({
				durableDir: sandbox.durableDir,
				dbPath: sandbox.dbPath,
				sessionsDir: sandbox.sessionsDir,
				vendorLocksDir: sandbox.vendorLocksDir,
				vendorSessionsDir: sandbox.vendorSessionsDir,
			});

			let job = ledger.findJobByToolCallId(toolCallId);
			assert.equal(job, undefined, "Observational start must not admit before SDK gate");

			// Contract callback 2: awaited tool_call is the admission gate.
			await fireEvent("tool_call", { toolCallId, toolName: "subagent", input: { task: "Benchmark database recovery", async: true } });
			job = ledger.findJobByToolCallId(toolCallId);
			assert.equal(job.state, "running", "Job transitions to running on tool_call");

			// Contract callback 3: tool_execution_end with async launch receipt.
			const nativeRunId = "b91f0941-86f7-41ab-85b4-9273d6332152";
			await fireEvent("tool_execution_end", {
				toolCallId,
				toolName: "subagent",
				result: {
					content: [{ type: "text", text: `Started run ${nativeRunId}. You will be notified on completion.` }],
				},
			});

			// Correlate: ledger run_id must now match native UUID
			const correlatedJob = ledger.findJobByRunId(nativeRunId);
			assert.ok(correlatedJob, "Job run_id must be updated to native UUID");
			assert.equal(correlatedJob.state, "running", "Async receipt must keep state as running");

			// Contract callback 4: message_end with kebab-case "subagent-completion".
			await fireEvent("message_end", {
				message: {
					customType: "subagent-completion",
					details: {
						runs: [
							{
								id: nativeRunId,
								state: "completed",
								preview: "Benchmark passed with 0 errors",
								durationMs: 8500,
								tokens: 4200,
								cost: 0.0035,
							},
						],
					},
				},
			});

			const completedJob = ledger.findJobByRunId(nativeRunId);
			assert.equal(completedJob.state, "completed");
			assert.equal(completedJob.summary, "Benchmark passed with 0 errors");
			assert.equal(completedJob.duration_ms, 8500);
			assert.equal(completedJob.usage_cost, 0.0035);

			ledger.close();
		} finally {
			delete process.env.PI_DURABLE_DIR;
			delete process.env.PI_SUBAGENT_LOCK_DIR;
			delete process.env.PI_SUBAGENT_SESSION_DIR;
			sandbox.cleanup();
		}
	});

	await t.test("12. Native subagent policy validation for generated resume spec & matrix regressions (P0-1 & P1-4)", () => {
		const createJiti = require("/data/data/com.termux/files/home/.pi/agent/install/releases/1.4.0/node_modules/jiti");
		const jiti = createJiti(__filename);
		const policy = jiti("/data/data/com.termux/files/home/.pi/agent/npm/node_modules/@parke.dev/pi-subagent/src/policy.ts");

		const sandbox = createTestSandbox();
		try {
			const projectDir = path.join(sandbox.tmpRoot, "project");
			fs.mkdirSync(projectDir, { recursive: true });
			const sessionFile = path.join(sandbox.sessionsDir, "child.jsonl");
			fs.writeFileSync(sessionFile, '{"type":"session","id":"test"}\n');

			const parent = {
				depth: 0,
				cwd: projectDir,
				availableTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
				activeTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
			};
			const options = {};

			// Case A: Bare { resume, cwd } WITHOUT task must be REJECTED by native policy
			const bareReq = { resume: sessionFile, cwd: projectDir };
			const bareResult = policy.validateSubagentRequest(bareReq, parent, options);
			assert.equal(bareResult.ok, false, "Native policy must reject resume request lacking task");
			assert.ok(bareResult.error.includes("Provide task"), "Error must complain about missing task");

			// Case B: General profile resume spec passes native policy
			const dummyJob = {
				job_id: "job_test_spec",
				run_id: "run_test_spec",
				worktree_cwd: projectDir,
				backend: "pi",
				profile: "general",
				resumable: 1,
				spec_json: JSON.stringify({ task: "Fix memory leak in parser", profile: "general" }),
			};
			const resumeSpec = buildResumeSpec(dummyJob, sessionFile);
			assert.ok(resumeSpec.task && resumeSpec.task.startsWith("Resume:"), "Spec must include task prefixed with Resume:");
			assert.equal(resumeSpec.resume, sessionFile);
			assert.equal(resumeSpec.profile, "general");

			const validResult = policy.validateSubagentRequest(resumeSpec, parent, options);
			assert.equal(validResult.ok, true, `Generated spec must pass native policy: ${validResult.error || ""}`);
			assert.equal(validResult.mode, "single");
			assert.equal(validResult.tasks[0].resume, sessionFile);

			// Case C: Explore profile + tool whitelist regression (P0-1 repair: NO privilege escalation)
			const exploreJob = {
				job_id: "job_explore_spec",
				run_id: "run_explore_spec",
				worktree_cwd: projectDir,
				backend: "pi",
				profile: "explore",
				tools_json: JSON.stringify(["read", "grep"]),
				resumable: 1,
				spec_json: JSON.stringify({ task: "Audit dependencies", profile: "explore", tools: ["read", "grep"] }),
			};
			const exploreResumeSpec = buildResumeSpec(exploreJob, sessionFile);
			assert.equal(exploreResumeSpec.profile, "explore", "Explore profile must be preserved");
			assert.deepEqual(exploreResumeSpec.tools, ["read", "grep"], "Tool whitelist must be preserved");

			const explorePolicyRes = policy.validateSubagentRequest(exploreResumeSpec, parent, options);
			assert.equal(explorePolicyRes.ok, true, `Explore resume must pass native policy: ${explorePolicyRes.error || ""}`);
			assert.equal(explorePolicyRes.tasks[0].profile, "explore");
			assert.equal(explorePolicyRes.tasks[0].canWrite, false, "canWrite MUST remain false for explore profile");
			assert.deepEqual(explorePolicyRes.tasks[0].tools, ["read", "grep"]);

			// Case D: Route and persona regression (P0-1 repair: child route and persona preserved)
			const routeAgents = new Map([
				[
					"security-reviewer",
					{
						name: "security-reviewer",
						description: "Security Reviewer persona",
						source: "test",
						scope: "project",
					},
				],
			]);
			const routeOptions = { agents: routeAgents };

			const routeJob = {
				job_id: "job_route_spec",
				run_id: "run_route_spec",
				worktree_cwd: projectDir,
				backend: "pi",
				profile: "review",
				model: "antigravity/gemini-3.8-flash",
				thinking: "high",
				agent: "security-reviewer",
				resumable: 1,
				spec_json: JSON.stringify({
					task: "Review cryptographic handshake",
					profile: "review",
					model: "antigravity/gemini-3.8-flash",
					thinking: "high",
					agent: "security-reviewer",
				}),
			};
			const routeResumeSpec = buildResumeSpec(routeJob, sessionFile);
			assert.equal(routeResumeSpec.model, "antigravity/gemini-3.8-flash");
			assert.equal(routeResumeSpec.thinking, "high");
			assert.equal(routeResumeSpec.agent, "security-reviewer");

			const routePolicyRes = policy.validateSubagentRequest(routeResumeSpec, parent, routeOptions);
			assert.equal(routePolicyRes.ok, true, `Route resume must pass native policy: ${routePolicyRes.error || ""}`);
			assert.equal(routePolicyRes.tasks[0].model, "antigravity/gemini-3.8-flash");
			assert.equal(routePolicyRes.tasks[0].thinking, "high");
			assert.equal(routePolicyRes.tasks[0].agent, "security-reviewer");

			// Case E: Backend matrix refusal (claude/codex cannot resume pi transcripts)
			const claudeJob = {
				job_id: "job_claude",
				run_id: "run_claude",
				worktree_cwd: projectDir,
				backend: "claude",
				profile: "general",
				resumable: 0,
				unresumable_reason: "Unsupported backend 'claude': durable session transcript recovery is only supported for 'pi' backend",
				spec_json: JSON.stringify({ task: "claude task", backend: "claude" }),
			};
			assert.throws(
				() => buildResumeSpec(claudeJob, sessionFile),
				(err) => err.message.includes("not resumable") || err.message.includes("unsupported backend"),
				"Must explicitly refuse non-pi backend resume",
			);

			// Case F: Managed temporary worktree refusal (P1-4 repair)
			const managedJob = {
				job_id: "job_managed",
				run_id: "run_managed",
				worktree_cwd: path.join(sandbox.tmpRoot, ".pi", "subagent-worktrees", "run_managed"),
				backend: "pi",
				profile: "general",
				resumable: 0,
				unresumable_reason: "Managed temporary worktree (isolation: 'worktree') is purged on parent restart; uncommitted WIP cannot be restored.",
				spec_json: JSON.stringify({ task: "managed task", isolation: "worktree" }),
			};
			assert.throws(
				() => buildResumeSpec(managedJob, sessionFile),
				(err) => err.message.includes("not resumable"),
				"Must explicitly refuse managed worktree resume",
			);

			// Case G: Symlink worktree cwd refusal
			const symlinkDir = path.join(sandbox.tmpRoot, "symlink-project");
			fs.symlinkSync(projectDir, symlinkDir);
			const symlinkJob = {
				job_id: "job_symlink",
				run_id: "run_symlink",
				worktree_cwd: symlinkDir,
				backend: "pi",
				profile: "general",
				resumable: 1,
				spec_json: JSON.stringify({ task: "symlink task", profile: "general" }),
			};
			assert.throws(
				() => buildResumeSpec(symlinkJob, sessionFile),
				(err) => err.message.includes("is a symlink"),
				"Must refuse symlink worktree cwd",
			);

			// Case H: Old row missing proof fails closed (prevents silent profile widening)
			const oldRow = {
				job_id: "job_old_row",
				run_id: "run_old_row",
				worktree_cwd: projectDir,
				backend: null,
				profile: null,
				resumable: 1,
				spec_json: JSON.stringify({ task: "Old unverified task" }),
			};
			assert.throws(
				() => buildResumeSpec(oldRow, sessionFile),
				(err) => err.message.includes("missing proof of execution profile"),
				"Must fail closed on old rows missing profile proof",
			);
		} finally {
			sandbox.cleanup();
		}
	});

	await t.test("13. Mock observer preservation contract and non-mutation", () => {
		const sandbox = createTestSandbox();
		try {
			// Create a child session in vendor sessions
			const childSessionId = "child_lifecycle_777";
			const livePath = path.join(sandbox.vendorSessionsDir, `${childSessionId}.jsonl`);
			fs.writeFileSync(livePath, JSON.stringify({ type: "session", id: childSessionId, text: "valuable work" }) + "\n");

			// Create vendor run lock record
			const vendorRunRecord = {
				runId: "run_lifecycle_777",
				parentSessionKey: "parent_key",
				childSessionId,
				worktreeCwd: sandbox.tmpRoot,
				process: { pid: process.pid, startTime: getProcessStartTimeTicks(process.pid), bootId: getSystemBootId() },
				state: "running",
				updatedAt: Date.now(),
			};
			const vendorLockFile = path.join(sandbox.vendorLocksDir, "runs", "run_lifecycle_777.json");
			fs.writeFileSync(vendorLockFile, JSON.stringify(vendorRunRecord, null, 2), "utf8");

			// Non-mutating observer run: preserves transcripts BEFORE native maintenance runs
			const outcome = protectVendorOrphanRecords(sandbox.vendorLocksDir, {
				vendorSessionsDir: sandbox.vendorSessionsDir,
				durableSessionsDir: sandbox.sessionsDir,
			});

			assert.equal(outcome.preservedCount, 1, "Must preserve child transcript");

			// Verify vendor lock record was NOT mutated to terminal
			const currentLock = JSON.parse(fs.readFileSync(vendorLockFile, "utf8"));
			assert.equal(currentLock.state, "running", "Non-mutating observer must NOT strip native running state");

			// Now simulate native maintenance: vendor session is distilled and unlinked
			fs.unlinkSync(livePath);
			fs.writeFileSync(path.join(sandbox.vendorSessionsDir, `${childSessionId}.digest.json`), JSON.stringify({ digest: "summary" }));

			// Check our private durable store: preserved transcript is STILL 100% intact!
			const preservedCopy = path.join(sandbox.sessionsDir, `${childSessionId}.jsonl`);
			assert.ok(fs.existsSync(preservedCopy), "Preserved transcript must survive vendor distillation");
			const content = fs.readFileSync(preservedCopy, "utf8");
			assert.ok(content.includes("valuable work"));

			// Check distillation detection
			assert.equal(isSessionDistilled(sandbox.vendorSessionsDir, childSessionId), true);
		} finally {
			sandbox.cleanup();
		}
	});

	await t.test("14. Process liveness: lease refusal on unverifiable or permission denied", () => {
		const sandbox = createTestSandbox();
		try {
			const ledger = new DurableSubagentLedger({
				durableDir: sandbox.durableDir,
				dbPath: sandbox.dbPath,
				sessionsDir: sandbox.sessionsDir,
				vendorLocksDir: sandbox.vendorLocksDir,
				vendorSessionsDir: sandbox.vendorSessionsDir,
			});

			// Setup running job with process.pid but with ticks = 0 (unverifiable identity)
			ledger.recordJobAdmission({
				jobId: "job_unverifiable",
				runId: "run_unverifiable",
				worktreeCwd: sandbox.tmpRoot,
				spec: { task: "unverifiable task" },
				isAsync: false,
			});
			ledger.updateJobExecution({
				jobId: "job_unverifiable",
				pid: process.pid,
				state: "running",
			});
			// Force start_time_ticks to 0
			ledger.db.prepare("UPDATE subagent_jobs SET start_time_ticks = 0 WHERE job_id = 'job_unverifiable'").run();

			// Attempt lease claim: must be REFUSED because process identity cannot be proven
			const claim = ledger.claimResumeLease("job_unverifiable", "resumer_1");
			assert.equal(claim.ok, false, "Must refuse lease when liveness is unverifiable");
			assert.equal(claim.reason, "process_liveness_unverifiable");

			ledger.close();
		} finally {
			sandbox.cleanup();
		}
	});

	await t.test("15. Hash conflict refusal on rollback", () => {
		const sandbox = createTestSandbox();
		try {
			const ensureScript = path.join(REPO_ROOT, "bin", "ensure-durable-recovery.sh");
			const doctorScript = path.join(REPO_ROOT, "bin", "durable-subagent-doctor.sh");

			const env = {
				...process.env,
				PI_DURABLE_DIR: sandbox.durableDir,
				PI_CODING_AGENT_DIR: sandbox.agentDir,
			};

			// Deploy extension
			const deployRes = spawnSync(ensureScript, { env, encoding: "utf8" });
			assert.equal(deployRes.status, 0);

			const deployedExt = path.join(sandbox.agentDir, "extensions", "durable-subagent-recovery.ts");
			assert.ok(fs.existsSync(deployedExt));

			// Tamper with deployed file out-of-band
			fs.appendFileSync(deployedExt, "\n// unrecorded user edit\n");

			// Attempt rollback without --force: MUST FAIL with exit code 1 and error message
			const rollFail = spawnSync(doctorScript, ["--rollback"], { env, encoding: "utf8" });
			assert.notEqual(rollFail.status, 0, "Rollback without --force must fail on hash conflict");
			assert.ok(rollFail.stderr.includes("Hash conflict detected"), "Must report hash conflict");

			// Rollback WITH --force: MUST SUCCEED
			const rollForce = spawnSync(doctorScript, ["--rollback", "--force"], { env, encoding: "utf8" });
			assert.equal(rollForce.status, 0, "Rollback with --force must succeed");
			assert.equal(fs.existsSync(deployedExt), false, "Extension removed after forced rollback");
		} finally {
			sandbox.cleanup();
		}
	});

	await t.test("16. Staged Android compatibility patch exercises isolated native lifecycle", async () => {
		const patchFile = path.join(REPO_ROOT, "patches", "@parke.dev-pi-subagent-v0.8.0-android-proc-safety.patch");
		assert.ok(fs.existsSync(patchFile), "Vendor patch file must exist in repo");
		assert.equal(process.platform, "android", "Must exercise real Android, not a platform spoof");
		const sandbox = createTestSandbox();
		let child;
		let manager;
		try {
			const vendorSrcDir = "/data/data/com.termux/files/home/.pi/agent/npm/node_modules/@parke.dev/pi-subagent/src";
			const testDir = path.join(sandbox.tmpRoot, "patch-test");
			const testSrcDir = path.join(testDir, "src");
			fs.mkdirSync(testSrcDir, { recursive: true });
			const testFile = path.join(testSrcDir, "process-lock.ts");
			fs.copyFileSync(path.join(vendorSrcDir, "process-lock.ts"), testFile);
			// Minimal dependency seam: process-lock only reads defaultConfig.sessionDir/maxDepth.
			fs.writeFileSync(path.join(testSrcDir, "config.js"), 'const os = require("node:os"); const path = require("node:path"); exports.defaultConfig = { sessionDir: path.join(os.tmpdir(), "native-lock-fixture"), maxDepth: 2 };');
			const origSha = execSync(`sha256sum "${testFile}"`, { encoding: "utf8" }).split(" ")[0];
			assert.equal(origSha, "5cf89e4846ebc3bb59fce14af05ce0cf92be6701456ecef3e4e51746e82b2702");
			const applyRes = spawnSync("patch", ["-d", testDir, "-p1"], { input: fs.readFileSync(patchFile), encoding: "utf8" });
			assert.equal(applyRes.status, 0, `Patch apply failed: ${applyRes.stderr}`);
			assert.equal(execSync(`sha256sum "${testFile}"`, { encoding: "utf8" }).split(" ")[0], "0125694e4a15b1dac551e8442a536ad32290f42e6ec3c52f31cb48bc31d91c6b");

			const native = await import(`${pathToFileURL(testFile).href}?fixture=${Date.now()}`);
			assert.ok(native.processStartTime(process.pid) > 0, "Native Android processStartTime reads this process's real /proc ticks");
			const root = path.join(sandbox.tmpRoot, "native-locks");
			manager = new native.ProcessLockManager({ rootDir: root, maxGlobalActive: 1 });
			child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			assert.ok(child.pid);
			for (let i = 0; i < 30 && native.processStartTime(child.pid) === 0; i++) await new Promise((r) => setTimeout(r, 20));
			const childTicks = native.processStartTime(child.pid);
			assert.ok(childTicks > 0, "Native parser sees active fixture child's Android birth ticks");
			const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const identity = { pid: child.pid, startTime: childTicks, hostname: os.hostname(), bootId };
			for (const rec of [
				{ runId: "legacy-zero", process: { ...identity, startTime: 0, bootId: undefined } },
				{ runId: "unknown-host", process: { ...identity, hostname: "foreign-fixture-host" } },
				{ runId: "reused-pid", process: { ...identity, startTime: childTicks + 1 } },
				{ runId: "old-boot", process: { ...identity, bootId: `${bootId}-old` } },
			]) manager.writeRunRecord({ ...rec, parentSessionKey: "fixture-parent", childSessionId: `session-${rec.runId}`, startedAt: Date.now(), state: "running", updatedAt: Date.now() });

			const report = await manager.reconcileOrphans({ killGraceMs: 1 });
			assert.deepEqual(new Set(report.unknown), new Set(["legacy-zero", "unknown-host"]));
			assert.ok(report.alreadyDead.includes("reused-pid"));
			assert.ok(report.alreadyDead.includes("old-boot"));
			assert.equal(manager.readRunRecord("legacy-zero").state, "running");
			assert.equal(manager.readRunRecord("unknown-host").state, "running");
			assert.equal(manager.readRunRecord("reused-pid").state, "terminal");
			assert.equal(manager.readRunRecord("old-boot").state, "terminal");
			process.kill(child.pid, 0);

			const malformedLock = path.join(root, "sessions", "unknown.lock");
			fs.writeFileSync(malformedLock, "not-json");
			const malformedSlot = path.join(root, "slots", "unknown.slot");
			fs.writeFileSync(malformedSlot, "not-json");
			assert.throws(() => manager.tryAcquireGlobalSlot("second", 0), /process limit reached/);
			assert.equal(fs.existsSync(malformedSlot), true, "Unknown slot data is retained and counted");
			manager.sweep();
			assert.equal(fs.existsSync(malformedLock), true, "Unknown session lock data is retained");

			const revRes = spawnSync("patch", ["-R", "-d", testDir, "-p1"], { input: fs.readFileSync(patchFile), encoding: "utf8" });
			assert.equal(revRes.status, 0, `Patch reverse failed: ${revRes.stderr}`);
			assert.equal(execSync(`sha256sum "${testFile}"`, { encoding: "utf8" }).split(" ")[0], origSha);
		} finally {
			manager?.dispose();
			if (child?.pid) try { process.kill(child.pid, "SIGKILL"); } catch {}
			sandbox.cleanup();
		}
	});

	await t.test("17. Exact reservation gates native launch and atomically consumes successor lineage", async () => {
		const sandbox = createTestSandbox();
		try {
			const projectDir = path.join(sandbox.tmpRoot, "active-project");
			fs.mkdirSync(projectDir, { recursive: true });
			const transcript = path.join(sandbox.sessionsDir, "worker-original.jsonl");
			fs.writeFileSync(transcript, '{"type":"session","id":"orig-worker"}\\n');
			const ledger = new DurableSubagentLedger({ durableDir: sandbox.durableDir, dbPath: sandbox.dbPath, sessionsDir: sandbox.sessionsDir, vendorLocksDir: sandbox.vendorLocksDir, vendorSessionsDir: sandbox.vendorSessionsDir });
			const makeOwner = (sessionId) => ({ pid: process.pid, ticks: getProcessStartTimeTicks(process.pid), bootId: getSystemBootId(), hostname: os.hostname(), sessionId, sessionFile: path.join(sandbox.tmpRoot, `${sessionId}.jsonl`), cwd: path.resolve(projectDir) });
			const leaseFor = (o) => `session_${o.pid}_${o.ticks}_${o.sessionId}_${o.cwd}`;
			const admitDeadJob = (jobId) => {
				ledger.recordJobAdmission({ jobId, runId: `run_${jobId}`, worktreeCwd: projectDir, spec: { task: "Run critical migrations", profile: "general" }, isAsync: true });
				ledger.updateJobExecution({ jobId, pid: 999999999, startTimeTicks: 1, bootId: getSystemBootId(), preservedSessionPath: transcript, state: "interrupted" });
			};
			admitDeadJob("job_orig_100");
			const owner = makeOwner("parent-session-A");
			const leaseOwner = leaseFor(owner);
			const claim = ledger.claimResumeLease("job_orig_100", leaseOwner, owner, 60000);
			assert.equal(claim.ok, true, "Verified-dead job gets one reservation");
			assert.ok(fs.existsSync(claim.identityBoundPath));
			assert.ok(path.basename(claim.identityBoundPath).startsWith("recovery-job_orig_100-"), "Artifact includes a unique per-claim nonce");
			const duplicateClaim = ledger.claimResumeLease("job_orig_100", leaseOwner, owner, 60000);
			assert.equal(duplicateClaim.ok, false);
			assert.equal(duplicateClaim.reason, "reservation_already_issued");

			const listeners = new Map();
			const mockPi = { on(event, handler) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(handler); }, registerCommand() {}, registerTool() {} };
			Object.assign(process.env, { PI_DURABLE_DIR: sandbox.durableDir, PI_SUBAGENT_LOCK_DIR: sandbox.vendorLocksDir, PI_SUBAGENT_SESSION_DIR: sandbox.vendorSessionsDir });
			registerDurableSubagentRecovery(mockPi);
			const contextFor = (currentOwner) => ({ cwd: projectDir, hasUI: false, model: undefined, sessionManager: { getSessionFile: () => currentOwner.sessionFile, getSessionId: () => currentOwner.sessionId } });
			const fireAs = async (name, event, currentOwner) => { let result; for (const fn of listeners.get(name) || []) result = await fn(event, contextFor(currentOwner)); return result; };
			const fire = (name, event) => fireAs(name, event, owner);
			const resumeSpec = { ...buildResumeSpec(claim.job, claim.identityBoundPath), async: true };
			const suffixLookalike = { ...resumeSpec, resume: path.join(sandbox.tmpRoot, `foreign-${path.basename(claim.identityBoundPath)}`) };
			await fire("tool_execution_start", { toolCallId: "call-resume-foreign", toolName: "subagent", args: suffixLookalike });
			const foreignResult = await fire("tool_call", { toolCallId: "call-resume-foreign", toolName: "subagent", input: suffixLookalike });
			assert.equal(foreignResult.block, true, "Suffix-like foreign resume path is rejected before native execute");
			assert.equal(ledger.getJob("job_orig_100").state, "resuming", "Rejected foreign args do not consume/supersede reservation");
			await fire("tool_execution_end", { toolCallId: "call-resume-foreign", toolName: "subagent", isError: true, result: { content: [{ type: "text", text: "blocked" }] } });
			await fire("tool_execution_start", { toolCallId: "call-resume-1", toolName: "subagent", args: resumeSpec });
			assert.equal(ledger.getJob("job_orig_100").state, "resuming", "Start observation alone must not supersede predecessor");
			const hookResult = await fire("tool_call", { toolCallId: "call-resume-1", toolName: "subagent", input: resumeSpec });
			assert.equal(hookResult, undefined, "One exact, owner-bound reservation is admitted before native execute");
			const predecessor = ledger.getJob("job_orig_100");
			assert.equal(predecessor.state, "superseded");
			const successor = ledger.getJob(predecessor.superseded_by_job_id);
			assert.equal(successor.resumed_from_job_id, predecessor.job_id);
			assert.equal(predecessor.reservation_consumed_by_job_id, successor.job_id);
			assert.equal(successor.state, "queued", "Committed successor is pending/ambiguous until native launch receipt");

			ledger.db.prepare("UPDATE subagent_jobs SET resume_lease_expires_at=? WHERE job_id=?").run(Date.now()-1000, predecessor.job_id);
			const staleCallId = "call-resume-stale";
			await fire("tool_execution_start", { toolCallId: staleCallId, toolName: "subagent", args: resumeSpec });
			const staleResult = await fire("tool_call", { toolCallId: staleCallId, toolName: "subagent", input: resumeSpec });
			assert.equal(staleResult.block, true, "Consumed/stale artifact is blocked before native execute");
			assert.equal(ledger.listAllJobs().filter((j) => j.resumed_from_job_id === predecessor.job_id).length, 1, "At most one successor per reservation");

			// A second pending launch whose owner/lease expires is retained unknown, never auto-reset.
			admitDeadJob("job_crash_gap_200");
			const crashOwner = makeOwner("parent-session-crash");
			const crashLease = leaseFor(crashOwner);
			const crashClaim = ledger.claimResumeLease("job_crash_gap_200", crashLease, crashOwner, 60000);
			assert.equal(crashClaim.ok, true);
			const crashSpec = { ...buildResumeSpec(crashClaim.job, crashClaim.identityBoundPath), async: true };
			await fireAs("tool_execution_start", { toolCallId: "call-crashgap", toolName: "subagent", args: crashSpec }, crashOwner);
			await fireAs("tool_call", { toolCallId: "call-crashgap", toolName: "subagent", input: crashSpec }, crashOwner);
			ledger.db.prepare("UPDATE subagent_jobs SET resume_lease_expires_at=? WHERE job_id=?").run(Date.now()-1000, "job_crash_gap_200");
			const report = ledger.reconcileOnStartup();
			const crashPredecessor = ledger.getJob("job_crash_gap_200");
			assert.ok(report.unknownWorkers.some((j) => j.job_id === crashPredecessor.superseded_by_job_id), "Committed successor remains pending/unknown after parent death");
			assert.equal(crashPredecessor.state, "superseded");
			assert.notEqual(ledger.getJob("job_crash_gap_200").reservation_consumed_by_job_id, null, "Consumed reservation survives parent death/expiry");
			const retry = ledger.claimResumeLease("job_crash_gap_200", crashLease, crashOwner);
			assert.equal(retry.ok, false, "Expired/pending reservation is not automatically reissued");

			// Explicit release is permitted only for a reservation that has not crossed tool_call.
			admitDeadJob("job_explicit_release");
			const releaseOwner = makeOwner("parent-session-release");
			const releaseLease = leaseFor(releaseOwner);
			const releaseClaim = ledger.claimResumeLease("job_explicit_release", releaseLease, releaseOwner);
			assert.equal(releaseClaim.ok, true);
			ledger.releaseResumeLease("job_explicit_release", releaseLease, releaseClaim.reservationId);
			assert.equal(ledger.getJob("job_explicit_release").state, "interrupted");
			assert.equal(fs.existsSync(releaseClaim.identityBoundPath), false);
			ledger.close();
		} finally {
			delete process.env.PI_DURABLE_DIR;
			delete process.env.PI_SUBAGENT_LOCK_DIR;
			delete process.env.PI_SUBAGENT_SESSION_DIR;
			sandbox.cleanup();
		}
	});

	await t.test("18. Cross-process reservation contention admits exactly one claimant", async () => {
		const sandbox = createTestSandbox();
		try {
			const worktree = path.join(sandbox.tmpRoot, "project");
			fs.mkdirSync(worktree, { recursive: true });
			const transcript = path.join(sandbox.sessionsDir, "contended.jsonl");
			fs.writeFileSync(transcript, '{"type":"session","id":"contended"}\\n');
			const ledger = new DurableSubagentLedger({ durableDir: sandbox.durableDir, dbPath: sandbox.dbPath, sessionsDir: sandbox.sessionsDir, vendorLocksDir: sandbox.vendorLocksDir, vendorSessionsDir: sandbox.vendorSessionsDir });
			ledger.recordJobAdmission({ jobId: "job_cross_process", runId: "run_cross_process", worktreeCwd: worktree, spec: { task: "contention", profile: "general" }, isAsync: true });
			ledger.updateJobExecution({ jobId: "job_cross_process", pid: 999999999, startTimeTicks: 1, bootId: getSystemBootId(), preservedSessionPath: transcript, state: "interrupted" });
			ledger.close();

			const extensionUrl = pathToFileURL(EXTENSION_PATH).href;
			const childSource = `
				import os from 'node:os';
				import path from 'node:path';
				const mod = await import(${JSON.stringify(extensionUrl)});
				const config = ${JSON.stringify({ durableDir: sandbox.durableDir, dbPath: sandbox.dbPath, sessionsDir: sandbox.sessionsDir, vendorLocksDir: sandbox.vendorLocksDir, vendorSessionsDir: sandbox.vendorSessionsDir })};
				const ledger = new mod.DurableSubagentLedger(config);
				const owner = { pid: process.pid, ticks: mod.getProcessStartTimeTicks(process.pid), bootId: mod.getSystemBootId(), hostname: os.hostname(), sessionId: 'child-' + process.pid, sessionFile: path.join(${JSON.stringify(sandbox.tmpRoot)}, 'child-' + process.pid + '.jsonl'), cwd: ${JSON.stringify(path.resolve(worktree))} };
				const leaseOwner = 'session_' + owner.pid + '_' + owner.ticks + '_' + owner.sessionId + '_' + owner.cwd;
				const result = ledger.claimResumeLease('job_cross_process', leaseOwner, owner, 60000);
				console.log(JSON.stringify({ ok: result.ok, reason: result.reason }));
				ledger.close();
			`;
			const launch = () => new Promise((resolve, reject) => {
				const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
				let stdout = ""; let stderr = "";
				child.stdout.setEncoding("utf8").on("data", (s) => stdout += s);
				child.stderr.setEncoding("utf8").on("data", (s) => stderr += s);
				child.on("error", reject);
				child.on("close", (code) => code === 0 ? resolve(JSON.parse(stdout.trim().split("\\n").at(-1))) : reject(new Error(`claim child exit ${code}: ${stderr}`)));
			});
			const outcomes = await Promise.all(Array.from({ length: 4 }, () => launch()));
			assert.equal(outcomes.filter((o) => o.ok).length, 1, "SQLite transaction admits exactly one independent process");
			const final = new DurableSubagentLedger({ durableDir: sandbox.durableDir, dbPath: sandbox.dbPath, sessionsDir: sandbox.sessionsDir, vendorLocksDir: sandbox.vendorLocksDir, vendorSessionsDir: sandbox.vendorSessionsDir });
			assert.equal(final.getJob("job_cross_process").resume_count, 1);
			final.close();
		} finally { sandbox.cleanup(); }
	});

	await t.test("19. Startup keeps unknown liveness nonclaimable and preserves pending state", () => {
		const sandbox = createTestSandbox();
		try {
			const ledger = new DurableSubagentLedger({
				durableDir: sandbox.durableDir,
				dbPath: sandbox.dbPath,
				sessionsDir: sandbox.sessionsDir,
				vendorLocksDir: sandbox.vendorLocksDir,
				vendorSessionsDir: sandbox.vendorSessionsDir,
			});
			const transcript = path.join(sandbox.sessionsDir, "unknown.jsonl");
			fs.writeFileSync(transcript, '{"type":"session","id":"unknown"}\\n');
			ledger.recordJobAdmission({
				jobId: "unknown-live-job",
				runId: "unknown-live-run",
				worktreeCwd: sandbox.tmpRoot,
				spec: { task: "uncertain worker", profile: "general" },
				isAsync: true,
			});
			ledger.updateJobExecution({ jobId: "unknown-live-job", pid: process.pid, preservedSessionPath: transcript, state: "running" });
			const report = ledger.reconcileOnStartup();
			assert.equal(report.unknownWorkers.length, 1, "Missing birth ticks/boot identity remains explicitly unknown");
			assert.equal(ledger.getJob("unknown-live-job").state, "running", "Unknown must not be rewritten as interrupted/dead");
			const claim = ledger.claimResumeLease("unknown-live-job", "would-be-claimant");
			assert.equal(claim.ok, false, "Unknown liveness must never become claimable");
			assert.equal(claim.reason, "process_liveness_unverifiable");
			assert.equal(fs.existsSync(transcript), true, "Uncertain transcript remains preserved");
			ledger.close();
		} finally {
			sandbox.cleanup();
		}
	});
});
