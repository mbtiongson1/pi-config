"""Tests for persistent quota line default preference."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ENSURE_SCRIPT = REPO / "bin" / "ensure-quota-line.sh"
SETTINGS_TEMPLATE = REPO / "settings.json.template"
PI_LAUNCHER = REPO / "bin" / "pi"

DUMMY_PANEL = """\
export default function quotaPanelExtension(pi: ExtensionAPI): void {
  let panelVisible = false;
  /** The compact box is the default surface: its own row, nothing competes for it. */
  let lineVisible = true;
  let boxVisible = true;
  let explicitBox = true;
  let statusVisible = false;
  let lastError: string | null = null;
  let disposed = false;
  let railMode = false;

  pi.on("session_start", async (_event, ctx) => {
    const ui = ctx as unknown as UiContext;
    if (!ui.hasUI) return;
    disposed = false;
    paintUi(ui);
  });
}
"""


class QuotaLineDefaultTests(unittest.TestCase):
    def test_settings_template_has_quota_line(self):
        self.assertTrue(SETTINGS_TEMPLATE.exists())
        data = json.loads(SETTINGS_TEMPLATE.read_text())
        self.assertIn("quota", data)
        self.assertEqual(data["quota"].get("surface"), "line")

    def test_pi_launcher_invokes_ensure_quota_line(self):
        self.assertTrue(PI_LAUNCHER.exists())
        content = PI_LAUNCHER.read_text()
        self.assertIn("ensure-quota-line.sh", content)

    def test_ensure_quota_line_sets_surface_in_settings(self):
        with tempfile.TemporaryDirectory() as td:
            agent_dir = Path(td) / "agent"
            agent_dir.mkdir()
            settings_file = agent_dir / "settings.json"

            # Case 1: Fresh settings without quota
            settings_file.write_text(json.dumps({"theme": "dark"}))
            env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent_dir)}
            res = subprocess.run(["bash", str(ENSURE_SCRIPT)], env=env, capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, res.stderr)
            data = json.loads(settings_file.read_text())
            self.assertEqual(data.get("quota", {}).get("surface"), "line")

            # Case 2: Settings previously set to box is corrected to line
            data["quota"]["surface"] = "box"
            settings_file.write_text(json.dumps(data))
            res = subprocess.run(["bash", str(ENSURE_SCRIPT)], env=env, capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, res.stderr)
            data = json.loads(settings_file.read_text())
            self.assertEqual(data.get("quota", {}).get("surface"), "line")

    def test_ensure_quota_line_patches_panel_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            agent_dir = Path(td) / "agent"
            quota_dir = agent_dir / "git" / "github.com" / "J3fp" / "piQuota" / "extensions"
            quota_dir.mkdir(parents=True)
            panel_file = quota_dir / "quota-panel.ts"
            panel_file.write_text(DUMMY_PANEL)

            env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent_dir)}

            # First run: patches panel
            res = subprocess.run(["bash", str(ENSURE_SCRIPT)], env=env, capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertIn("Patched", res.stdout)

            content = panel_file.read_text()
            self.assertIn("let boxVisible = false;", content)
            self.assertIn("let explicitBox = false;", content)
            self.assertNotIn("let boxVisible = true;", content)
            self.assertNotIn("let explicitBox = true;", content)
            self.assertIn("boxVisible = false; // default quota line", content)

            # Second run: idempotent
            res2 = subprocess.run(["bash", str(ENSURE_SCRIPT)], env=env, capture_output=True, text=True)
            self.assertEqual(res2.returncode, 0, res2.stderr)
            self.assertIn("already configured", res2.stdout)
            self.assertEqual(panel_file.read_text(), content)


if __name__ == "__main__":
    unittest.main()
