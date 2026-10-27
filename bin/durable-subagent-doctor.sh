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
  echo "=== Durable Subagent Recovery Rollback ==="
  installed_ext="$agent_dir/extensions/durable-subagent-recovery.ts"
  force="${2:-}"

  if [[ ! -e "$installed_ext" && ! -L "$installed_ext" ]]; then
    echo "Extension was not deployed in $agent_dir/extensions"
    exit 0
  fi

  # Reject symlinks to prevent hijacking
  if [[ -L "$installed_ext" ]]; then
    echo "! Error: $installed_ext is a symlink; refusing rollback." >&2
    exit 1
  fi

  cur_ext_sha=$(calc_sha256 "$installed_ext")

  if [[ -e "$manifest_file" || -L "$manifest_file" ]]; then
    [[ ! -L "$manifest_file" && -f "$manifest_file" ]] || { echo "! Invalid manifest path; refusing rollback." >&2; exit 1; }
    manifest_fields=$(node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const crypto = require("node:crypto");
      const [file, durableDir] = process.argv.slice(1);
      const dirStat = fs.lstatSync(durableDir);
      const manifestStat = fs.lstatSync(file);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== process.getuid() || (dirStat.mode & 0o777) !== 0o700) throw new Error("unsafe durable directory ownership/mode");
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.uid !== process.getuid() || (manifestStat.mode & 0o777) !== 0o600) throw new Error("unsafe manifest ownership/mode");
      const m = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!m || typeof m !== "object" || Array.isArray(m) || (m.schemaVersion !== undefined && m.schemaVersion !== 1)) throw new Error("unsupported manifest schema");
      const keys = ["installedSha256", "backupPath", "backupSha256", "backupMode", "settingsSha256", "authSha256", "modelsSha256"];
      const values = keys.map(k => m[k] ?? "");
      if (values.some(v => typeof v !== "string")) throw new Error("invalid manifest field types");
      if (values[0] && !/^[a-f0-9]{64}$/.test(values[0])) throw new Error("invalid installed hash");
      if (values[1] || values[2] || values[3]) {
        const [backup, sha, mode] = values.slice(1, 4);
        if (!/^durable-subagent-recovery\.ts\.bak\.[A-Za-z0-9._-]+$/.test(path.basename(backup)) || path.dirname(path.resolve(backup)) !== path.resolve(durableDir)) throw new Error("backup path outside expected private namespace");
        if (!/^[a-f0-9]{64}$/.test(sha) || !/^[0-7]{3,4}$/.test(mode)) throw new Error("invalid backup hash/mode");
        const st = fs.lstatSync(backup);
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777).toString(8) !== mode) throw new Error("backup ownership/type/mode mismatch");
        const actual = crypto.createHash("sha256").update(fs.readFileSync(backup)).digest("hex");
        if (actual !== sha) throw new Error("backup hash mismatch");
      }
      process.stdout.write(values.map(v => v ? Buffer.from(v).toString("base64") : "-").join("\n"));
    ' "$manifest_file" "$durable_dir") || { echo "! Invalid or tampered deployment manifest; refusing rollback." >&2; exit 1; }
    mapfile -t manifest_values <<< "$manifest_fields"
    ((${#manifest_values[@]} == 7)) || { echo "! Invalid deployment manifest fields." >&2; exit 1; }
    decode_manifest_value() { [[ "$1" == "-" ]] && return 0; printf '%s' "$1" | base64 -d; }
    manifest_installed_sha=$(decode_manifest_value "${manifest_values[0]}")
    manifest_backup_path=$(decode_manifest_value "${manifest_values[1]}")
    manifest_backup_sha=$(decode_manifest_value "${manifest_values[2]}")
    manifest_backup_mode=$(decode_manifest_value "${manifest_values[3]}")
    manifest_settings_sha=$(decode_manifest_value "${manifest_values[4]}")
    manifest_auth_sha=$(decode_manifest_value "${manifest_values[5]}")
    manifest_models_sha=$(decode_manifest_value "${manifest_values[6]}")

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

    if [[ -n "$manifest_backup_path" ]]; then
      if [[ -L "$manifest_backup_path" ]]; then
        echo "! Error: Backup file $manifest_backup_path is a symlink; refusing rollback." >&2
        exit 1
      fi
      if [[ -f "$manifest_backup_path" ]]; then
        # Verify backup hash before restoring
        cur_bak_sha=$(calc_sha256 "$manifest_backup_path")
        if [[ -n "$manifest_backup_sha" && "$cur_bak_sha" != "$manifest_backup_sha" && "$force" != "--force" ]]; then
          echo "! Error: Backup hash mismatch for $manifest_backup_path" >&2
          exit 1
        fi
        # Atomic restore preserving exact mode
        tmp_restore="${installed_ext}.tmp.$$"
        cp "$manifest_backup_path" "$tmp_restore"
        restore_mode="${manifest_backup_mode:-600}"
        chmod "$restore_mode" "$tmp_restore"
        mv -f "$tmp_restore" "$installed_ext"
        echo "✓ Restored prior extension from: $manifest_backup_path (mode: $restore_mode)"
      else
        echo "! Error: Manifest backup is missing; refusing destructive rollback." >&2
        exit 1
      fi
    else
      rm -f "$installed_ext"
      echo "✓ Removed extension: $installed_ext (no prior backup)"
    fi
    rm -f "$manifest_file"
  else
    echo "! Error: Deployment manifest missing; refusing to guess a backup or remove the installed extension." >&2
    exit 1
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
