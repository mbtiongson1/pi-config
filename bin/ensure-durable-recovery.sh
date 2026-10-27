#!/usr/bin/env bash
# Ensure Pi Durable Subagent Recovery ledger, directories, permissions, and extensions.
# Called by pi-config Update, Reinstall, Sync, and ensure-subagent-config.sh to guarantee
# persistent crash-resilient subagent recovery across upgrades without breaking live workers.
set -euo pipefail

agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
durable_dir="${PI_DURABLE_DIR:-$HOME/.pi/durable}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

echo "=== Pi Durable Subagent Recovery Reliability Check ==="

# Do not follow a user-supplied/private-state symlink while installing.
for path in "$durable_dir" "$durable_dir/sessions" "$agent_dir" "$agent_dir/extensions"; do
  if [[ -L "$path" ]]; then echo "! Refusing symlink namespace: $path" >&2; exit 1; fi
done

# Validate deployment state and database aliases BEFORE opening SQLite.
python3 "$script_dir/durable-recovery-deploy.py" preflight --agent-dir "$agent_dir" --durable-dir "$durable_dir"

# 1. Ensure private directory permissions (chmod 0700)
mkdir -p "$durable_dir/sessions"
chmod 0700 "$durable_dir"
chmod 0700 "$durable_dir/sessions"
echo "✓ Secure directory verified: $durable_dir (0700)"

# 2. Verify node:sqlite support & database initialization (Fail-Closed)
node -e '
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const durableDir = process.env.PI_DURABLE_DIR || path.join(process.env.HOME, ".pi", "durable");
const dbPath = path.join(durableDir, "subagents.sqlite");

try {
  let db;
  try {
    db = new DatabaseSync(dbPath);
    const check = db.prepare("PRAGMA quick_check").get();
    if (check && check.quick_check !== "ok") {
      throw new Error("PRAGMA quick_check returned: " + JSON.stringify(check));
    }
  } catch (openErr) {
    console.error("! Fail-Closed: SQLite database at " + dbPath + " failed integrity check.");
    console.error("! Preserving existing database, WAL, and SHM untouched to prevent silent state loss.");
    console.error("! Error details: " + openErr.message);
    process.exit(1);
  }

  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  
  // Ensure schema v3
  const verRow = db.prepare("PRAGMA user_version").get();
  const curVer = verRow ? Number(verRow.user_version) : 0;
  if (!Number.isInteger(curVer) || curVer < 0 || curVer > 3) throw new Error("Unsupported durable recovery schema version: " + curVer);
  if (curVer < 1) {
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
        resumed_from_job_id TEXT,
        reservation_artifact_path TEXT,
        reservation_owner_pid INTEGER,
        reservation_owner_ticks INTEGER,
        reservation_owner_boot_id TEXT,
        reservation_owner_hostname TEXT,
        reservation_owner_session_id TEXT,
        reservation_owner_session_file TEXT,
        reservation_owner_cwd TEXT,
        reservation_consumed_by_job_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_state ON subagent_jobs(state);
      CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON subagent_jobs(run_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_child_session ON subagent_jobs(child_session_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_parent ON subagent_jobs(parent_session_file);
      CREATE INDEX IF NOT EXISTS idx_jobs_updated ON subagent_jobs(updated_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_resumable ON subagent_jobs(resumable);
      CREATE INDEX IF NOT EXISTS idx_jobs_superseded ON subagent_jobs(superseded_by_job_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_resumed_from ON subagent_jobs(resumed_from_job_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_reservation_path ON subagent_jobs(reservation_artifact_path);
      PRAGMA user_version = 3;
    `);
  } else if (curVer < 2) {
    const cols = [
      "backend TEXT", "profile TEXT", "model TEXT", "thinking TEXT", "tools_json TEXT", "agent TEXT",
      "resumable INTEGER NOT NULL DEFAULT 1", "unresumable_reason TEXT",
      "takeover_reservation_id TEXT", "superseded_by_job_id TEXT", "resumed_from_job_id TEXT"
    ];
    for (const c of cols) {
      try { db.exec("ALTER TABLE subagent_jobs ADD COLUMN " + c + ";"); } catch {}
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_resumable ON subagent_jobs(resumable);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_superseded ON subagent_jobs(superseded_by_job_id);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_resumed_from ON subagent_jobs(resumed_from_job_id);");
    db.exec("PRAGMA user_version = 2;");
  }
  if (curVer < 3) {
    const cols = [
      "reservation_artifact_path TEXT", "reservation_owner_pid INTEGER", "reservation_owner_ticks INTEGER",
      "reservation_owner_boot_id TEXT", "reservation_owner_hostname TEXT", "reservation_owner_session_id TEXT",
      "reservation_owner_session_file TEXT", "reservation_owner_cwd TEXT", "reservation_consumed_by_job_id TEXT"
    ];
    for (const c of cols) {
      try { db.exec("ALTER TABLE subagent_jobs ADD COLUMN " + c + ";"); } catch {}
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_reservation_path ON subagent_jobs(reservation_artifact_path);");
    db.exec("PRAGMA user_version = 3;");
  }
  
  db.close();
  // Secure database permissions (chmod 0600)
  fs.chmodSync(dbPath, 0o600);
  const wal = dbPath + "-wal";
  const shm = dbPath + "-shm";
  if (fs.existsSync(wal)) fs.chmodSync(wal, 0o600);
  if (fs.existsSync(shm)) fs.chmodSync(shm, 0o600);
  console.log("✓ SQLite WAL ledger verified & secured: " + dbPath + " (0600)");
} catch (err) {
  console.error("! Database error:", err.message);
  process.exit(1);
}
'

# 3. Journaled extension deployment, preserving the original first-install state.
python3 "$script_dir/durable-recovery-deploy.py" install \
  --agent-dir "$agent_dir" --durable-dir "$durable_dir" \
  --source "$repo_root/extensions/durable-subagent-recovery.ts"

echo "All durable subagent recovery preferences verified."
