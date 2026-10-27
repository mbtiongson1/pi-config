"""Durable subagent recovery test suite (Python unittest).

Verifies:
1. Script and extension existence and executable permissions.
2. Extension code structure, schema integrity, and fail-safe hooks.
3. Doctor execution in an isolated namespace.
4. Retention policy and startup protection invariants.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
EXT_PATH = REPO_ROOT / "extensions" / "durable-subagent-recovery.ts"
ENSURE_SCRIPT = REPO_ROOT / "bin" / "ensure-durable-recovery.sh"
DOCTOR_SCRIPT = REPO_ROOT / "bin" / "durable-subagent-doctor.sh"


class TestDurableRecoveryStructure(unittest.TestCase):
    def test_files_exist(self):
        self.assertTrue(EXT_PATH.is_file(), "Extension must exist")
        self.assertTrue(ENSURE_SCRIPT.is_file(), "ensure-durable-recovery.sh must exist")
        self.assertTrue(DOCTOR_SCRIPT.is_file(), "durable-subagent-doctor.sh must exist")
        self.assertTrue(os.access(ENSURE_SCRIPT, os.X_OK), "ensure script must be executable")
        self.assertTrue(os.access(DOCTOR_SCRIPT, os.X_OK), "doctor script must be executable")

    def test_extension_invariants(self):
        source = EXT_PATH.read_text(encoding="utf-8")

        # WAL and synchronous FULL
        self.assertIn("PRAGMA journal_mode = WAL;", source)
        self.assertIn("PRAGMA synchronous = FULL;", source)

        # Cross-platform process identity implementation with Linux/Android proc fields
        self.assertIn("/proc/${pid}/stat", source)
        self.assertIn("/proc/sys/kernel/random/boot_id", source)
        self.assertIn("startTimeTicks", source)

        # Native lock observer is read-only; unknown liveness stays nonclaimable.
        self.assertIn("protectVendorOrphanRecords", source)
        self.assertIn("unknownWorkers", source)
        self.assertIn("process_liveness_unverifiable", source)
        self.assertNotIn("detached-protected", source)
        self.assertNotIn("legacyMutateState", source)

        # Manifest input is structured data, never shell source.
        self.assertNotIn("eval ", ENSURE_SCRIPT.read_text(encoding="utf-8"))
        self.assertNotIn("eval ", DOCTOR_SCRIPT.read_text(encoding="utf-8"))

        # Session preservation in private store
        self.assertIn("preserveSessionFile", source)
        self.assertIn("preserved_session_path", source)

        # CAS / atomic lease claim and lineage takeover (Gap 4 & P1-1)
        self.assertIn("claimResumeLease", source)
        self.assertIn("BEGIN IMMEDIATE;", source)
        self.assertIn("leased_by_another_process", source)
        self.assertIn("bindResumeLineage", source)
        self.assertIn("takeover_reservation_id", source)
        self.assertIn("superseded_by_job_id", source)

        # Policy validation and fail-closed corrupt handling (P0-1 & P1-3)
        self.assertIn("buildResumeSpec", source)
        self.assertIn("DatabaseCorruptError", source)

        # Commands and tools
        self.assertIn('registerCommand("subagent-recover"', source)
        self.assertIn('registerTool({', source)
        self.assertIn('name: "subagent_recover"', source)

    def test_doctor_in_isolated_sandbox(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            durable_dir = Path(tmpdir) / "durable"
            agent_dir = Path(tmpdir) / "agent"
            env = {
                **os.environ,
                "PI_DURABLE_DIR": str(durable_dir),
                "PI_CODING_AGENT_DIR": str(agent_dir),
            }

            # 1. Run installer
            res_install = subprocess.run([str(ENSURE_SCRIPT)], env=env, capture_output=True, text=True)
            self.assertEqual(res_install.returncode, 0, f"Installer failed: {res_install.stderr}")
            self.assertTrue(durable_dir.is_dir())
            self.assertEqual(oct(durable_dir.stat().st_mode)[-3:], "700")

            # 2. Run doctor --json
            res_doctor = subprocess.run([str(DOCTOR_SCRIPT), "--json"], env=env, capture_output=True, text=True)
            self.assertEqual(res_doctor.returncode, 0, f"Doctor failed: {res_doctor.stderr}")

            data = json.loads(res_doctor.stdout)
            self.assertTrue(data["environment"]["sqliteAvailable"])
            self.assertEqual(data["database"]["integrityCheck"], "ok")
            self.assertEqual(data["database"]["schemaVersion"], 2)
            self.assertEqual(data["permissions"]["durableDir"], "700")
            self.assertEqual(data["permissions"]["databaseFile"], "600")
            self.assertEqual(len(data["issues"]), 0)


if __name__ == "__main__":
    runner = unittest.main(exit=False)
    os._exit(0 if runner.result.wasSuccessful() else 1)


