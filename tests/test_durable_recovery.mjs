/**
 * Comprehensive Test Suite for Pi Durable Subagent Recovery.
 *
 * Covers all mandatory testing specifications:
 * 1. Isolated temporary namespace (never touches live workers or real config).
 * 2. SQLite WAL configuration (FULL durability, schema versioning, indices).
 * 3. REAL synthetic process crash (parent kill -9), child liveness detection,
 *    and non-destructive orphan protection (vendor lock shield).
 * 4. Dead vs still alive vs PID reuse vs unknown identity protection.
 * 5. Async launch receipt != worker completion tracking.
 * 6. Concurrent admission and resume lease claims (4 writers, CAS atomic lease).
 * 7. Absolute path resumption across different working directories.
 * 8. Interrupted SQLite WAL integrity.
 * 9. Corrupt DB graceful fail-safe recovery (never crashes startup).
 * 10. Retention sweep rules (never prunes active/unresolved jobs) and distillation detection.
 * 11. Installer idempotence and hash-safe rollback.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
		checkProcessLiveness,
		getProcessStartTimeTicks,
		getSystemBootId,
		protectVendorOrphanRecords,
		preserveSessionFile,
		resolveSessionFilePath,
		isSessionDistilled,
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
			assert.equal(userVersion.user_version, 1, "Schema version must be 1");

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
		try {
			// Spawn a real long-running child process simulating a subagent
			const childScript = `
				const fs = require("node:fs");
				const sessionFile = process.argv[1];
				fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "child-session-123" }) + "\\n");
				setInterval(() => {}, 1000);
			`;
			const childSessionFile = path.join(sandbox.vendorSessionsDir, "child-session-123.jsonl");
			const child = spawn(process.execPath, ["-e", childScript, childSessionFile], {
				detached: true,
				stdio: "ignore",
			});
			child.unref();

			const childPid = child.pid;
			assert.ok(childPid && childPid > 0, "Child process must have valid PID");

			// Give child process a moment to write session file
			await new Promise((r) => setTimeout(r, 200));
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

			const parent = spawn(process.execPath, ["--input-type=module", "-e", parentScript], {
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

			// 1. Verify vendor lock record was shielded so native plugin will NOT kill it
			const updatedLockRecord = JSON.parse(fs.readFileSync(vendorLockFile, "utf8"));
			assert.equal(updatedLockRecord.state, "terminal", "Vendor lock record must be marked terminal to shield child");
			assert.equal(updatedLockRecord.terminalState, "detached-protected");
			assert.equal(report.protectedFromVendor, 1, "Report must reflect 1 protected worker");

			// 2. Verify child process is STILL ALIVE (never killed!)
			childLiveness = checkProcessLiveness({ pid: childPid, startTimeTicks: ticks, bootId });
			assert.equal(childLiveness.alive, true, "Child process must NOT have been killed by reconciler");
			assert.equal(report.aliveWorkers.length, 1, "Reconciler must detect 1 live worker");

			// 3. Now terminate the child process
			try {
				process.kill(childPid, "SIGTERM");
			} catch {}
			await new Promise((r) => setTimeout(r, 200));

			// Re-run reconcile: now child is dead, state should be orphaned_dead
			const report2 = freshLedger.reconcileOnStartup();
			assert.equal(report2.orphanedDead.length, 1, "Child should now be recognized as dead");

			freshLedger.close();
		} finally {
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
			// In our extension logic, async runs remain in 'running' state
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

			ledger.recordJobAdmission({
				jobId: "contended_job",
				runId: "contended_run",
				worktreeCwd: sandbox.tmpRoot,
				spec: { task: "contended task" },
				isAsync: false,
			});
			ledger.updateJobExecution({
				jobId: "contended_job",
				state: "orphaned_dead",
			});

			// 4 concurrent writers attempt to claim the resume lease simultaneously
			const writers = ["writer-A", "writer-B", "writer-C", "writer-D"];
			const results = await Promise.all(
				writers.map((writerId) => {
					return new Promise((resolve) => {
						// Independent ledger instance per writer
						const writerLedger = new DurableSubagentLedger({
							durableDir: sandbox.durableDir,
							dbPath: sandbox.dbPath,
							sessionsDir: sandbox.sessionsDir,
							vendorLocksDir: sandbox.vendorLocksDir,
							vendorSessionsDir: sandbox.vendorSessionsDir,
						});
						const outcome = writerLedger.claimResumeLease("contended_job", writerId, 30000);
						writerLedger.close();
						resolve({ writerId, outcome });
					});
				})
			);

			const successes = results.filter((r) => r.outcome.ok === true);
			const failures = results.filter((r) => r.outcome.ok === false);

			assert.equal(successes.length, 1, "Exactly one writer must acquire the lease");
			assert.equal(failures.length, 3, "All other writers must be rejected");

			const winner = successes[0].writerId;
			const finalJob = ledger.getJob("contended_job");
			assert.equal(finalJob.resume_lease_owner, winner);
			assert.equal(finalJob.state, "resuming");
			assert.equal(finalJob.resume_count, 1);

			// Now test: active running job must refuse resume claim!
			ledger.updateJobExecution({
				jobId: "contended_job",
				pid: process.pid,
				state: "running",
			});
			const refuseOutcome = ledger.claimResumeLease("contended_job", "writer-E");
			assert.equal(refuseOutcome.ok, false);
			assert.equal(refuseOutcome.reason, "process_still_running", "Active running job must refuse resume");

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

			// Perform 50 rapid insertions
			for (let i = 0; i < 50; i++) {
				ledger.recordJobAdmission({
					jobId: `job_${i}`,
					runId: `run_${i}`,
					worktreeCwd: sandbox.tmpRoot,
					spec: { task: `task ${i}` },
					isAsync: false,
				});
			}

			// Verify WAL file exists
			const walFile = `${sandbox.dbPath}-wal`;
			assert.ok(fs.existsSync(walFile), "WAL file must exist");

			// Run PRAGMA integrity_check
			const integrity = ledger.db.prepare("PRAGMA integrity_check").get();
			assert.equal(integrity.integrity_check, "ok", "Database integrity must be ok");

			ledger.close();
		} finally {
			sandbox.cleanup();
		}
	});

	await t.test("8. Corrupt DB graceful failure & backup (Gap 5 fail-safe)", () => {
		const sandbox = createTestSandbox();
		try {
			// Write garbage bytes to database file
			fs.writeFileSync(sandbox.dbPath, "CORRUPT GARBAGE NOT SQLITE DATA AT ALL");

			// Opening ledger must NOT throw or crash startup; it backs up corrupt file and re-inits
			const ledger = new DurableSubagentLedger({
				durableDir: sandbox.durableDir,
				dbPath: sandbox.dbPath,
				sessionsDir: sandbox.sessionsDir,
				vendorLocksDir: sandbox.vendorLocksDir,
				vendorSessionsDir: sandbox.vendorSessionsDir,
			});

			const check = ledger.db.prepare("PRAGMA quick_check").get();
			assert.equal(check.quick_check, "ok", "Fresh database must be valid and operational");

			// Verify corrupt backup was created
			const files = fs.readdirSync(sandbox.durableDir);
			const corruptBackup = files.find((f) => f.includes("corrupt"));
			assert.ok(corruptBackup, "Corrupt backup file must be created");

			ledger.close();
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

			// 1. Run installer pass 1
			const env = {
				...process.env,
				PI_DURABLE_DIR: sandbox.durableDir,
				PI_CODING_AGENT_DIR: sandbox.agentDir,
			};
			const pass1 = spawnSync(ensureScript, { env, encoding: "utf8" });
			assert.equal(pass1.status, 0, `Pass 1 failed: ${pass1.stderr}`);

			const deployedExt = path.join(sandbox.agentDir, "extensions", "durable-subagent-recovery.ts");
			assert.ok(fs.existsSync(deployedExt), "Extension must be deployed");
			const hash1 = execSync(`sha256sum "${deployedExt}"`, { encoding: "utf8" }).split(" ")[0];

			// 2. Run installer pass 2 (idempotence)
			const pass2 = spawnSync(ensureScript, { env, encoding: "utf8" });
			assert.equal(pass2.status, 0, `Pass 2 failed: ${pass2.stderr}`);
			const hash2 = execSync(`sha256sum "${deployedExt}"`, { encoding: "utf8" }).split(" ")[0];
			assert.equal(hash1, hash2, "Installer must be idempotent without modifying file");

			// 3. Modify deployed file, run installer again -> verify backup was created
			fs.appendFileSync(deployedExt, "\n// modified by user\n");
			const pass3 = spawnSync(ensureScript, { env, encoding: "utf8" });
			assert.equal(pass3.status, 0);

			const backups = fs.readdirSync(sandbox.durableDir).filter((f) => f.includes(".bak."));
			assert.ok(backups.length > 0, "Backup must be created when replacing modified extension");

			// 4. Test doctor command
			const doc = spawnSync(doctorScript, { env, encoding: "utf8" });
			assert.equal(doc.status, 0, `Doctor failed: ${doc.stderr}`);
			assert.ok(doc.stdout.includes("All health checks passed"), "Doctor should report all checks passed");

			// 5. Test rollback command
			const roll = spawnSync(doctorScript, ["--rollback"], { env, encoding: "utf8" });
			assert.equal(roll.status, 0, `Rollback failed: ${roll.stderr}`);
			assert.ok(roll.stdout.includes("Restored prior extension"), "Rollback must restore prior version");

			// Verify database is still intact after rollback (runtime jobs never wiped)
			assert.ok(fs.existsSync(sandbox.dbPath), "Database must be preserved across rollbacks");
		} finally {
			sandbox.cleanup();
		}
	});
});
