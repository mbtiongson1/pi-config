import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ENSURE_SUBAGENT = REPO / "bin" / "ensure-subagent-config.sh"
SUBAGENT_TEMPLATE = REPO / "subagent.json.template"
AGENTS_DIR = REPO / "agents"


class SubagentFallbackConfigTests(unittest.TestCase):
    def test_subagent_template_defaults(self):
        self.assertTrue(SUBAGENT_TEMPLATE.exists())
        data = json.loads(SUBAGENT_TEMPLATE.read_text())
        self.assertEqual(data.get("maxRetries"), 1)
        self.assertIn("taskDefaults", data)
        self.assertIn("general", data["taskDefaults"])
        self.assertEqual(data["taskDefaults"]["general"].get("fallbackModels"), ["antigravity/gemini-3.8-flash:medium"])
        self.assertEqual(data["taskDefaults"]["general"].get("maxRetries"), 1)

    def test_worker_agent_spawns_disabled(self):
        worker_file = AGENTS_DIR / "worker.md"
        self.assertTrue(worker_file.exists())
        content = worker_file.read_text()
        self.assertIn("spawns: false", content)
        self.assertIn("model: antigravity/gemini-3.8-flash:medium", content)

    def test_flash_workers_spawns_disabled(self):
        flash_workers = [
            "worker-flash-low.md",
            "worker-flash-medium.md",
            "worker-flash-high.md",
        ]
        for name in flash_workers:
            agent_file = AGENTS_DIR / name
            self.assertTrue(agent_file.exists())
            self.assertIn("spawns: false", agent_file.read_text())

    def test_ensure_subagent_script_updates_config(self):
        with tempfile.TemporaryDirectory() as td:
            pi_dir = Path(td) / ".pi"
            pi_dir.mkdir(parents=True)
            subagent_file = pi_dir / "subagent.json"
            subagent_file.write_text(json.dumps({"graceTurns": 2}))

            env = {
                **os.environ,
                "HOME": td,
                "PI_CODING_AGENT_DIR": td,
            }
            # Create dummy script structure
            res = subprocess.run(["bash", str(ENSURE_SUBAGENT)], env=env, capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, res.stderr)

            # File should now contain fallbackModels
            data = json.loads(subagent_file.read_text())
            self.assertEqual(data.get("maxRetries"), 1)
            self.assertIn("taskDefaults", data)
            self.assertEqual(data["taskDefaults"]["general"]["fallbackModels"], ["antigravity/gemini-3.8-flash:medium"])


if __name__ == "__main__":
    unittest.main()
