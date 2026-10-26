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

# 1. Ensure private directory permissions (chmod 0700)
mkdir -p "$durable_dir/sessions"
chmod 0700 "$durable_dir"
chmod 0700 "$durable_dir/sessions"
echo "✓ Secure directory verified: $durable_dir (0700)"

# 2. Verify node:sqlite support & database initialization
node -e '
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const durableDir = process.env.PI_DURABLE_DIR || path.join(process.env.HOME, ".pi", "durable");
const dbPath = path.join(durableDir, "subagents.sqlite");

try {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  
  // Ensure schema v1
  const verRow = db.prepare("PRAGMA user_version").get();
  if (!verRow || verRow.user_version < 1) {
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
  
  const check = db.prepare("PRAGMA quick_check").get();
  if (check && check.quick_check !== "ok") {
    throw new Error("Integrity check failed: " + JSON.stringify(check));
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

# 3. Deploy extension to agent extensions directory
mkdir -p "$agent_dir/extensions"
src_ext="$repo_root/extensions/durable-subagent-recovery.ts"
dest_ext="$agent_dir/extensions/durable-subagent-recovery.ts"

if [[ -f "$src_ext" && "$repo_root" != "$agent_dir" ]]; then
  # Create a hash-safe backup before copy if target exists and differs
  if [[ -f "$dest_ext" ]]; then
    src_sha=$(sha256sum "$src_ext" | cut -d' ' -f1)
    dest_sha=$(sha256sum "$dest_ext" | cut -d' ' -f1)
    if [[ "$src_sha" != "$dest_sha" ]]; then
      backup_file="$durable_dir/durable-subagent-recovery.ts.bak.$(date +%s)"
      cp "$dest_ext" "$backup_file"
      echo "✓ Backed up existing extension to: $backup_file"
    fi
  fi
  cp "$src_ext" "$dest_ext"
  echo "✓ Deployed extensions/durable-subagent-recovery.ts"
fi

echo "All durable subagent recovery preferences verified."
