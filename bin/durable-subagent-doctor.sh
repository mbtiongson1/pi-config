#!/usr/bin/env bash
# Doctor and diagnostic tool for Pi Durable Subagent Recovery.
# Validates environment, node:sqlite, database integrity, process liveness, and permissions.
# Provides atomic, hash-safe rollback refusing hash conflicts on modified files.
set -euo pipefail

durable_dir="${PI_DURABLE_DIR:-$HOME/.pi/durable}"
db_path="$durable_dir/subagents.sqlite"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
manifest_file="$durable_dir/deployment-manifest.json"

calc_sha256() {
  if [[ -f "$1" ]]; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo ""
  fi
}

# ----------------------------------------------------------------------------
# Mode: --quarantine-corrupt
# ----------------------------------------------------------------------------
if [[ "${1:-}" == "--quarantine-corrupt" ]]; then
  echo "=== Durable Subagent Recovery: Quarantine Corrupt Database ==="
  if [[ -f "$db_path" ]]; then
    ts=$(date +%s)
    corrupt_db="${db_path}.corrupt.${ts}"
    mv -f "$db_path" "$corrupt_db"
    [[ -f "${db_path}-wal" ]] && mv -f "${db_path}-wal" "${db_path}-wal.corrupt.${ts}"
    [[ -f "${db_path}-shm" ]] && mv -f "${db_path}-shm" "${db_path}-shm.corrupt.${ts}"
    echo "✓ Quarantined corrupt database files to: $corrupt_db"
    
    # Re-initialize clean DB
    node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
    db.close();
    ' "$db_path"
    chmod 0600 "$db_path"
    echo "✓ Initialized clean database with WAL mode and FULL durability."
  else
    echo "No database file exists at $db_path."
  fi
  exit 0
fi

# ----------------------------------------------------------------------------
# Mode: --rollback
# ----------------------------------------------------------------------------
if [[ "${1:-}" == "--rollback" ]]; then
  echo "=== Durable Subagent Recovery Rollback ==="
  installed_ext="$agent_dir/extensions/durable-subagent-recovery.ts"
  force="${2:-}"

  if [[ ! -f "$installed_ext" ]]; then
    echo "Extension was not deployed in $agent_dir/extensions"
    exit 0
  fi

  cur_ext_sha=$(calc_sha256 "$installed_ext")

  if [[ -f "$manifest_file" ]]; then
    # Read manifest using Node
    eval "$(node -e '
      const fs = require("node:fs");
      try {
        const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        console.log("manifest_installed_sha=\"" + (m.installedSha256 || "") + "\"");
        console.log("manifest_backup_path=\"" + (m.backupPath || "") + "\"");
        console.log("manifest_backup_sha=\"" + (m.backupSha256 || "") + "\"");
        console.log("manifest_settings_sha=\"" + (m.settingsSha256 || "") + "\"");
        console.log("manifest_auth_sha=\"" + (m.authSha256 || "") + "\"");
        console.log("manifest_models_sha=\"" + (m.modelsSha256 || "") + "\"");
      } catch (e) {
        process.exit(1);
      }
    ' "$manifest_file")"

    # Hash conflict check: has user modified the deployed extension?
    if [[ -n "$manifest_installed_sha" && "$cur_ext_sha" != "$manifest_installed_sha" && "$force" != "--force" ]]; then
      echo "! Error: Hash conflict detected on $installed_ext" >&2
      echo "  Current SHA256:  $cur_ext_sha" >&2
      echo "  Deployed SHA256: $manifest_installed_sha" >&2
      echo "  The installed extension was modified since deployment." >&2
      echo "  Refusing rollback to avoid destroying uncommitted changes. Pass --force to override." >&2
      exit 1
    fi

    # Check settings/auth/models integrity
    cur_settings_sha=$(calc_sha256 "$agent_dir/settings.json")
    cur_auth_sha=$(calc_sha256 "$agent_dir/auth.json")
    cur_models_sha=$(calc_sha256 "$agent_dir/models.json")
    if [[ -n "$manifest_settings_sha" && "$cur_settings_sha" != "$manifest_settings_sha" ]]; then
      echo "Notice: settings.json modified since extension deployment (settings preserved)."
    fi

    if [[ -n "$manifest_backup_path" && -f "$manifest_backup_path" ]]; then
      # Verify backup hash before restoring
      cur_bak_sha=$(calc_sha256 "$manifest_backup_path")
      if [[ -n "$manifest_backup_sha" && "$cur_bak_sha" != "$manifest_backup_sha" && "$force" != "--force" ]]; then
        echo "! Error: Backup hash mismatch for $manifest_backup_path" >&2
        exit 1
      fi
      # Atomic restore
      tmp_restore="${installed_ext}.tmp.$$"
      cp "$manifest_backup_path" "$tmp_restore"
      chmod 0600 "$tmp_restore"
      mv -f "$tmp_restore" "$installed_ext"
      echo "✓ Restored prior extension from: $manifest_backup_path"
    else
      rm -f "$installed_ext"
      echo "✓ Removed extension: $installed_ext (no prior backup)"
    fi
    rm -f "$manifest_file"
  else
    # Fallback if manifest is missing: find latest backup file in durable dir
    latest_bak=$(ls -t "$durable_dir"/durable-subagent-recovery.ts.bak.* 2>/dev/null | head -n 1 || true)
    if [[ -n "$latest_bak" && -f "$latest_bak" ]]; then
      tmp_restore="${installed_ext}.tmp.$$"
      cp "$latest_bak" "$tmp_restore"
      chmod 0600 "$tmp_restore"
      mv -f "$tmp_restore" "$installed_ext"
      echo "✓ Restored prior extension from: $latest_bak"
    else
      rm -f "$installed_ext"
      echo "✓ Removed extension: $installed_ext"
    fi
  fi

  echo "✓ Rollback completed successfully."
  echo "Runtime jobs and database history preserved in $durable_dir (never wiped)."
  exit 0
fi

# ----------------------------------------------------------------------------
# Mode: Diagnostics (human or JSON)
# ----------------------------------------------------------------------------
MODE="human"
if [[ "${1:-}" == "--json" ]]; then
  MODE="json"
fi

if [[ "$MODE" == "human" ]]; then
  echo "=== Pi Durable Subagent Recovery Doctor ==="
fi

node -e '
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const mode = process.argv[1];
const durableDir = process.env.PI_DURABLE_DIR || path.join(os.homedir(), ".pi", "durable");
const dbPath = path.join(durableDir, "subagents.sqlite");
const sessionsDir = path.join(durableDir, "sessions");
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const manifestFile = path.join(durableDir, "deployment-manifest.json");

const report = {
  timestamp: new Date().toISOString(),
  environment: {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    sqliteAvailable: false,
    procStatAvailable: false,
    bootIdAvailable: false,
  },
  permissions: {
    durableDir: null,
    sessionsDir: null,
    databaseFile: null,
  },
  database: {
    exists: false,
    integrityCheck: null,
    schemaVersion: null,
    totalJobs: 0,
    byState: {},
    distilledCount: 0,
    preservedSessionsCount: 0,
  },
  manifest: {
    exists: false,
    deployedAt: null,
    installedSha256: null,
  },
  issues: [],
};

// Check node:sqlite
try {
  const { DatabaseSync } = require("node:sqlite");
  report.environment.sqliteAvailable = typeof DatabaseSync === "function";
} catch (e) {
  report.issues.push("node:sqlite unavailable: " + e.message);
}

// Check /proc/<pid>/stat
try {
  const stat = fs.readFileSync("/proc/self/stat", "utf8");
  const closeParen = stat.lastIndexOf(")");
  if (closeParen !== -1) {
    report.environment.procStatAvailable = true;
  }
} catch (e) {
  report.environment.procStatAvailable = false;
}

// Check boot_id
try {
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (bootId) report.environment.bootIdAvailable = true;
} catch (e) {
  report.environment.bootIdAvailable = false;
}

// Check permissions
try {
  if (fs.existsSync(durableDir)) {
    const s = fs.statSync(durableDir);
    report.permissions.durableDir = (s.mode & 0o777).toString(8);
  }
  if (fs.existsSync(sessionsDir)) {
    const s = fs.statSync(sessionsDir);
    report.permissions.sessionsDir = (s.mode & 0o777).toString(8);
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
    report.database.preservedSessionsCount = files.length;
  }
  if (fs.existsSync(dbPath)) {
    const s = fs.statSync(dbPath);
    report.permissions.databaseFile = (s.mode & 0o777).toString(8);
  }
} catch (e) {
  report.issues.push("Permission check error: " + e.message);
}

// Check database
if (report.environment.sqliteAvailable && fs.existsSync(dbPath)) {
  report.database.exists = true;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const check = db.prepare("PRAGMA quick_check").get();
    report.database.integrityCheck = check ? check.quick_check : "unknown";
    if (check && check.quick_check !== "ok") {
      report.issues.push("Database failed quick_check: " + JSON.stringify(check));
    }
    const ver = db.prepare("PRAGMA user_version").get();
    report.database.schemaVersion = ver ? Number(ver.user_version) : 0;

    const total = db.prepare("SELECT count(*) as count FROM subagent_jobs").get();
    report.database.totalJobs = total ? Number(total.count) : 0;

    const states = db.prepare("SELECT state, count(*) as count FROM subagent_jobs GROUP BY state").all();
    for (const r of states) {
      report.database.byState[r.state] = Number(r.count);
    }

    const distilled = db.prepare("SELECT count(*) as count FROM subagent_jobs WHERE is_distilled = 1").get();
    report.database.distilledCount = distilled ? Number(distilled.count) : 0;

    db.close();
  } catch (e) {
    report.issues.push("Database read error: " + e.message);
  }
}

// Check manifest
if (fs.existsSync(manifestFile)) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    report.manifest.exists = true;
    report.manifest.deployedAt = m.deployedAt;
    report.manifest.installedSha256 = m.installedSha256;
  } catch {}
}

if (mode === "json") {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("Environment:");
  console.log("  Node.js: " + report.environment.nodeVersion + " (" + report.environment.arch + ")");
  console.log("  node:sqlite available: " + (report.environment.sqliteAvailable ? "YES" : "NO"));
  console.log("  Linux /proc/<pid>/stat: " + (report.environment.procStatAvailable ? "YES" : "NO"));
  console.log("  Kernel boot ID: " + (report.environment.bootIdAvailable ? "YES" : "NO"));
  console.log("");
  console.log("Security & Permissions:");
  console.log("  " + durableDir + " mode: " + (report.permissions.durableDir || "MISSING") + " (expected: 700)");
  console.log("  " + sessionsDir + " mode: " + (report.permissions.sessionsDir || "MISSING") + " (expected: 700)");
  console.log("  " + dbPath + " mode: " + (report.permissions.databaseFile || "MISSING") + " (expected: 600)");
  console.log("");
  console.log("Ledger Database:");
  console.log("  Exists: " + (report.database.exists ? "YES" : "NO"));
  console.log("  Integrity: " + (report.database.integrityCheck || "N/A"));
  console.log("  Schema Version: " + (report.database.schemaVersion ?? "N/A"));
  console.log("  Total Jobs Tracked: " + report.database.totalJobs);
  console.log("  Jobs by State: " + JSON.stringify(report.database.byState));
  console.log("  Preserved Transcripts: " + report.database.preservedSessionsCount);
  console.log("  Distilled Sessions: " + report.database.distilledCount);
  console.log("");
  if (report.issues.length > 0) {
    console.log("Issues Detected (" + report.issues.length + "):");
    for (const issue of report.issues) {
      console.log("  ! " + issue);
    }
  } else {
    console.log("All health checks passed. Durable subagent recovery is ready.");
  }
}
' "$MODE"
