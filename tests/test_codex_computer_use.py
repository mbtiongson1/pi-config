"""Unit and regression tests for Codex Computer Use integration."""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO / "bin" / "codex-computer-use.py"

spec = importlib.util.spec_from_file_location("codex_computer_use", MODULE_PATH)
ccu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ccu)


class CodexComputerUseTests(unittest.TestCase):
    def test_os_detection_non_darwin(self):
        with patch.object(ccu, "is_macos", return_value=False), \
             patch("platform.system", return_value="Linux"):
            health = ccu.check_health()
            self.assertFalse(health["os_supported"])
            self.assertEqual(health["status"], "UNAVAILABLE ON THIS OS")
            report = ccu.format_doctor_report(health)
            self.assertIn("UNAVAILABLE ON THIS OS", report)

    def test_missing_prerequisites_not_installed(self):
        with patch.object(ccu, "is_macos", return_value=True), \
             patch("shutil.which", return_value=None), \
             patch.object(ccu, "find_codex_app", return_value=(False, None, None)):
            health = ccu.check_health()
            self.assertEqual(health["status"], "NOT INSTALLED")
            report = ccu.format_doctor_report(health)
            self.assertIn("Status: NOT INSTALLED", report)
            self.assertIn("Install Codex CLI", report)

    def test_not_configured_when_extension_missing(self):
        with patch.object(ccu, "is_macos", return_value=True), \
             patch("shutil.which", return_value="/usr/local/bin/dummy"), \
             patch.object(ccu, "find_codex_app", return_value=(True, Path("/Applications/Codex.app"), "Codex.app")), \
             patch.object(ccu, "check_pi_extension", return_value=(False, None)), \
             patch.object(ccu, "probe_codex_app_server", return_value=(True, "test-agent", ["click", "list_apps"], None)), \
             patch.object(ccu, "check_accessibility_permission", return_value=True), \
             patch.object(ccu, "check_screen_recording_permission", return_value=True):
            health = ccu.check_health()
            self.assertEqual(health["status"], "NOT CONFIGURED")
            report = ccu.format_doctor_report(health)
            self.assertIn("Status: NOT CONFIGURED", report)
            self.assertIn("install-codex-computer-use.sh", report)

    def test_permission_required_when_accessibility_missing(self):
        with patch.object(ccu, "is_macos", return_value=True), \
             patch("shutil.which", return_value="/usr/local/bin/dummy"), \
             patch.object(ccu, "find_codex_app", return_value=(True, Path("/Applications/Codex.app"), "Codex.app")), \
             patch.object(ccu, "check_pi_extension", return_value=(True, "npm:pi-codex-computer-use")), \
             patch.object(ccu, "probe_codex_app_server", return_value=(True, "test-agent", ["click", "list_apps"], None)), \
             patch.object(ccu, "check_accessibility_permission", return_value=False), \
             patch.object(ccu, "check_screen_recording_permission", return_value=True):
            health = ccu.check_health()
            self.assertEqual(health["status"], "INSTALLED — HUMAN PERMISSION REQUIRED")
            report = ccu.format_doctor_report(health)
            self.assertIn("Status: INSTALLED — HUMAN PERMISSION REQUIRED", report)
            self.assertIn("Privacy & Security > Accessibility", report)

    def test_ready_status_when_all_pass(self):
        with patch.object(ccu, "is_macos", return_value=True), \
             patch("shutil.which", return_value="/usr/local/bin/dummy"), \
             patch.object(ccu, "find_codex_app", return_value=(True, Path("/Applications/Codex.app"), "Codex.app")), \
             patch.object(ccu, "check_pi_extension", return_value=(True, "npm:pi-codex-computer-use")), \
             patch.object(ccu, "probe_codex_app_server", return_value=(True, "test-agent", ["click", "list_apps"], None)), \
             patch.object(ccu, "check_accessibility_permission", return_value=True), \
             patch.object(ccu, "check_screen_recording_permission", return_value=True):
            health = ccu.check_health()
            self.assertEqual(health["status"], "READY")
            report = ccu.format_doctor_report(health)
            self.assertIn("Status: READY", report)
            self.assertIn("Pi", report)
            self.assertIn("Codex CLI", report)
            self.assertIn("Codex.app", report)
            self.assertIn("Pi Codex CU extension", report)
            self.assertIn("Codex app-server", report)
            self.assertIn("Computer Use service", report)
            self.assertIn("Accessibility permission", report)
            self.assertIn("Screen Recording", report)

    def test_settings_json_idempotency_and_disable(self):
        with tempfile.TemporaryDirectory() as td:
            agent_dir = Path(td)
            settings_path = agent_dir / "settings.json"
            settings_path.write_text(json.dumps({"packages": ["npm:pi-antigravity"]}))

            # Patch external commands during install
            with patch("shutil.which", return_value=None), \
                 patch.object(ccu, "is_macos", return_value=True), \
                 patch.object(ccu, "ensure_codex_app_symlink", return_value=None), \
                 patch.object(ccu, "find_sky_client", return_value=None), \
                 patch.object(ccu, "check_health", return_value={"status": "NOT CONFIGURED", "reason": "mock"}), \
                 patch("sys.stdout"), patch("sys.stderr"):
                ccu.install(agent_dir=agent_dir)
                data = json.loads(settings_path.read_text())
                self.assertIn("npm:pi-codex-computer-use", data["packages"])
                self.assertIn("npm:pi-antigravity", data["packages"])

                # Second install: must not duplicate
                ccu.install(agent_dir=agent_dir)
                data2 = json.loads(settings_path.read_text())
                self.assertEqual(data2["packages"].count("npm:pi-codex-computer-use"), 1)

                # Disable: removes extension cleanly
                ccu.disable(agent_dir=agent_dir)
                data3 = json.loads(settings_path.read_text())
                self.assertNotIn("npm:pi-codex-computer-use", data3["packages"])
                self.assertIn("npm:pi-antigravity", data3["packages"])

    def test_config_toml_idempotency(self):
        with tempfile.TemporaryDirectory() as td:
            codex_home = Path(td)
            config_toml = codex_home / "config.toml"
            config_toml.write_text('[desktop]\naccent = "#000"\n')

            with patch.object(ccu, "CODEX_HOME", codex_home), \
                 patch.object(ccu, "CODEX_CONFIG_TOML", config_toml):
                dummy_client = Path("/fake/path/SkyComputerUseClient")
                ccu.configure_codex_toml(dummy_client)
                c1 = config_toml.read_text()
                self.assertIn("[mcp_servers.computer-use]", c1)
                self.assertIn(str(dummy_client), c1)
                self.assertIn('[desktop]\naccent = "#000"', c1)

                # Run again: should replace cleanly, not duplicate
                ccu.configure_codex_toml(dummy_client)
                c2 = config_toml.read_text()
                self.assertEqual(c2.count("[mcp_servers.computer-use]"), 1)

    def test_smoke_test_blocks_on_permission(self):
        with patch.object(ccu, "check_health", return_value={
            "status": "INSTALLED — HUMAN PERMISSION REQUIRED",
            "reason": "Accessibility required",
            "accessibility_permission": False,
            "screen_recording_permission": True,
            "pi_installed": True,
            "pi_version": "0.87.1",
            "codex_cli_installed": True,
            "codex_cli_version": "0.157.1",
            "codex_app_installed": True,
            "codex_app_note": "ChatGPT",
            "pi_extension_installed": True,
            "pi_extension_package": "npm:pi-codex-computer-use",
            "codex_app_server_ok": True,
            "cu_service_ok": True,
            "cu_tools": ["click"],
        }):
            ret = None
            with patch("sys.stdout"), patch("sys.stderr"):
                ret = ccu.smoke_test()
            self.assertEqual(ret, 2)


if __name__ == "__main__":
    unittest.main()
