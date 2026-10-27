import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DatabaseSync } from "node:sqlite";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";

// Typebox resolution: Pi maps 'typebox' at runtime; fallback for standalone test runners
let Type: any;
try {
	const tb = await import("typebox");
	Type = tb.Type;
} catch {
	try {
		const tb = await import("/data/data/com.termux/files/home/.pi/agent/install/releases/1.4.0/node_modules/typebox/build/index.mjs");
		Type = tb.Type;
	} catch {
		Type = {
			Object: (x: any, opts?: any) => ({ type: "object", properties: x, ...opts }),
			String: (opts?: any) => ({ type: "string", ...opts }),
			Boolean: (opts?: any) => ({ type: "boolean", ...opts }),
			Optional: (x: any) => ({ ...x, optional: true }),
			Union: (x: any, opts?: any) => ({ anyOf: x, ...opts }),
			Literal: (x: any) => ({ const: x }),
		};
	}
}

// ============================================================================
// Types and Interfaces
// ============================================================================

export class DatabaseCorruptError extends Error {
	public readonly dbPath: string;
	constructor(message: string, dbPath: string) {
		super(message);
		this.name = "DatabaseCorruptError";
		this.dbPath = dbPath;
	}
}

export interface ProcessIdentity {
	pid: number;
	startTimeTicks: number; // Linux clock ticks from /proc/<pid>/stat field 22
	bootId: string; // Kernel boot ID from /proc/sys/kernel/random/boot_id
	hostname: string;
}

export type ProcessLiveness =
	| { alive: true; verified: true }
	| { alive: false; reason: "not_found" | "rebooted" | "pid_reused" }
	| { alive: boolean; verified: false; reason: "permission_denied" | "unverifiable" };

export interface SubagentJobRecord {
	job_id: string;
	run_id: string;
	tool_call_id: string | null;
	parent_session_file: string | null;
	parent_session_id: string | null;
	worktree_cwd: string;
	spec_json: string;
	state: "queued" | "running" | "completed" | "failed" | "interrupted" | "timed_out" | "orphaned_dead" | "resuming";
	is_async: number; // 0 or 1
	pid: number | null;
	start_time_ticks: number | null;
	boot_id: string | null;
	hostname: string | null;
	child_session_id: string | null;
	child_session_path: string | null;
	preserved_session_path: string | null;
	is_distilled: number; // 0 or 1
	resume_lease_owner: string | null;
	resume_lease_expires_at: number | null;
	resume_count: number;
	created_at: number;
	updated_at: number;
	ended_at: number | null;
	duration_ms: number | null;
	exit_code: number | null;
	error_message: string | null;
	summary: string | null;
	last_checkpoint_turn: number | null;
	last_checkpoint_text: string | null;
	usage_input: number | null;
	usage_output: number | null;
	usage_cost: number | null;
}

export interface LedgerConfig {
	durableDir: string;
	dbPath: string;
	sessionsDir: string;
	vendorLocksDir: string;
	vendorSessionsDir: string;
	retentionDays: number;
	quarantineCorrupt?: boolean;
	shieldVendorLocks?: boolean; // Opt-in legacy mutation; default false (non-mutating)
}

export interface ResumeSpec {
	task: string;
	resume: string;
	cwd: string;
}

// ============================================================================
// Process Identity & Liveness Probing (Linux / Termux)
// ============================================================================

export function getSystemBootId(): string {
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		return "";
	}
}

export function getProcessStartTimeTicks(pid: number): number {
	if (!pid || pid <= 0) return 0;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		if (closeParen === -1) return 0;
		const rest = stat.slice(closeParen + 2).trim();
		const fields = rest.split(/\s+/);
		// Field 22 in /proc/<pid>/stat is index 19 in fields (0 is state)
		const ticks = Number(fields[19]);
		return Number.isFinite(ticks) ? ticks : 0;
	} catch {
		return 0;
	}
}

export function checkProcessLiveness(identity: {
	pid?: number | null;
	startTimeTicks?: number | null;
	bootId?: string | null;
}): ProcessLiveness {
	const pid = identity.pid;
	if (!pid || pid <= 0) return { alive: false, reason: "not_found" };

	// 1. Boot ID check: if system rebooted, process is dead even if PID was recycled
	if (identity.bootId) {
		const currentBootId = getSystemBootId();
		if (currentBootId && currentBootId !== identity.bootId) {
			return { alive: false, reason: "rebooted" };
		}
	}

	// 2. /proc/<pid>/stat check
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		if (closeParen === -1) {
			return { alive: true, verified: false, reason: "unverifiable" };
		}
		const rest = stat.slice(closeParen + 2).trim();
		const fields = rest.split(/\s+/);
		const currentTicks = Number(fields[19]);

		const recordedTicks = identity.startTimeTicks ?? 0;
		if (recordedTicks > 0) {
			if (currentTicks === recordedTicks) {
				return { alive: true, verified: true };
			}
			// PID exists, but start time ticks differ -> PID reuse!
			// Verified identity mismatch: old process is gone, but foreign PID must NEVER be signaled.
			return { alive: false, reason: "pid_reused" };
		}

		// startTimeTicks was 0 or not recorded -> cannot prove identity
		return { alive: true, verified: false, reason: "unverifiable" };
	} catch (err: any) {
		if (err?.code === "ENOENT") {
			return { alive: false, reason: "not_found" };
		}
		if (err?.code === "EACCES" || err?.code === "EPERM") {
			return { alive: true, verified: false, reason: "permission_denied" };
		}
		return { alive: false, reason: "not_found" };
	}
}

// ============================================================================
// Session Path & Preservation Utilities
// ============================================================================

export function resolveSessionFilePath(sessionDir: string, sessionId: string): string | undefined {
	if (!sessionDir || !sessionId) return undefined;
	const exact = join(sessionDir, `${sessionId}.jsonl`);
	if (existsSync(exact)) return exact;
	try {
		const entries = readdirSync(sessionDir);
		for (const name of entries) {
			if (name.endsWith(".jsonl") && (name === `${sessionId}.jsonl` || name.includes(sessionId))) {
				return join(sessionDir, name);
			}
		}
	} catch {}
	return undefined;
}

export function isSessionDistilled(sessionDir: string, sessionId: string): boolean {
	if (!sessionDir || !sessionId) return false;
	const exactJsonl = join(sessionDir, `${sessionId}.jsonl`);
	const exactDigest = join(sessionDir, `${sessionId}.digest.json`);
	if (!existsSync(exactJsonl) && existsSync(exactDigest)) return true;
	try {
		const entries = readdirSync(sessionDir);
		let hasDigest = false;
		let hasJsonl = false;
		for (const name of entries) {
			if (name.includes(sessionId)) {
				if (name.endsWith(".jsonl")) hasJsonl = true;
				if (name.endsWith(".digest.json")) hasDigest = true;
			}
		}
		return hasDigest && !hasJsonl;
	} catch {
		return false;
	}
}

export function preserveSessionFile(sourcePath: string, durableSessionsDir: string): string | null {
	if (!sourcePath || !existsSync(sourcePath)) return null;
	try {
		mkdirSync(durableSessionsDir, { recursive: true, mode: 0o700 });
		const fileName = basename(sourcePath);
		const targetPath = join(durableSessionsDir, fileName);

		if (existsSync(targetPath)) {
			try {
				const srcStat = statSync(sourcePath);
				const tgtStat = statSync(targetPath);
				// If target already contains all bytes, keep it
				if (srcStat.size <= tgtStat.size && srcStat.mtimeMs <= tgtStat.mtimeMs) {
					return targetPath;
				}
			} catch {}
		}

		copyFileSync(sourcePath, targetPath);
		try {
			chmodSync(targetPath, 0o600);
		} catch {}
		return targetPath;
	} catch {
		return null;
	}
}

// ============================================================================
// Vendor Orphan Reconcile Protection & Non-Mutating Observer
// ============================================================================

/**
 * Scan vendor run lock records in ~/.pi/subagent-locks/runs/.
 *
 * In honest logical recovery, we default to a NON-MUTATING observer.
 * Setting `record.state = "terminal"` removes running sessions from native
 * `busy` and `liveWorktrees` sets in native `scheduleMaintenance`, which triggers
 * premature transcript distillation and worktree deletion!
 *
 * This function preserves child transcripts into $durableDir/sessions before
 * vendor maintenance runs, without stripping native busy/worktree protection.
 */
export function protectVendorOrphanRecords(
	vendorLocksDir: string,
	options?: {
		vendorSessionsDir?: string;
		durableSessionsDir?: string;
		legacyMutateState?: boolean;
	},
): { protectedCount: number; preservedCount?: number } {
	const runsDir = join(vendorLocksDir, "runs");
	if (!existsSync(runsDir)) return { protectedCount: 0, preservedCount: 0 };
	let count = 0;
	let preservedCount = 0;
	try {
		const entries = readdirSync(runsDir);
		for (const name of entries) {
			if (!name.endsWith(".json")) continue;
			const file = join(runsDir, name);
			try {
				const content = readFileSync(file, "utf8");
				const record = JSON.parse(content);
				if (record.state === "running") {
					// 1. Preserve child transcript if known
					if (record.childSessionId && options?.vendorSessionsDir && options?.durableSessionsDir) {
						const live = resolveSessionFilePath(options.vendorSessionsDir, record.childSessionId);
						if (live) {
							const preserved = preserveSessionFile(live, options.durableSessionsDir);
							if (preserved) preservedCount++;
						}
					}

					// 2. Only mutate if explicitly requested (legacy test mock mode)
					if (options?.legacyMutateState && record.process?.pid) {
						const liveness = checkProcessLiveness({
							pid: record.process.pid,
							startTimeTicks: record.process.startTime,
							bootId: record.process.bootId,
						});
						if (liveness.alive) {
							record.state = "terminal";
							record.terminalState = "detached-protected";
							record.protectedBy = "durable-subagent-recovery";
							record.updatedAt = Date.now();
							writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
							count++;
						}
					} else {
						count++;
					}
				}
			} catch {}
		}
	} catch {}
	return { protectedCount: count, preservedCount };
}

// ============================================================================
// Resume Command Spec Generation (Policy Validated)
// ============================================================================

export function buildResumeSpec(job: SubagentJobRecord, preservedSessionPath: string): ResumeSpec {
	let originalTask = "Resume interrupted task";
	try {
		const spec = JSON.parse(job.spec_json || "{}");
		if (spec.task && typeof spec.task === "string" && spec.task.trim()) {
			originalTask = spec.task.trim();
		}
	} catch {}

	return {
		task: `Resume: ${originalTask}`,
		resume: preservedSessionPath,
		cwd: job.worktree_cwd,
	};
}

export function buildResumeCommand(job: SubagentJobRecord, preservedSessionPath: string): string {
	const spec = buildResumeSpec(job, preservedSessionPath);
	return `subagent({ task: ${JSON.stringify(spec.task)}, resume: ${JSON.stringify(spec.resume)}, cwd: ${JSON.stringify(spec.cwd)} })`;
}

// ============================================================================
// Durable Subagent Database Ledger (node:sqlite WAL)
// ============================================================================

export class DurableSubagentLedger {
	public db: DatabaseSync;
	public readonly config: LedgerConfig;

	constructor(customConfig?: Partial<LedgerConfig>) {
		const home = homedir();
		const durableDir = customConfig?.durableDir ?? process.env.PI_DURABLE_DIR ?? join(home, ".pi", "durable");
		const dbPath = customConfig?.dbPath ?? join(durableDir, "subagents.sqlite");
		const sessionsDir = customConfig?.sessionsDir ?? join(durableDir, "sessions");
		const vendorLocksDir = customConfig?.vendorLocksDir ?? process.env.PI_SUBAGENT_LOCK_DIR ?? join(home, ".pi", "subagent-locks");
		const vendorSessionsDir = customConfig?.vendorSessionsDir ?? process.env.PI_SUBAGENT_SESSION_DIR ?? join(home, ".pi", "subagent-sessions");
		const retentionDays = customConfig?.retentionDays ?? 14;
		const quarantineCorrupt = customConfig?.quarantineCorrupt ?? false;
		const shieldVendorLocks = customConfig?.shieldVendorLocks ?? false;

		this.config = {
			durableDir,
			dbPath,
			sessionsDir,
			vendorLocksDir,
			vendorSessionsDir,
			retentionDays,
			quarantineCorrupt,
			shieldVendorLocks,
		};

		mkdirSync(this.config.durableDir, { recursive: true, mode: 0o700 });
		mkdirSync(this.config.sessionsDir, { recursive: true, mode: 0o700 });

		this.db = this.initDatabase(this.config.dbPath, { quarantineCorrupt: this.config.quarantineCorrupt });
	}

	private initDatabase(dbPath: string, options?: { quarantineCorrupt?: boolean }): DatabaseSync {
		let db: DatabaseSync;
		try {
			db = new DatabaseSync(dbPath);
			// Check integrity
			const check = db.prepare("PRAGMA quick_check").get() as any;
			if (check && check.quick_check !== "ok") {
				throw new Error(`Corrupt database: ${JSON.stringify(check)}`);
			}
		} catch (err: any) {
			if (!options?.quarantineCorrupt) {
				// Fail-closed: preserve original database, WAL, and SHM untouched (P1-3)
				// Never silently wipe active admission or lease state.
				throw new DatabaseCorruptError(`Database corruption detected in ${dbPath}: ${err?.message || String(err)}`, dbPath);
			}
			// Explicit quarantine requested (e.g. via doctor tool --quarantine-corrupt)
			try {
				if (existsSync(dbPath)) {
					const ts = Date.now();
					renameSync(dbPath, `${dbPath}.corrupt.${ts}`);
					const wal = `${dbPath}-wal`;
					const shm = `${dbPath}-shm`;
					if (existsSync(wal)) renameSync(wal, `${wal}.corrupt.${ts}`);
					if (existsSync(shm)) renameSync(shm, `${shm}.corrupt.${ts}`);
				}
			} catch {}
			db = new DatabaseSync(dbPath);
		}

		// Durability and security settings
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("PRAGMA synchronous = FULL;"); // FULL durability for leases and state
		db.exec("PRAGMA busy_timeout = 5000;");
		db.exec("PRAGMA foreign_keys = ON;");

		this.runMigrations(db);
		this.securePermissions(dbPath);

		return db;
	}

	private securePermissions(dbPath: string): void {
		try {
			chmodSync(dbPath, 0o600);
			const wal = `${dbPath}-wal`;
			const shm = `${dbPath}-shm`;
			if (existsSync(wal)) chmodSync(wal, 0o600);
			if (existsSync(shm)) chmodSync(shm, 0o600);
		} catch {}
	}

	private runMigrations(db: DatabaseSync): void {
		const versionRow = db.prepare("PRAGMA user_version").get() as any;
		const currentVersion = versionRow ? Number(versionRow.user_version) : 0;

		if (currentVersion < 1) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS subagent_jobs (
					job_id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL,
					tool_call_id TEXT,
					parent_session_file TEXT,
					parent_session_id TEXT,
					worktree_cwd TEXT NOT NULL,
					spec_json TEXT NOT NULL,
					state TEXT NOT NULL,
					is_async INTEGER NOT NULL DEFAULT 0,
					pid INTEGER,
					start_time_ticks INTEGER,
					boot_id TEXT,
					hostname TEXT,
					child_session_id TEXT,
					child_session_path TEXT,
					preserved_session_path TEXT,
					is_distilled INTEGER NOT NULL DEFAULT 0,
					resume_lease_owner TEXT,
					resume_lease_expires_at INTEGER,
					resume_count INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					ended_at INTEGER,
					duration_ms INTEGER,
					exit_code INTEGER,
					error_message TEXT,
					summary TEXT,
					last_checkpoint_turn INTEGER,
					last_checkpoint_text TEXT,
					usage_input INTEGER,
					usage_output INTEGER,
					usage_cost REAL
				);

				CREATE INDEX IF NOT EXISTS idx_jobs_state ON subagent_jobs(state);
				CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON subagent_jobs(run_id);
				CREATE INDEX IF NOT EXISTS idx_jobs_child_session ON subagent_jobs(child_session_id);
				CREATE INDEX IF NOT EXISTS idx_jobs_parent ON subagent_jobs(parent_session_file);
				CREATE INDEX IF NOT EXISTS idx_jobs_updated ON subagent_jobs(updated_at);
				PRAGMA user_version = 1;
			`);
		}
	}

	public close(): void {
		try {
			this.db.close();
		} catch {}
	}

	// ---- Job Mutations --------------------------------------------------------

	public recordJobAdmission(params: {
		jobId: string;
		runId: string;
		toolCallId?: string;
		parentSessionFile?: string;
		parentSessionId?: string;
		worktreeCwd: string;
		spec: any;
		isAsync: boolean;
	}): SubagentJobRecord {
		const now = Date.now();
		const specJson = JSON.stringify(params.spec);
		const stmt = this.db.prepare(`
			INSERT INTO subagent_jobs (
				job_id, run_id, tool_call_id, parent_session_file, parent_session_id,
				worktree_cwd, spec_json, state, is_async, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
			ON CONFLICT(job_id) DO UPDATE SET
				run_id = excluded.run_id,
				spec_json = excluded.spec_json,
				updated_at = excluded.updated_at
		`);
		stmt.run(
			params.jobId,
			params.runId,
			params.toolCallId ?? null,
			params.parentSessionFile ?? null,
			params.parentSessionId ?? null,
			params.worktreeCwd,
			specJson,
			params.isAsync ? 1 : 0,
			now,
			now,
		);
		return this.getJob(params.jobId)!;
	}

	public updateJobRunId(jobId: string, runId: string): void {
		const now = Date.now();
		this.db.prepare("UPDATE subagent_jobs SET run_id = ?, updated_at = ? WHERE job_id = ?").run(runId, now, jobId);
		this.securePermissions(this.config.dbPath);
	}

	public updateJobExecution(params: {
		jobId: string;
		pid?: number;
		childSessionId?: string;
		childSessionPath?: string;
		preservedSessionPath?: string;
		state?: SubagentJobRecord["state"];
		turn?: number;
		checkpointText?: string;
		worktreeCwd?: string;
	}): void {
		const now = Date.now();
		const bootId = params.pid ? getSystemBootId() : null;
		const ticks = params.pid ? getProcessStartTimeTicks(params.pid) : null;
		const host = hostname();

		const updates: string[] = ["updated_at = ?"];
		const values: any[] = [now];

		if (params.state !== undefined) {
			updates.push("state = ?");
			values.push(params.state);
		}
		if (params.pid !== undefined) {
			updates.push("pid = ?", "start_time_ticks = ?", "boot_id = ?", "hostname = ?");
			values.push(params.pid, ticks, bootId, host);
		}
		if (params.childSessionId !== undefined) {
			updates.push("child_session_id = ?");
			values.push(params.childSessionId);
		}
		if (params.childSessionPath !== undefined) {
			updates.push("child_session_path = ?");
			values.push(params.childSessionPath);
		}
		if (params.preservedSessionPath !== undefined) {
			updates.push("preserved_session_path = ?");
			values.push(params.preservedSessionPath);
		}
		if (params.worktreeCwd !== undefined) {
			updates.push("worktree_cwd = ?");
			values.push(params.worktreeCwd);
		}
		if (params.turn !== undefined) {
			updates.push("last_checkpoint_turn = ?");
			values.push(params.turn);
		}
		if (params.checkpointText !== undefined) {
			updates.push("last_checkpoint_text = ?");
			values.push(params.checkpointText);
		}

		values.push(params.jobId);
		this.db.prepare(`UPDATE subagent_jobs SET ${updates.join(", ")} WHERE job_id = ?`).run(...values);
		this.securePermissions(this.config.dbPath);
	}

	public recordJobCompletion(params: {
		jobId: string;
		state: "completed" | "failed" | "interrupted" | "timed_out";
		exitCode?: number;
		summary?: string;
		errorMessage?: string;
		durationMs?: number;
		usage?: { input?: number; output?: number; cost?: number };
	}): void {
		const now = Date.now();
		const stmt = this.db.prepare(`
			UPDATE subagent_jobs SET
				state = ?,
				ended_at = ?,
				duration_ms = ?,
				exit_code = ?,
				summary = ?,
				error_message = ?,
				usage_input = ?,
				usage_output = ?,
				usage_cost = ?,
				updated_at = ?
			WHERE job_id = ?
		`);
		stmt.run(
			params.state,
			now,
			params.durationMs ?? null,
			params.exitCode ?? (params.state === "completed" ? 0 : 1),
			params.summary ?? null,
			params.errorMessage ?? null,
			params.usage?.input ?? null,
			params.usage?.output ?? null,
			params.usage?.cost ?? null,
			now,
			params.jobId,
		);
		this.securePermissions(this.config.dbPath);
	}

	// ---- Job Queries ----------------------------------------------------------

	public getJob(jobId: string): SubagentJobRecord | undefined {
		const row = this.db.prepare("SELECT * FROM subagent_jobs WHERE job_id = ?").get(jobId);
		return (row as SubagentJobRecord) ?? undefined;
	}

	public findJobByRunId(runId: string): SubagentJobRecord | undefined {
		const row = this.db.prepare("SELECT * FROM subagent_jobs WHERE run_id = ?").get(runId);
		return (row as SubagentJobRecord) ?? undefined;
	}

	public findJobByToolCallId(toolCallId: string): SubagentJobRecord | undefined {
		const row = this.db.prepare("SELECT * FROM subagent_jobs WHERE tool_call_id = ?").get(toolCallId);
		return (row as SubagentJobRecord) ?? undefined;
	}

	public listRecoverableJobs(filter?: { parentSessionFile?: string }): SubagentJobRecord[] {
		let query = "SELECT * FROM subagent_jobs WHERE state IN ('running', 'interrupted', 'timed_out', 'orphaned_dead', 'resuming')";
		const params: any[] = [];
		if (filter?.parentSessionFile) {
			query += " AND parent_session_file = ?";
			params.push(filter.parentSessionFile);
		}
		query += " ORDER BY updated_at DESC";
		return (this.db.prepare(query).all(...params) as SubagentJobRecord[]) ?? [];
	}

	public listAllJobs(limit = 50): SubagentJobRecord[] {
		return (this.db.prepare("SELECT * FROM subagent_jobs ORDER BY created_at DESC LIMIT ?").all(limit) as SubagentJobRecord[]) ?? [];
	}

	public readVendorRunRecord(runId: string): any | undefined {
		try {
			const runsDir = join(this.config.vendorLocksDir, "runs");
			const exact = join(runsDir, `${runId}.json`);
			if (existsSync(exact)) return JSON.parse(readFileSync(exact, "utf8"));
			if (existsSync(runsDir)) {
				for (const f of readdirSync(runsDir)) {
					if (f.endsWith(".json") && f.startsWith(runId)) {
						return JSON.parse(readFileSync(join(runsDir, f), "utf8"));
					}
				}
			}
		} catch {}
		return undefined;
	}

	// ---- Transactional CAS Claim (Gap 4) --------------------------------------

	public claimResumeLease(
		jobId: string,
		leaseOwner: string,
		leaseDurationMs = 60000,
	): { ok: true; job: SubagentJobRecord } | { ok: false; reason: string; job?: SubagentJobRecord } {
		this.db.exec("BEGIN IMMEDIATE;");
		try {
			const row = this.db.prepare("SELECT * FROM subagent_jobs WHERE job_id = ?").get(jobId) as SubagentJobRecord | undefined;
			if (!row) {
				this.db.exec("ROLLBACK;");
				return { ok: false, reason: "job_not_found" };
			}

			// Refuse resume if process is still running or unverifiable (P1-2)
			if ((row.state === "running" || row.state === "resuming") && row.pid) {
				const liveness = checkProcessLiveness({
					pid: row.pid,
					startTimeTicks: row.start_time_ticks,
					bootId: row.boot_id,
				});
				if (liveness.verified === false) {
					this.db.exec("ROLLBACK;");
					return { ok: false, reason: "process_liveness_unverifiable", job: row };
				}
				if (liveness.alive) {
					this.db.exec("ROLLBACK;");
					return { ok: false, reason: "process_still_running", job: row };
				}
			}

			// Check active lease
			const now = Date.now();
			if (row.resume_lease_expires_at && row.resume_lease_expires_at > now && row.resume_lease_owner !== leaseOwner) {
				this.db.exec("ROLLBACK;");
				return { ok: false, reason: "leased_by_another_process", job: row };
			}

			const expiresAt = now + leaseDurationMs;
			this.db
				.prepare(
					`
				UPDATE subagent_jobs
				SET resume_lease_owner = ?,
					resume_lease_expires_at = ?,
					resume_count = resume_count + 1,
					state = 'resuming',
					updated_at = ?
				WHERE job_id = ?
			`,
				)
				.run(leaseOwner, expiresAt, now, jobId);

			this.db.exec("COMMIT;");
			const updated = this.getJob(jobId)!;
			return { ok: true, job: updated };
		} catch (err: any) {
			try {
				this.db.exec("ROLLBACK;");
			} catch {}
			return { ok: false, reason: `transaction_error: ${err?.message || String(err)}` };
		}
	}

	public releaseResumeLease(jobId: string, leaseOwner: string): void {
		const now = Date.now();
		this.db
			.prepare(
				`
			UPDATE subagent_jobs
			SET resume_lease_owner = NULL,
				resume_lease_expires_at = NULL,
				updated_at = ?
			WHERE job_id = ? AND resume_lease_owner = ?
		`,
			)
			.run(now, jobId, leaseOwner);
	}

	// ---- Non-Destructive Startup Reconciliation (Gap 1 & 4) -------------------

	public reconcileOnStartup(): {
		aliveWorkers: SubagentJobRecord[];
		orphanedDead: SubagentJobRecord[];
		protectedFromVendor: number;
		preservedTranscripts: number;
	} {
		// 1. Scan vendor locks and preserve all child transcripts before maintenance runs
		const { protectedCount, preservedCount } = protectVendorOrphanRecords(this.config.vendorLocksDir, {
			vendorSessionsDir: this.config.vendorSessionsDir,
			durableSessionsDir: this.config.sessionsDir,
			legacyMutateState: this.config.shieldVendorLocks,
		});

		// 2. Scan our ledger's running/resuming jobs
		const activeJobs = this.db
			.prepare("SELECT * FROM subagent_jobs WHERE state IN ('running', 'resuming')")
			.all() as SubagentJobRecord[];

		const aliveWorkers: SubagentJobRecord[] = [];
		const orphanedDead: SubagentJobRecord[] = [];
		const now = Date.now();

		for (const job of activeJobs) {
			// If session file exists in vendor sessions or durable sessions, ensure it is preserved
			let sessionPath = job.preserved_session_path;
			if (!sessionPath && job.child_session_id) {
				const livePath = resolveSessionFilePath(this.config.vendorSessionsDir, job.child_session_id);
				if (livePath) {
					sessionPath = preserveSessionFile(livePath, this.config.sessionsDir) ?? undefined;
					if (sessionPath) {
						this.updateJobExecution({ jobId: job.job_id, preservedSessionPath: sessionPath, childSessionPath: livePath });
					}
				}
			}

			// If no PID recorded yet, check vendor run lock record
			let pid = job.pid;
			let ticks = job.start_time_ticks;
			let bootId = job.boot_id;
			if (!pid && job.run_id) {
				const lockRec = this.readVendorRunRecord(job.run_id);
				if (lockRec?.process?.pid) {
					pid = lockRec.process.pid;
					ticks = lockRec.process.startTime;
					bootId = getSystemBootId();
					this.updateJobExecution({
						jobId: job.job_id,
						pid,
						childSessionId: lockRec.childSessionId ?? job.child_session_id ?? undefined,
						worktreeCwd: lockRec.worktreeCwd ?? job.worktree_cwd,
					});
				}
			}

			if (!pid) {
				// No process identity recorded before interruption -> interrupted
				this.db.prepare("UPDATE subagent_jobs SET state = 'interrupted', updated_at = ? WHERE job_id = ?").run(now, job.job_id);
				job.state = "interrupted";
				orphanedDead.push(job);
				continue;
			}

			const liveness = checkProcessLiveness({
				pid,
				startTimeTicks: ticks,
				bootId,
			});

			if (liveness.alive && liveness.verified) {
				aliveWorkers.push(job);
			} else {
				// Dead or unverifiable on parent restart -> mark interrupted (never fake successful completion)
				this.db.prepare("UPDATE subagent_jobs SET state = 'interrupted', updated_at = ? WHERE job_id = ?").run(now, job.job_id);
				job.state = "interrupted";
				orphanedDead.push(job);
			}
		}

		// 3. Check for distilled sessions
		for (const job of [...aliveWorkers, ...orphanedDead]) {
			if (job.child_session_id && !job.is_distilled) {
				const distilled = isSessionDistilled(this.config.vendorSessionsDir, job.child_session_id);
				if (distilled) {
					this.db.prepare("UPDATE subagent_jobs SET is_distilled = 1, updated_at = ? WHERE job_id = ?").run(now, job.job_id);
					job.is_distilled = 1;
				}
			}
		}

		return {
			aliveWorkers,
			orphanedDead,
			protectedFromVendor: protectedCount,
			preservedTranscripts: preservedCount ?? 0,
		};
	}

	// ---- Retention Sweep (Gap 5) ----------------------------------------------

	public sweepRetention(): { removed: number } {
		const cutoff = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
		// NEVER prune running or interrupted/resuming jobs
		const result = this.db
			.prepare(
				`
			DELETE FROM subagent_jobs
			WHERE state IN ('completed', 'failed', 'orphaned_dead')
			  AND updated_at < ?
		`,
			)
			.run(cutoff);
		return { removed: Number(result.changes) };
	}
}

// ============================================================================
// Extension Registration
// ============================================================================

export default function registerDurableSubagentRecovery(pi: ExtensionAPI): void {
	let ledger: DurableSubagentLedger | undefined;
	const activeToolCalls = new Map<
		string,
		{
			toolCallId: string;
			jobId: string;
			args: any;
			parentSessionFile: string | null;
			parentSessionId: string | null;
			worktreeCwd: string;
			isAsync: boolean;
		}
	>();

	function getLedger(): DurableSubagentLedger | undefined {
		if (!ledger) {
			try {
				ledger = new DurableSubagentLedger();
			} catch (err) {
				console.error("[durable-subagent-recovery] Failed to initialize ledger (fail-closed):", err);
				return undefined;
			}
		}
		return ledger;
	}

	pi.on("session_start", (_event, ctx) => {
		try {
			const inst = getLedger();
			if (!inst) return;
			const report = inst.reconcileOnStartup();
			inst.sweepRetention();

			if (report.aliveWorkers.length > 0 && ctx.hasUI) {
				ctx.ui.notify(
					`Durable subagent recovery: ${report.aliveWorkers.length} live worker(s) tracked.`,
					"info",
				);
			}
		} catch (err) {
			console.error("[durable-subagent-recovery] session_start error:", err);
		}
	});

	pi.on("session_shutdown", () => {
		if (ledger) {
			ledger.close();
			ledger = undefined;
		}
	});

	// SDK event order: tool_execution_start BEFORE tool_call.
	// We key by toolCallId and admit the job upon tool_execution_start.
	pi.on("tool_execution_start", (event, ctx) => {
		if (event.toolName === "subagent") {
			try {
				const args = (event.args || {}) as Record<string, any>;

				// Skip management actions (status, wait, cancel, steer, diff, apply, discard) and dry-run plan
				if (args.action) return;

				const inst = getLedger();
				if (!inst) return;

				const toolCallId = event.toolCallId;
				const now = Date.now();
				const jobId = `job_${now}_${Math.random().toString(36).slice(2, 8)}`;
				const isAsync = Boolean(args.async);
				const runId = args.id || jobId;

				const parentSessionFile = ctx.sessionManager?.getSessionFile?.() || null;
				const parentSessionId = ctx.sessionManager?.getSessionId?.() || null;
				const worktreeCwd = args.cwd || ctx.cwd;

				inst.recordJobAdmission({
					jobId,
					runId,
					toolCallId,
					parentSessionFile,
					parentSessionId,
					worktreeCwd,
					spec: args,
					isAsync,
				});

				activeToolCalls.set(toolCallId, {
					toolCallId,
					jobId,
					args,
					parentSessionFile,
					parentSessionId,
					worktreeCwd,
					isAsync,
				});
			} catch (err) {
				console.error("[durable-subagent-recovery] tool_execution_start error:", err);
			}
		}
	});

	// Capture tool_call to confirm transition to running
	pi.on("tool_call", (event, _ctx) => {
		if (event.toolName === "subagent") {
			try {
				const entry = activeToolCalls.get(event.toolCallId);
				if (entry) {
					const inst = getLedger();
					if (inst) {
						inst.updateJobExecution({
							jobId: entry.jobId,
							state: "running",
						});
					}
				}
			} catch (err) {
				console.error("[durable-subagent-recovery] tool_call error:", err);
			}
		}
	});

	// Track progress & capture child session path
	pi.on("tool_execution_update", (event, _ctx) => {
		if (event.toolName === "subagent" && event.partialResult?.details) {
			try {
				const inst = getLedger();
				if (!inst) return;

				const entry = activeToolCalls.get(event.toolCallId);
				const details = event.partialResult.details as any;
				const results = details.results || (details.state ? [details] : []);

				for (const res of results) {
					if (res.sessionId) {
						const job = entry ? inst.getJob(entry.jobId) : inst.findJobByToolCallId(event.toolCallId);
						if (job) {
							const liveSessionPath = resolveSessionFilePath(inst.config.vendorSessionsDir, res.sessionId);
							let preservedPath: string | undefined;
							if (liveSessionPath) {
								preservedPath = preserveSessionFile(liveSessionPath, inst.config.sessionsDir) ?? undefined;
							}

							inst.updateJobExecution({
								jobId: job.job_id,
								pid: res.process?.pid,
								childSessionId: res.sessionId,
								childSessionPath: liveSessionPath,
								preservedSessionPath: preservedPath,
								turn: res.usage?.turns,
								checkpointText: res.liveText?.slice(0, 300),
							});
						}
					}
				}
			} catch (err) {
				console.error("[durable-subagent-recovery] tool_execution_update error:", err);
			}
		}
	});

	// Track completion vs async launch receipt (Gap 2)
	pi.on("tool_execution_end", (event, _ctx) => {
		if (event.toolName === "subagent") {
			try {
				const inst = getLedger();
				if (!inst) return;

				const entry = activeToolCalls.get(event.toolCallId);
				if (!entry) return;

				const text = event.result?.content?.[0]?.type === "text" ? event.result.content[0].text : "";
				// Check for async launch receipt: "Started run <runId>." (UUID, run_*, etc.)
				const launchMatch = text.match(/Started run\s+([0-9a-fA-F-]+|[a-zA-Z0-9_:-]+)/);

				if (launchMatch || entry.isAsync) {
					const nativeRunId = launchMatch ? launchMatch[1] : entry.jobId;
					inst.updateJobRunId(entry.jobId, nativeRunId);
					inst.updateJobExecution({
						jobId: entry.jobId,
						state: "running",
					});

					// Attempt to bind process identity if native lock was already written
					const lockRecord = inst.readVendorRunRecord(nativeRunId);
					if (lockRecord) {
						let preservedPath: string | undefined;
						let livePath: string | undefined;
						if (lockRecord.childSessionId) {
							livePath = resolveSessionFilePath(inst.config.vendorSessionsDir, lockRecord.childSessionId);
							if (livePath) {
								preservedPath = preserveSessionFile(livePath, inst.config.sessionsDir) ?? undefined;
							}
						}
						inst.updateJobExecution({
							jobId: entry.jobId,
							pid: lockRecord.process?.pid,
							childSessionId: lockRecord.childSessionId,
							childSessionPath: livePath,
							preservedSessionPath: preservedPath,
							worktreeCwd: lockRecord.worktreeCwd ?? entry.worktreeCwd,
						});
					}

					activeToolCalls.delete(event.toolCallId);
					return;
				}

				// Synchronous run settled
				const isError = Boolean(event.isError);
				const state = isError ? "failed" : "completed";
				let childSessionPath: string | undefined;
				let preservedSessionPath: string | undefined;
				let childSessionId: string | undefined;
				let pid: number | undefined;

				if (event.result?.details?.results?.[0]) {
					const first = event.result.details.results[0];
					if (first.sessionId) {
						childSessionId = first.sessionId;
						childSessionPath = resolveSessionFilePath(inst.config.vendorSessionsDir, childSessionId);
						if (childSessionPath) {
							preservedSessionPath = preserveSessionFile(childSessionPath, inst.config.sessionsDir) ?? undefined;
						}
					}
					if (first.process?.pid) {
						pid = first.process.pid;
					}
				}

				if (childSessionId || pid || childSessionPath) {
					inst.updateJobExecution({
						jobId: entry.jobId,
						pid,
						childSessionId,
						childSessionPath,
						preservedSessionPath,
					});
				}

				inst.recordJobCompletion({
					jobId: entry.jobId,
					state,
					summary: text.slice(0, 500),
					durationMs: event.durationMs,
				});

				activeToolCalls.delete(event.toolCallId);
			} catch (err) {
				console.error("[durable-subagent-recovery] tool_execution_end error:", err);
			}
		}
	});

	// Track async completions via completion messages (supports both subagent-completion and subagent_completion)
	pi.on("message_end", (event, _ctx) => {
		try {
			const msg = event.message as any;
			if ((msg?.customType === "subagent-completion" || msg?.customType === "subagent_completion") && msg.details?.runs) {
				const inst = getLedger();
				if (!inst) return;

				for (const run of msg.details.runs) {
					// Correlate by native runId (UUID)
					const job = inst.findJobByRunId(run.id);
					if (job && (job.state === "running" || job.state === "queued" || job.state === "resuming")) {
						const state = run.state === "completed" || run.state === "partial" ? "completed" : "failed";

						// Preserve transcript if not already preserved
						if (job.child_session_id && !job.preserved_session_path) {
							const live = resolveSessionFilePath(inst.config.vendorSessionsDir, job.child_session_id);
							if (live) {
								const preserved = preserveSessionFile(live, inst.config.sessionsDir);
								if (preserved) {
									inst.updateJobExecution({ jobId: job.job_id, preservedSessionPath: preserved });
								}
							}
						}

						inst.recordJobCompletion({
							jobId: job.job_id,
							state,
							summary: run.preview,
							durationMs: run.durationMs,
							usage: {
								input: run.tokens,
								cost: run.cost,
							},
						});
					}
				}
			}
		} catch (err) {
			console.error("[durable-subagent-recovery] message_end error:", err);
		}
	});

	// Register /subagent-recover slash command
	pi.registerCommand("subagent-recover", {
		description: "Inspect and safely resume interrupted or crashed subagent jobs",
		handler: async (_argsStr: string, cmdCtx: ExtensionContext) => {
			const inst = getLedger();
			if (!inst) {
				cmdCtx.ui?.notify("Durable ledger is unavailable (database fail-closed).", "error");
				return;
			}
			const jobs = inst.listRecoverableJobs();

			if (jobs.length === 0) {
				cmdCtx.ui?.notify("No recoverable or interrupted subagent jobs found.", "info");
				return;
			}

			const lines: string[] = ["=== Durable Subagent Recovery ==="];
			lines.push(`Found ${jobs.length} recoverable/active job(s):\n`);

			for (const job of jobs) {
				const liveness = job.pid
					? checkProcessLiveness({
							pid: job.pid,
							startTimeTicks: job.start_time_ticks,
							bootId: job.boot_id,
						})
					: { alive: false, reason: "not_found" };

				const sessionPath = job.preserved_session_path || job.child_session_path;
				lines.push(`• Job ID: ${job.job_id} (Run: ${job.run_id})`);
				lines.push(`  State: ${job.state} | Process: ${liveness.alive ? `ALIVE (PID ${job.pid})` : `DEAD (${(liveness as any).reason})`}`);
				lines.push(`  Worktree: ${job.worktree_cwd}`);

				if (job.is_distilled) {
					lines.push(`  ⚠ Child session was distilled to digest. Exact transcript resume unavailable.`);
					if (job.last_checkpoint_text) {
						lines.push(`  Last Checkpoint: "${job.last_checkpoint_text.slice(0, 100)}..."`);
					}
				} else if (sessionPath) {
					lines.push(`  Session File: ${sessionPath}`);
					lines.push(`  Resume Command:`);
					lines.push(`    ${buildResumeCommand(job, sessionPath)}`);
				} else {
					lines.push(`  Session File: (not captured before interruption)`);
				}
				lines.push("");
			}

			if (cmdCtx.ui) {
				cmdCtx.ui.notify(lines.join("\n"), "info");
			} else {
				console.log(lines.join("\n"));
			}
		},
	});

	// Register model-callable tool: subagent_recover
	pi.registerTool({
		name: "subagent_recover",
		description:
			"Inspect, claim, and recover interrupted or crashed subagent jobs. Returns exact session paths and policy-validated resumption specs with required task.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("status"),
				Type.Literal("claim"),
			], { description: "Action: list recoverable jobs, status of a job, or claim lease for resume." }),
			job_id: Type.Optional(Type.String({ description: "Specific job ID for status or claim." })),
			includeCompleted: Type.Optional(Type.Boolean({ description: "Include completed/historical jobs." })),
		}),
		execute: async (_toolCallId, params, _signal, _update, toolCtx) => {
			const inst = getLedger();
			if (!inst) {
				return {
					content: [{ type: "text", text: "Error: Durable ledger is unavailable (database fail-closed)." }],
					details: { error: "ledger_unavailable" },
				};
			}
			const action = params.action;

			if (action === "list") {
				const jobs = params.includeCompleted ? inst.listAllJobs(20) : inst.listRecoverableJobs();
				const formatted = jobs.map((j) => {
					const liveness = j.pid
						? checkProcessLiveness({ pid: j.pid, startTimeTicks: j.start_time_ticks, bootId: j.boot_id })
						: { alive: false, reason: "not_found" };
					const sessionPath = j.preserved_session_path || j.child_session_path;
					return {
						job_id: j.job_id,
						run_id: j.run_id,
						state: j.state,
						alive: liveness.alive,
						worktree_cwd: j.worktree_cwd,
						child_session_path: sessionPath,
						is_distilled: Boolean(j.is_distilled),
						resume_command: sessionPath && !j.is_distilled ? buildResumeCommand(j, sessionPath) : undefined,
						resume_spec: sessionPath && !j.is_distilled ? buildResumeSpec(j, sessionPath) : undefined,
					};
				});

				return {
					content: [{ type: "text", text: JSON.stringify({ count: formatted.length, jobs: formatted }, null, 2) }],
					details: { count: formatted.length, jobs: formatted },
				};
			}

			if (action === "status") {
				if (!params.job_id) {
					return {
						content: [{ type: "text", text: "Error: job_id is required for action:'status'" }],
						details: { error: "missing_job_id" },
					};
				}
				const job = inst.getJob(params.job_id);
				if (!job) {
					return {
						content: [{ type: "text", text: `Error: Job ${params.job_id} not found.` }],
						details: { error: "not_found" },
					};
				}
				const liveness = job.pid
					? checkProcessLiveness({ pid: job.pid, startTimeTicks: job.start_time_ticks, bootId: job.boot_id })
					: { alive: false, reason: "not_found" };
				const sessionPath = job.preserved_session_path || job.child_session_path;
				return {
					content: [{ type: "text", text: JSON.stringify({
						job,
						liveness,
						resume_command: sessionPath && !job.is_distilled ? buildResumeCommand(job, sessionPath) : undefined,
						resume_spec: sessionPath && !job.is_distilled ? buildResumeSpec(job, sessionPath) : undefined,
					}, null, 2) }],
					details: {
						job,
						liveness,
						resume_command: sessionPath && !job.is_distilled ? buildResumeCommand(job, sessionPath) : undefined,
						resume_spec: sessionPath && !job.is_distilled ? buildResumeSpec(job, sessionPath) : undefined,
					},
				};
			}

			if (action === "claim") {
				if (!params.job_id) {
					return {
						content: [{ type: "text", text: "Error: job_id is required for action:'claim'" }],
						details: { error: "missing_job_id" },
					};
				}
				const owner = `session_${toolCtx.cwd}_${process.pid}`;
				const claim = inst.claimResumeLease(params.job_id, owner);
				if (!claim.ok) {
					return {
						content: [{ type: "text", text: JSON.stringify(claim, null, 2) }],
						details: claim,
					};
				}
				const sessionPath = claim.job.preserved_session_path || claim.job.child_session_path || "";
				const resume_command = sessionPath && !claim.job.is_distilled ? buildResumeCommand(claim.job, sessionPath) : undefined;
				const resume_spec = sessionPath && !claim.job.is_distilled ? buildResumeSpec(claim.job, sessionPath) : undefined;
				return {
					content: [{ type: "text", text: JSON.stringify({ ...claim, resume_command, resume_spec }, null, 2) }],
					details: { ...claim, resume_command, resume_spec },
				};
			}

			return {
				content: [{ type: "text", text: "Unknown action" }],
				details: { error: "unknown_action" },
			};
		},
	});
}
