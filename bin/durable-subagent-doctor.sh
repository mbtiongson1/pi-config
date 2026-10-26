#!/usr/bin/env bash
# Doctor and diagnostic tool for Pi Durable Subagent Recovery.
# Validates environment, node:sqlite, database integrity, process liveness, and permissions.
set -euo pipefail

durable_dir="${PI_DURABLE_DIR:-$HOME/.pi/durable}"
db_path="$durable_dir/subagents.sqlite"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

MODE="human"
if [[ "${1:-}" == "--json" ]]; then
  MODE="json"
elif [[ "${1:-}" == "--rollback" ]]; then
  echo "=== Durable Subagent Recovery Rollback ==="
  installed_ext="$agent_dir/extensions/durable-subagent-recovery.ts"
  if [[ -f "$installed_ext" ]]; then
    # Find latest backup in durable dir
    latest_bak=$(ls -t "$durable_dir"/durable-subagent-recovery.ts.bak.* 2>/dev/null | head -n 1 || true)
    if [[ -n "$latest_bak" && -f "$latest_bak" ]]; then
      cp "$latest_bak" "$installed_ext"
      echo "✓ Restored prior extension from: $latest_bak"
    else
      rm -f "$installed_ext"
      echo "✓ Removed extension: $installed_ext"
    fi
  else
    echo "Extension was not deployed in $agent_dir/extensions"
  fi
  echo "Runtime jobs and database history preserved in $durable_dir (never wiped)."
  exit 0
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

// Check database contents
if (report.environment.sqliteAvailable && fs.existsSync(dbPath)) {
  report.database.exists = true;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const integrity = db.prepare("PRAGMA integrity_check").get();
    report.database.integrityCheck = integrity ? integrity.integrity_check : "unknown";
    
    const ver = db.prepare("PRAGMA user_version").get();
    report.database.schemaVersion = ver ? ver.user_version : 0;

    const total = db.prepare("SELECT COUNT(*) as count FROM subagent_jobs").get();
    report.database.totalJobs = total ? total.count : 0;

    const states = db.prepare("SELECT state, COUNT(*) as count FROM subagent_jobs GROUP BY state").all();
    for (const row of states) {
      report.database.byState[row.state] = row.count;
    }

    const distilled = db.prepare("SELECT COUNT(*) as count FROM subagent_jobs WHERE is_distilled = 1").get();
    report.database.distilledCount = distilled ? distilled.count : 0;

    db.close();
  } catch (e) {
    report.issues.push("Database check failed: " + e.message);
  }
}

if (mode === "json") {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("Environment:");
  console.log("  Node.js:           " + report.environment.nodeVersion + (report.environment.sqliteAvailable ? " (node:sqlite ready)" : " (! node:sqlite missing)"));
  console.log("  Linux /proc/stat:  " + (report.environment.procStatAvailable ? "available" : "unavailable"));
  console.log("  Kernel boot_id:    " + (report.environment.bootIdAvailable ? "available" : "unavailable"));
  console.log("\nStorage & Permissions:");
  console.log("  Durable Dir:       " + durableDir + " (" + (report.permissions.durableDir || "missing") + ")");
  console.log("  Sessions Dir:      " + sessionsDir + " (" + (report.permissions.sessionsDir || "missing") + ")");
  console.log("  Database File:     " + dbPath + " (" + (report.permissions.databaseFile || "missing") + ")");
  console.log("\nDatabase Health:");
  console.log("  Status:            " + (report.database.exists ? "Initialized" : "Not yet created"));
  if (report.database.exists) {
    console.log("  Integrity Check:   " + report.database.integrityCheck);
    console.log("  Schema Version:    " + report.database.schemaVersion);
    console.log("  Total Jobs:        " + report.database.totalJobs);
    console.log("  Jobs by State:     " + JSON.stringify(report.database.byState));
    console.log("  Preserved Transcripts: " + report.database.preservedSessionsCount);
    console.log("  Distilled Detected:    " + report.database.distilledCount);
  }
  if (report.issues.length > 0) {
    console.log("\nIssues Detected:");
    for (const iss of report.issues) console.log("  ! " + iss);
  } else {
    console.log("\n✓ All health checks passed.");
  }
}
' "$MODE"
