#!/usr/bin/env bash
# Doctor and diagnostic tool for Pi Durable Subagent Recovery.
# Validates environment, node:sqlite, database integrity, process liveness, and permissions.
# Provides atomic, hash-safe rollback refusing hash conflicts on modified files.
set -euo pipefail

durable_dir="${PI_DURABLE_DIR:-$HOME/.pi/durable}"
db_path="$durable_dir/subagents.sqlite"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
manifest_file="$durable_dir/deployment-manifest.json"
for path in "$durable_dir" "$durable_dir/sessions" "$agent_dir" "$agent_dir/extensions"; do
  if [[ -L "$path" ]]; then echo "! Refusing symlink namespace: $path" >&2; exit 1; fi
done

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
  echo "=== Durable Subagent Recovery: Quarantine Inspection ==="

  # Active writer detection: inspect /proc/<pid>/fd for any open references to database
  active_writers=()
  for p in /proc/[0-9]*; do
    pid="${p#/proc/}"
    if [[ "$pid" == "$$" || "$pid" == "$PPID" ]]; then continue; fi
    if [[ -d "$p/fd" ]]; then
      for fd in "$p/fd"/*; do
        target=$(readlink -f "$fd" 2>/dev/null || true)
        if [[ "$target" == "$db_path"* ]]; then
          active_writers+=("$pid")
          break
        fi
      done
    fi
  done

  if [[ ${#active_writers[@]} -gt 0 ]]; then
    echo "! Refusing database quarantine: active processes holding open descriptors on $db_path!" >&2
    echo "  Active writer PIDs: ${active_writers[*]}" >&2
    echo "  Automated quarantine while writers are active causes split-brain database corruption." >&2
    exit 1
  fi

  echo "! Automated mutating database quarantine is disabled to prevent split-brain state loss."
  echo "! The ledger remains fail-closed, preserving DB, WAL, and SHM files untouched."
  echo ""
  echo "Offline Diagnostic & Manual Recovery Procedure:"
  echo "1. Verify all Pi and worker processes are stopped: pgrep -f 'pi' || true"
  echo "2. Confirm no open descriptors: lsof '$db_path' 2>/dev/null || true"
  echo "3. Make a manual verified copy of: $db_path, ${db_path}-wal, ${db_path}-shm"
  echo "4. Inspect database integrity using sqlite3 CLI:"
  echo "   sqlite3 '$db_path' 'PRAGMA integrity_check;'"
  echo "   sqlite3 '$db_path' '.recover' > /path/to/recovered.sql"
  exit 1
fi

# ----------------------------------------------------------------------------
# Mode: --rollback
# ----------------------------------------------------------------------------
if [[ "${1:-}" == "--rollback" ]]; then
  if [[ "$#" != 1 ]]; then echo "! Rollback accepts no force/override arguments." >&2; exit 1; fi
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  exec python3 "$script_dir/durable-recovery-deploy.py" rollback --agent-dir "$agent_dir" --durable-dir "$durable_dir"
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
    console.log("Local storage checks passed. This does not certify SDK recovery, native compatibility, or deployment acceptance.");
  }
}
' "$MODE"
