"""v1.10 Update/Reinstall mandatory pi-cost installation contract."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
INSTALLER = REPO / "bin" / "install-pi-cost.sh"
REQUIRED = ["SKILL.md", "LICENSE", "NOTICE", "scripts/pi_cost.py", "scripts/prices.json"]


class InstallPiCostTests(unittest.TestCase):
    def test_fresh_install_is_complete_idempotent_and_restores_drift(self):
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td) / "agent"
            dest.mkdir()
            (dest / "settings.json").write_text('{"packages": []}')
            env = {**os.environ, "PI_CODING_AGENT_DIR": str(dest)}
            for _ in range(2):
                result = subprocess.run(["bash", str(INSTALLER)], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("1.10.0 installed and verified", result.stdout)
                installed = dest / "skills" / "pi-cost"
                for name in REQUIRED:
                    self.assertEqual((REPO / "skills" / "pi-cost" / name).read_bytes(),
                                     (installed / name).read_bytes())
                self.assertIn("version: 1.10.0", (installed / "SKILL.md").read_text())
                self.assertEqual(json.loads((dest / "settings.json").read_text()), {"packages": []})
                if _ == 0:
                    (installed / "scripts" / "pi_cost.py").write_text("corrupted")
            # The installed script can price workers without an optional package or network.
            session = Path(td) / "session.jsonl"
            session.write_text("\n".join(json.dumps(row) for row in [
                {"message": {"role": "assistant", "model": "gpt-6-sol", "provider": "openai-codex",
                             "usage": {"input": 1, "cost": {"total": 11.0}}}},
                {"message": {"role": "toolResult", "toolName": "subagent", "details": {"results": [
                    {"agent": "worker-flash-medium", "model": "antigravity/gemini-3.8-flash:medium",
                     "exitCode": 0, "usage": {"input": 1_000_000, "output": 0,
                                               "cacheRead": 1_000_000, "cacheWrite": 0, "turns": 1}}]}}},
            ]))
            check = subprocess.run(["python3", str(installed / "scripts" / "pi_cost.py"),
                                    "--session", str(session), "--offline", "--json"],
                                   env=env, capture_output=True, text=True)
            self.assertEqual(check.returncode, 0, check.stderr)
            data = json.loads(check.stdout)
            self.assertEqual(data["main"]["logged_cost"], 11.0)
            self.assertEqual(len(data["direct"]), 1)
            self.assertAlmostEqual(data["direct"][0]["parts"]["cacheRead"], .075)

    def test_symlink_target_is_rejected_without_following_it(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            real = root / "do-not-touch"
            real.mkdir()
            (real / "marker").write_text("original")
            agent = root / "agent"
            (agent / "skills").mkdir(parents=True)
            (agent / "skills" / "pi-cost").symlink_to(real, target_is_directory=True)
            check = subprocess.run(["bash", str(INSTALLER)],
                                   env={**os.environ, "PI_CODING_AGENT_DIR": str(agent)},
                                   capture_output=True, text=True)
            self.assertNotEqual(check.returncode, 0)
            self.assertIn("refusing to overwrite symlink", check.stderr)
            self.assertEqual((real / "marker").read_text(), "original")

    def test_symlinked_scripts_subdir_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            real = root / "do-not-touch"
            real.mkdir()
            (real / "marker").write_text("original")
            agent = root / "agent"
            (agent / "skills" / "pi-cost").mkdir(parents=True)
            (agent / "skills" / "pi-cost" / "scripts").symlink_to(real, target_is_directory=True)
            check = subprocess.run(["bash", str(INSTALLER)],
                                   env={**os.environ, "PI_CODING_AGENT_DIR": str(agent)},
                                   capture_output=True, text=True)
            self.assertNotEqual(check.returncode, 0)
            self.assertIn("refusing to overwrite symlink", check.stderr)
            self.assertEqual((real / "marker").read_text(), "original")

    def test_metadata_and_version_agree(self):
        version = (REPO / "VERSION").read_text().strip()
        self.assertEqual(version, "1.10.0")
        self.assertIn(f"version: {version}", (REPO / "skills" / "pi-cost" / "SKILL.md").read_text())
        prices = json.loads((REPO / "skills" / "pi-cost" / "scripts" / "prices.json").read_text())
        self.assertEqual(prices["_meta"]["source_license"], "MIT")
        self.assertIsNotNone(prices["gemini/gemini-3.8-flash"]["cache_read"])
        self.assertIsNotNone(prices["gpt-6-luna"]["cache_write"])


if __name__ == "__main__":
    unittest.main()
