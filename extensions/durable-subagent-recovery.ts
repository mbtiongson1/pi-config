import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DatabaseSync } from "node:sqlite";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
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
	| { alive: false; verified: true; reason: "not_found" | "rebooted" | "pid_reused" }
	| { alive: boolean; verified: false; reason: "permission_denied" | "unverifiable" };

export interface SubagentJobRecord {
	job_id: string;
	run_id: string;
	tool_call_id: string | null;
	parent_session_file: string | null;
	parent_session_id: string | null;
	worktree_cwd: string;
	spec_json: string;
	state: "queued" | "running" | "completed" | "failed" | "interrupted" | "timed_out" | "orphaned_dead" | "resuming" | "superseded";
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
	// Execution constraints & matrix support (Defects 1 & 5)
	backend: string | null;
	profile: string | null;
	model: string | null;
	thinking: string | null;
	tools_json: string | null;
	agent: string | null;
	resumable: number; // 0 or 1
	unresumable_reason: string | null;
	// Lineage and takeover reservation (Defect 2)
	takeover_reservation_id: string | null;
	superseded_by_job_id: string | null;
	resumed_from_job_id: string | null;
}

export interface LedgerConfig {
	durableDir: string;
	dbPath: string;
	sessionsDir: string;
	vendorLocksDir: string;
	vendorSessionsDir: string;
	retentionDays: number;
	// Native vendor lock records are never mutated; their running state protects busy sessions/worktrees.
}

export interface ResumeSpec {
	task: string;
	resume: string;
	cwd: string;
	backend?: string;
	profile?: "explore" | "review" | "general";
	model?: string;
	thinking?: string;
	tools?: string[];
	agent?: string;
	system_prompt?: string;
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
	hostname?: string | null;
}): ProcessLiveness {
	const pid = identity.pid;
	if (!pid || pid <= 0) return { alive: false, verified: false, reason: "unverifiable" };

	if (identity.hostname && identity.hostname !== hostname()) {
		return { alive: true, verified: false, reason: "unverifiable" };
	}
	// Birth identity is mandatory: a PID alone (including a legacy row) is never death proof.
	if (!identity.startTimeTicks || identity.startTimeTicks <= 0 || !identity.bootId) {
		return { alive: true, verified: false, reason: "unverifiable" };
	}

	// A missing current boot ID is not evidence of reboot or process death.
	const currentBootId = getSystemBootId();
	if (!currentBootId) return { alive: true, verified: false, reason: "unverifiable" };
	if (currentBootId !== identity.bootId) return { alive: false, verified: true, reason: "rebooted" };

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

		if (!Number.isFinite(currentTicks) || currentTicks <= 0) {
			return { alive: true, verified: false, reason: "unverifiable" };
		}
		if (currentTicks === identity.startTimeTicks) return { alive: true, verified: true };
		// PID exists, but birth ticks differ; the recorded process is dead, foreign PID is not ours.
		return { alive: false, verified: true, reason: "pid_reused" };
	} catch (err: any) {
		if (err?.code === "ENOENT") {
			return { alive: false, verified: true, reason: "not_found" };
		}
		if (err?.code === "EACCES" || err?.code === "EPERM") {
			return { alive: true, verified: false, reason: "permission_denied" };
		}
		return { alive: true, verified: false, reason: "unverifiable" };
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

					// Keep native state unchanged so native maintenance still treats the session
					// and worktree as busy. The observer never claims process survival.
					count++;
				}
			} catch {}
		}
	} catch {}
	return { protectedCount: count, preservedCount };
}

// ============================================================================
// Resume Command Spec Generation (Policy Validated & Matrix Checked)
// ============================================================================

export function buildResumeSpec(job: SubagentJobRecord, preservedSessionPath: string): ResumeSpec {
	if (job.resumable === 0) {
		throw new Error(`Job ${job.job_id} is not resumable: ${job.unresumable_reason || "unsupported configuration"}`);
	}

	let spec: any = {};
	try {
		spec = JSON.parse(job.spec_json || "{}");
	} catch {}

	// matrix: backend MUST be "pi"
	const backend = job.backend || spec.backend || "pi";
	if (backend !== "pi") {
		throw new Error(`Job ${job.job_id} uses unsupported backend '${backend}': only 'pi' session transcripts can be resumed`);
	}

	// matrix: worktree cwd MUST exist and NOT be a symlink
	if (!job.worktree_cwd || !existsSync(job.worktree_cwd)) {
		throw new Error(`Cannot resume job ${job.job_id}: worktree directory does not exist (${job.worktree_cwd})`);
	}
	try {
		if (lstatSync(job.worktree_cwd).isSymbolicLink()) {
			throw new Error(`Cannot resume job ${job.job_id}: worktree directory is a symlink (${job.worktree_cwd})`);
		}
	} catch (e: any) {
		throw new Error(`Cannot resume job ${job.job_id}: invalid worktree directory: ${e?.message || String(e)}`);
	}

	// profile check: must not widen! Old rows missing proof fail closed!
	const profile = job.profile || spec.profile;
	if (!profile) {
		throw new Error(
			`Cannot safely resume job ${job.job_id}: missing proof of execution profile in job record. Silent widening to 'general' is prohibited to prevent privilege escalation. Manual verification required.`,
		);
	}

	let originalTask = "Resume interrupted task";
	if (spec.task && typeof spec.task === "string" && spec.task.trim()) {
		originalTask = spec.task.trim();
	}

	const tools = job.tools_json
		? JSON.parse(job.tools_json)
		: Array.isArray(spec.tools) ? spec.tools : undefined;
	const model = job.model || spec.model || undefined;
	const thinking = job.thinking || spec.thinking || undefined;
	const agent = job.agent || spec.agent || undefined;
	const systemPrompt = spec.system_prompt || undefined;

	const resumeSpec: ResumeSpec = {
		task: `Resume: ${originalTask}`,
		resume: preservedSessionPath,
		cwd: job.worktree_cwd,
		backend: "pi",
		profile: profile as any,
	};

	if (tools && tools.length > 0) resumeSpec.tools = tools;
	if (model) resumeSpec.model = model;
	if (thinking) resumeSpec.thinking = thinking;
	if (agent) resumeSpec.agent = agent;
	if (systemPrompt) resumeSpec.system_prompt = systemPrompt;

	return resumeSpec;
}

export function buildResumeCommand(job: SubagentJobRecord, preservedSessionPath: string): string {
	const spec = buildResumeSpec(job, preservedSessionPath);
	return `subagent(${JSON.stringify(spec, null, 2)})`;
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

		this.config = {
			durableDir,
			dbPath,
			sessionsDir,
			vendorLocksDir,
			vendorSessionsDir,
			retentionDays,
		};

		mkdirSync(this.config.durableDir, { recursive: true, mode: 0o700 });
		mkdirSync(this.config.sessionsDir, { recursive: true, mode: 0o700 });

		this.db = this.initDatabase(this.config.dbPath);
	}

	private initDatabase(dbPath: string): DatabaseSync {
		let db: DatabaseSync;
		try {
			db = new DatabaseSync(dbPath);
			// Check integrity
			const check = db.prepare("PRAGMA quick_check").get() as any;
			if (check && check.quick_check !== "ok") {
				throw new Error(`Corrupt database: ${JSON.stringify(check)}`);
			}
		} catch (err: any) {
			// Fail-closed: preserve original database, WAL, and SHM untouched (P1-3)
			// Never silently wipe active admission or lease state. Automated mutating resets are prohibited.
			throw new DatabaseCorruptError(`Database corruption detected in ${dbPath}: ${err?.message || String(err)}`, dbPath);
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
					usage_cost REAL,
					backend TEXT,
					profile TEXT,
					model TEXT,
					thinking TEXT,
					tools_json TEXT,
					agent TEXT,
					resumable INTEGER NOT NULL DEFAULT 1,
					unresumable_reason TEXT,
					takeover_reservation_id TEXT,
					superseded_by_job_id TEXT,
					resumed_from_job_id TEXT
				);

				CREATE INDEX IF NOT EXISTS idx_jobs_state ON subagent_jobs(state);
				CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON subagent_jobs(run_id);
				CREATE INDEX IF NOT EXISTS idx_jobs_child_session ON subagent_jobs(child_session_id);
				CREATE INDEX IF NOT EXISTS idx_jobs_parent ON subagent_jobs(parent_session_file);
				CREATE INDEX IF NOT EXISTS idx_jobs_updated ON subagent_jobs(updated_at);
				CREATE INDEX IF NOT EXISTS idx_jobs_resumable ON subagent_jobs(resumable);
				CREATE INDEX IF NOT EXISTS idx_jobs_superseded ON subagent_jobs(superseded_by_job_id);
				CREATE INDEX IF NOT EXISTS idx_jobs_resumed_from ON subagent_jobs(resumed_from_job_id);
				PRAGMA user_version = 2;
			`);
		} else if (currentVersion < 2) {
			const columns = [
				"backend TEXT",
				"profile TEXT",
				"model TEXT",
				"thinking TEXT",
				"tools_json TEXT",
				"agent TEXT",
				"resumable INTEGER NOT NULL DEFAULT 1",
				"unresumable_reason TEXT",
				"takeover_reservation_id TEXT",
				"superseded_by_job_id TEXT",
				"resumed_from_job_id TEXT",
			];
			for (const col of columns) {
				try {
					db.exec(`ALTER TABLE subagent_jobs ADD COLUMN ${col};`);
				} catch {}
			}
			db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_resumable ON subagent_jobs(resumable);");
			db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_superseded ON subagent_jobs(superseded_by_job_id);");
			db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_resumed_from ON subagent_jobs(resumed_from_job_id);");
			db.exec("PRAGMA user_version = 2;");
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
		effectiveConstraints?: {
			backend?: string;
			profile?: string;
			model?: string;
			thinking?: string;
			tools?: string[];
			agent?: string;
		};
		resumedFromJobId?: string;
		takeoverReservationId?: string;
	}): SubagentJobRecord {
		const now = Date.now();
		const spec = params.spec || {};
		const specJson = JSON.stringify(spec);

		const backend = params.effectiveConstraints?.backend || spec.backend || "pi";
		const profile = params.effectiveConstraints?.profile || spec.profile || "general";
		const model = params.effectiveConstraints?.model || spec.model || null;
		const thinking = params.effectiveConstraints?.thinking || spec.thinking || null;
		const tools = params.effectiveConstraints?.tools || (Array.isArray(spec.tools) ? spec.tools : null);
		const toolsJson = tools ? JSON.stringify(tools) : null;
		const agent = params.effectiveConstraints?.agent || spec.agent || null;

		let resumable = 1;
		let unresumableReason: string | null = null;

		if (backend !== "pi") {
			resumable = 0;
			unresumableReason = `Unsupported backend '${backend}': durable session transcript recovery is only supported for 'pi' backend`;
		} else if (spec.isolation === "worktree" || params.worktreeCwd.includes("/.pi/subagent-worktrees/")) {
			resumable = 0;
			unresumableReason = "Managed temporary worktree (isolation: 'worktree') is purged on parent restart; uncommitted WIP cannot be restored. Use permanent shared/isolated worktree for durable recovery.";
		} else {
			try {
				if (!existsSync(params.worktreeCwd)) {
					resumable = 0;
					unresumableReason = `Worktree directory does not exist: ${params.worktreeCwd}`;
				} else if (lstatSync(params.worktreeCwd).isSymbolicLink()) {
					resumable = 0;
					unresumableReason = `Worktree cwd is a symlink: ${params.worktreeCwd}; symlink worktrees are not supported`;
				}
			} catch (e: any) {
				resumable = 0;
				unresumableReason = `Worktree cwd validation failed: ${e?.message || String(e)}`;
			}
		}

		const stmt = this.db.prepare(`
			INSERT INTO subagent_jobs (
				job_id, run_id, tool_call_id, parent_session_file, parent_session_id,
				worktree_cwd, spec_json, state, is_async, created_at, updated_at,
				backend, profile, model, thinking, tools_json, agent,
				resumable, unresumable_reason,
				resumed_from_job_id, takeover_reservation_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(job_id) DO UPDATE SET
				run_id = excluded.run_id,
				spec_json = excluded.spec_json,
				updated_at = excluded.updated_at,
				backend = excluded.backend,
				profile = excluded.profile,
				model = excluded.model,
				thinking = excluded.thinking,
				tools_json = excluded.tools_json,
				agent = excluded.agent,
				resumable = excluded.resumable,
				unresumable_reason = excluded.unresumable_reason,
				resumed_from_job_id = excluded.resumed_from_job_id,
				takeover_reservation_id = excluded.takeover_reservation_id
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
			backend,
			profile,
			model,
			thinking,
			toolsJson,
			agent,
			resumable,
			unresumableReason,
			params.resumedFromJobId ?? null,
			params.takeoverReservationId ?? null,
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
		startTimeTicks?: number | null;
		bootId?: string | null;
		turn?: number;
		checkpointText?: string;
		worktreeCwd?: string;
	}): void {
		const now = Date.now();
		// Do not turn a late observation of a PID into birth evidence. Callers must
		// supply identity captured by the launcher/lock record; absent proof stays NULL.
		const bootId = params.bootId ?? null;
		const ticks = params.startTimeTicks ?? null;
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
		let query = "SELECT * FROM subagent_jobs WHERE state IN ('running', 'interrupted', 'timed_out', 'orphaned_dead', 'resuming') AND superseded_by_job_id IS NULL";
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

	public findJobBySessionPath(sessionPath: string): SubagentJobRecord | undefined {
		if (!sessionPath) return undefined;
		const norm = join(sessionPath);
		// Check exact path match
		let row = this.db.prepare(
			"SELECT * FROM subagent_jobs WHERE preserved_session_path = ? OR child_session_path = ?"
		).get(norm, norm) as SubagentJobRecord | undefined;
		if (row) return row;

		// Check filename pattern: recovery-(job_[^.]+)\.jsonl
		const base = basename(norm);
		const match = base.match(/^recovery-(job_[a-zA-Z0-9_-]+)\.jsonl$/);
		if (match) {
			const jobId = match[1];
			row = this.getJob(jobId);
			if (row) return row;
		}

		// Also check suffix match across preserved_session_path or child_session_path
		row = this.db.prepare(
			"SELECT * FROM subagent_jobs WHERE preserved_session_path LIKE ? OR child_session_path LIKE ?"
		).get(`%${base}`, `%${base}`) as SubagentJobRecord | undefined;

		return row;
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

	// ---- Transactional CAS Claim & Takeover Reservation (Gap 4 & P1-1) -------

	public claimResumeLease(
		jobId: string,
		leaseOwner: string,
		leaseDurationMs = 60000,
	): { ok: true; job: SubagentJobRecord; reservationId: string; identityBoundPath: string } | { ok: false; reason: string; supersededBy?: string; job?: SubagentJobRecord } {
		this.db.exec("BEGIN IMMEDIATE;");
		try {
			const row = this.db.prepare("SELECT * FROM subagent_jobs WHERE job_id = ?").get(jobId) as SubagentJobRecord | undefined;
			if (!row) {
				this.db.exec("ROLLBACK;");
				return { ok: false, reason: "job_not_found" };
			}

			// Refuse resume if already superseded by a new resumed job (P1-1 repair: permanently nonclaimable)
			if (row.superseded_by_job_id || row.state === "superseded") {
				this.db.exec("ROLLBACK;");
				return { ok: false, reason: "job_superseded", supersededBy: row.superseded_by_job_id || undefined, job: row };
			}

			// Refuse resume if marked unresumable (matrix support: non-pi backend, managed worktree, missing/symlink cwd)
			if (row.resumable === 0) {
				this.db.exec("ROLLBACK;");
				return { ok: false, reason: "job_not_resumable", job: row };
			}

			// Every claim rechecks the complete birth identity, regardless of ledger state.
			// Missing/legacy PID bindings and unknown liveness are non-claimable.
			const liveness = checkProcessLiveness({
				pid: row.pid,
				startTimeTicks: row.start_time_ticks,
				bootId: row.boot_id,
				hostname: row.hostname,
			});
			if (!liveness.verified) {
				this.db.exec("ROLLBACK;");
				return { ok: false, reason: "process_liveness_unverifiable", job: row };
			}
			if (liveness.alive) {
				this.db.exec("ROLLBACK;");
				return { ok: false, reason: "process_still_running", job: row };
			}

			// Check active lease held by another claimant
			const now = Date.now();
			if (row.resume_lease_expires_at && row.resume_lease_expires_at > now && row.resume_lease_owner !== leaseOwner) {
				this.db.exec("ROLLBACK;");
				return { ok: false, reason: "leased_by_another_process", job: row };
			}

			// Verify session transcript exists before issuing reservation
			let sessionPath = row.preserved_session_path || row.child_session_path;
			if (!sessionPath || !existsSync(sessionPath)) {
				this.db.exec("ROLLBACK;");
				return { ok: false, reason: "session_transcript_missing", job: row };
			}

			// Create identity-bound artifact path tied directly to args.resume
			const identityBoundPath = join(this.config.sessionsDir, `recovery-${jobId}.jsonl`);
			if (sessionPath !== identityBoundPath) {
				try {
					if (existsSync(identityBoundPath)) unlinkSync(identityBoundPath);
					copyFileSync(sessionPath, identityBoundPath);
					chmodSync(identityBoundPath, 0o600);
					sessionPath = identityBoundPath;
				} catch (e: any) {
					this.db.exec("ROLLBACK;");
					return { ok: false, reason: `failed_creating_identity_artifact: ${e?.message || String(e)}`, job: row };
				}
			}

			const reservationId = `resv_${jobId}_${now}_${Math.random().toString(36).slice(2, 8)}`;
			const expiresAt = now + leaseDurationMs;
			this.db
				.prepare(
					`
				UPDATE subagent_jobs
				SET resume_lease_owner = ?,
					resume_lease_expires_at = ?,
					takeover_reservation_id = ?,
					preserved_session_path = ?,
					resume_count = resume_count + 1,
					state = 'resuming',
					updated_at = ?
				WHERE job_id = ?
			`,
				)
				.run(leaseOwner, expiresAt, reservationId, sessionPath, now, jobId);

			this.db.exec("COMMIT;");
			const updated = this.getJob(jobId)!;
			return { ok: true, job: updated, reservationId, identityBoundPath };
		} catch (err: any) {
			try {
				this.db.exec("ROLLBACK;");
			} catch {}
			return { ok: false, reason: `transaction_error: ${err?.message || String(err)}` };
		}
	}

	public bindResumeLineage(params: {
		originalJobId: string;
		newJobId: string;
		expectedOwner?: string;
	}): { ok: true; reservationId: string } | { ok: false; reason: string } {
		this.db.exec("BEGIN IMMEDIATE;");
		try {
			const orig = this.getJob(params.originalJobId);
			if (!orig) {
				this.db.exec("ROLLBACK;");
				return { ok: false, reason: "original_job_not_found" };
			}

			// If already superseded, duplicate takeover is strictly forbidden!
			if (orig.superseded_by_job_id || orig.state === "superseded") {
				this.db.exec("ROLLBACK;");
				return { ok: false, reason: "original_job_already_superseded" };
			}

			// If active running process exists, duplicate takeover is strictly forbidden!
			if (orig.pid && orig.state === "running") {
				const liveness = checkProcessLiveness({
					pid: orig.pid,
					startTimeTicks: orig.start_time_ticks,
					bootId: orig.boot_id,
					hostname: orig.hostname,
				});
				if (liveness.alive) {
					this.db.exec("ROLLBACK;");
					return { ok: false, reason: "original_process_still_running" };
				}
			}

			const now = Date.now();
			const resvId = orig.takeover_reservation_id || `resv_${orig.job_id}_${now}_auto`;

			// Supersede original job: original is permanently nonclaimable
			this.db
				.prepare(
					`
				UPDATE subagent_jobs
				SET state = 'superseded',
					superseded_by_job_id = ?,
					takeover_reservation_id = ?,
					updated_at = ?
				WHERE job_id = ?
			`,
				)
				.run(params.newJobId, resvId, now, orig.job_id);

			this.db.exec("COMMIT;");
			return { ok: true, reservationId: resvId };
		} catch (err: any) {
			try {
				this.db.exec("ROLLBACK;");
			} catch {}
			return { ok: false, reason: `bind_error: ${err?.message || String(err)}` };
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
				takeover_reservation_id = NULL,
				state = CASE WHEN state = 'resuming' AND superseded_by_job_id IS NULL THEN 'interrupted' ELSE state END,
				updated_at = ?
			WHERE job_id = ? AND resume_lease_owner = ? AND superseded_by_job_id IS NULL
		`,
			)
			.run(now, jobId, leaseOwner);
	}

	// ---- Non-Destructive Startup Reconciliation (Gap 1 & 4) -------------------

	public reconcileOnStartup(): {
		aliveWorkers: SubagentJobRecord[];
		unknownWorkers: SubagentJobRecord[];
		orphanedDead: SubagentJobRecord[];
		protectedFromVendor: number;
		preservedTranscripts: number;
	} {
		// 1. Scan vendor locks and preserve all child transcripts before maintenance runs
		const { protectedCount, preservedCount } = protectVendorOrphanRecords(this.config.vendorLocksDir, {
			vendorSessionsDir: this.config.vendorSessionsDir,
			durableSessionsDir: this.config.sessionsDir,
		});

		// 2. Scan our ledger's running/resuming jobs
		const activeJobs = this.db
			.prepare("SELECT * FROM subagent_jobs WHERE state IN ('running', 'resuming')")
			.all() as SubagentJobRecord[];

		const aliveWorkers: SubagentJobRecord[] = [];
		const unknownWorkers: SubagentJobRecord[] = [];
		const orphanedDead: SubagentJobRecord[] = [];
		const now = Date.now();

		for (const job of activeJobs) {
			if (job.state === "resuming") {
				if (!job.superseded_by_job_id) {
					// A pending launch has an ambiguous side-effect boundary. Preserve it as
					// unknown and never release its reservation merely because the parent died.
					const pendingLiveness = checkProcessLiveness({ pid: job.pid, startTimeTicks: job.start_time_ticks, bootId: job.boot_id, hostname: job.hostname });
					if (!pendingLiveness.verified) {
						unknownWorkers.push(job);
						continue;
					}
					if (pendingLiveness.alive) {
						aliveWorkers.push(job);
						continue;
					}
					// Verified death permits a future explicit recovery; it does not imply task success.
					this.db
						.prepare(
							`
						UPDATE subagent_jobs
						SET state = 'interrupted',
							resume_lease_owner = NULL,
							resume_lease_expires_at = NULL,
							takeover_reservation_id = NULL,
							updated_at = ?
						WHERE job_id = ?
					`,
						)
						.run(now, job.job_id);
					job.state = "interrupted";
					orphanedDead.push(job);
					continue;
				}
			}

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
			if (job.run_id) {
				const lockRec = this.readVendorRunRecord(job.run_id);
				if (lockRec?.process?.pid) {
					pid = pid ?? lockRec.process.pid;
					ticks = ticks ?? lockRec.process.startTime ?? null;
					bootId = bootId ?? lockRec.process.bootId ?? null;
					this.updateJobExecution({
						jobId: job.job_id,
						pid,
						startTimeTicks: ticks,
						bootId,
						childSessionId: lockRec.childSessionId ?? job.child_session_id ?? undefined,
						worktreeCwd: lockRec.worktreeCwd ?? job.worktree_cwd,
					});
				}
			}

			if (!pid) {
				// Missing launch identity is ambiguous (launch may have occurred); preserve state.
				unknownWorkers.push(job);
				continue;
			}

			const liveness = checkProcessLiveness({
				pid,
				startTimeTicks: ticks,
				bootId,
				hostname: job.hostname,
			});

			if (!liveness.verified) {
				unknownWorkers.push(job);
			} else if (liveness.alive) {
				aliveWorkers.push(job);
			} else {
				// Only verified death permits interruption; never infer successful completion.
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
			unknownWorkers,
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
	// Native package extensions are registered before user extensions and run their
	// session_start maintenance first. Take a read-only transcript snapshot during
	// factory registration (before any session_start handler can terminalize/prune
	// native records); do not launch resources or claim detached-worker survival here.
	try {
		const home = homedir();
		const durableDir = process.env.PI_DURABLE_DIR ?? join(home, ".pi", "durable");
		const vendorLocksDir = process.env.PI_SUBAGENT_LOCK_DIR ?? join(home, ".pi", "subagent-locks");
		const vendorSessionsDir = process.env.PI_SUBAGENT_SESSION_DIR ?? join(home, ".pi", "subagent-sessions");
		protectVendorOrphanRecords(vendorLocksDir, {
			vendorSessionsDir,
			durableSessionsDir: join(durableDir, "sessions"),
		});
	} catch (err) {
		console.error("[durable-subagent-recovery] Early transcript preservation failed:", err);
	}

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

				let resumedFromJobId: string | undefined;
				let takeoverReservationId: string | undefined;

				// Correlate args.resume with existing job and bind lineage (P1-1 repair)
				if (args.resume && typeof args.resume === "string") {
					const origJob = inst.findJobBySessionPath(args.resume);
					if (origJob) {
						const bindRes = inst.bindResumeLineage({
							originalJobId: origJob.job_id,
							newJobId: jobId,
						});
						if (bindRes.ok) {
							resumedFromJobId = origJob.job_id;
							takeoverReservationId = bindRes.reservationId;
						} else {
							console.warn(`[durable-subagent-recovery] Lineage binding note: ${bindRes.reason}`);
						}
					}
				}

				const effectiveConstraints = {
					backend: args.backend || "pi",
					profile: args.profile || "general",
					model: args.model || (ctx.model?.provider ? `${ctx.model.provider}/${ctx.model.id}` : ctx.model?.id) || undefined,
					thinking: args.thinking || ctx.thinkingLevel || undefined,
					tools: Array.isArray(args.tools) ? args.tools : undefined,
					agent: args.agent || undefined,
				};

				inst.recordJobAdmission({
					jobId,
					runId,
					toolCallId,
					parentSessionFile,
					parentSessionId,
					worktreeCwd,
					spec: args,
					isAsync,
					effectiveConstraints,
					resumedFromJobId,
					takeoverReservationId,
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
							startTimeTicks: lockRecord.process?.startTime ?? null,
							bootId: lockRecord.process?.bootId ?? null,
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
				} else if (job.resumable === 0) {
					lines.push(`  ⚠ Unresumable: ${job.unresumable_reason}`);
				} else if (sessionPath) {
					lines.push(`  Session File: ${sessionPath}`);
					lines.push(`  Profile: ${job.profile || "unknown"} | Route: ${job.model || "inherited"}`);
					try {
						const cmd = buildResumeCommand(job, sessionPath);
						lines.push(`  Resume Command:`);
						lines.push(`    ${cmd}`);
					} catch (e: any) {
						lines.push(`  ⚠ Resume spec error: ${e?.message || String(e)}`);
					}
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
						? checkProcessLiveness({ pid: j.pid, startTimeTicks: j.start_time_ticks, bootId: j.boot_id, hostname: j.hostname })
						: { alive: false, reason: "not_found" };
					const sessionPath = j.preserved_session_path || j.child_session_path;
					let resumeCommand: string | undefined;
					let resumeSpec: ResumeSpec | undefined;
					let canBeResumed = Boolean(j.resumable !== 0 && sessionPath && !j.is_distilled);
					let reasonUnresumable = j.unresumable_reason;

					if (canBeResumed && sessionPath) {
						try {
							resumeSpec = buildResumeSpec(j, sessionPath);
							resumeCommand = buildResumeCommand(j, sessionPath);
						} catch (e: any) {
							canBeResumed = false;
							reasonUnresumable = e?.message || String(e);
						}
					}

					return {
						job_id: j.job_id,
						run_id: j.run_id,
						state: j.state,
						alive: liveness.alive,
						worktree_cwd: j.worktree_cwd,
						child_session_path: sessionPath,
						is_distilled: Boolean(j.is_distilled),
						profile: j.profile,
						backend: j.backend,
						model: j.model,
						resumable: canBeResumed,
						unresumable_reason: reasonUnresumable,
						resume_command: resumeCommand,
						resume_spec: resumeSpec,
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
					? checkProcessLiveness({ pid: job.pid, startTimeTicks: job.start_time_ticks, bootId: job.boot_id, hostname: job.hostname })
					: { alive: false, reason: "not_found" };
				const sessionPath = job.preserved_session_path || job.child_session_path;
				let resumeCommand: string | undefined;
				let resumeSpec: ResumeSpec | undefined;
				let canBeResumed = Boolean(job.resumable !== 0 && sessionPath && !job.is_distilled);
				let reasonUnresumable = job.unresumable_reason;

				if (canBeResumed && sessionPath) {
					try {
						resumeSpec = buildResumeSpec(job, sessionPath);
						resumeCommand = buildResumeCommand(job, sessionPath);
					} catch (e: any) {
						canBeResumed = false;
						reasonUnresumable = e?.message || String(e);
					}
				}

				return {
					content: [{ type: "text", text: JSON.stringify({
						job,
						liveness,
						resumable: canBeResumed,
						unresumable_reason: reasonUnresumable,
						resume_command: resumeCommand,
						resume_spec: resumeSpec,
					}, null, 2) }],
					details: {
						job,
						liveness,
						resumable: canBeResumed,
						unresumable_reason: reasonUnresumable,
						resume_command: resumeCommand,
						resume_spec: resumeSpec,
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
				let resume_command: string | undefined;
				let resume_spec: ResumeSpec | undefined;
				try {
					resume_spec = buildResumeSpec(claim.job, sessionPath);
					resume_command = buildResumeCommand(claim.job, sessionPath);
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `Error generating resume spec: ${e?.message || String(e)}` }],
						details: { ok: false, error: e?.message || String(e) },
					};
				}
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
