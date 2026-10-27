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

  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  
  // Ensure schema v2
  const verRow = db.prepare("PRAGMA user_version").get();
  const curVer = verRow ? Number(verRow.user_version) : 0;
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

# 3. Deploy extension atomically with deployment-hash manifest
mkdir -p "$agent_dir/extensions"
chmod 0700 "$agent_dir/extensions" 2>/dev/null || true

src_ext="$repo_root/extensions/durable-subagent-recovery.ts"
dest_ext="$agent_dir/extensions/durable-subagent-recovery.ts"
manifest_file="$durable_dir/deployment-manifest.json"

calc_sha256() {
  if [[ -f "$1" ]]; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo ""
  fi
}

if [[ -f "$src_ext" && "$repo_root" != "$agent_dir" ]]; then
  src_sha=$(calc_sha256 "$src_ext")
  dest_sha=$(calc_sha256 "$dest_ext")
  settings_sha=$(calc_sha256 "$agent_dir/settings.json")
  auth_sha=$(calc_sha256 "$agent_dir/auth.json")
  models_sha=$(calc_sha256 "$agent_dir/models.json")
  backup_file=""
  backup_sha=""
  backup_mode=""

  # Reject symlinks at destination to prevent hijacking
  if [[ -L "$dest_ext" ]]; then
    echo "! Error: Destination $dest_ext is a symlink. Refusing to overwrite symlink directly." >&2
    exit 1
  fi

  if [[ -n "$dest_sha" && "$dest_sha" == "$src_sha" ]]; then
    echo "✓ Extension already deployed and identical (SHA256: ${src_sha:0:12}…)"
    # Retain existing verified preimage across same-version reinstall
    if [[ -f "$manifest_file" ]]; then
      eval "$(node -e '
        const fs = require("node:fs");
        try {
          const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          console.log("backup_file=\"" + (m.backupPath || "") + "\"");
          console.log("backup_sha=\"" + (m.backupSha256 || "") + "\"");
          console.log("backup_mode=\"" + (m.backupMode || "") + "\"");
        } catch {}
      ' "$manifest_file")"
    fi
  else
    if [[ -n "$dest_sha" ]]; then
      # Capture existing destination mode
      dest_mode=$(stat -c "%a" "$dest_ext" 2>/dev/null || stat -f "%Lp" "$dest_ext" 2>/dev/null || echo "600")
      # Backup existing destination atomically preserving mode
      backup_file="$durable_dir/durable-subagent-recovery.ts.bak.$(date +%s)"
      cp "$dest_ext" "${backup_file}.tmp.$$"
      chmod "$dest_mode" "${backup_file}.tmp.$$"
      mv -f "${backup_file}.tmp.$$" "$backup_file"
      backup_sha="$dest_sha"
      backup_mode="$dest_mode"
      echo "✓ Backed up existing extension to: $backup_file (SHA256: ${backup_sha:0:12}…, mode: $backup_mode)"
    fi

    # Atomic copy: write to temp file in destination directory, verify hash, atomic rename
    tmp_dest="${dest_ext}.tmp.$$"
    cp "$src_ext" "$tmp_dest"
    chmod 0600 "$tmp_dest"
    tmp_sha=$(calc_sha256 "$tmp_dest")
    if [[ "$tmp_sha" != "$src_sha" ]]; then
      rm -f "$tmp_dest"
      echo "! Error: SHA256 mismatch during deployment staging" >&2
      exit 1
    fi
    mv -f "$tmp_dest" "$dest_ext"
    echo "✓ Atomically deployed extensions/durable-subagent-recovery.ts (SHA256: ${src_sha:0:12}…)"
  fi

  # Record deployment manifest atomically
  node -e '
  const fs = require("node:fs");
  const manifest = {
    deployedAt: Date.now(),
    sourceSha256: process.argv[1],
    installedSha256: process.argv[2],
    backupPath: process.argv[3] || null,
    backupSha256: process.argv[4] || null,
    backupMode: process.argv[5] || null,
    settingsSha256: process.argv[6] || null,
    authSha256: process.argv[7] || null,
    modelsSha256: process.argv[8] || null,
  };
  const path = process.argv[9];
  const tmp = path + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, path);
  ' "$src_sha" "$src_sha" "$backup_file" "$backup_sha" "$backup_mode" "$settings_sha" "$auth_sha" "$models_sha" "$manifest_file"
fi

echo "All durable subagent recovery preferences verified."
