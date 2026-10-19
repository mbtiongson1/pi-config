import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PREFLIGHT = REPO_ROOT / "bin/astra-advisor-preflight.py"
LAUNCHER = REPO_ROOT / "bin/run-astra-advisor.sh"
PROFILE = (REPO_ROOT / "skills/astra-advisor/codex.config.toml").read_text(encoding="utf-8")


def catalog(*models):
    return {"models": list(models)}


def model(slug, *efforts):
    return {
        "slug": slug,
        "supported_reasoning_levels": [{"effort": effort} for effort in efforts],
    }


class TestAstraAdvisorPreflight(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.codex_home = self.root / "codex"
        self.codex_home.mkdir()
        self.profile = self.codex_home / "astra-advisor.config.toml"
        self.profile.write_text(PROFILE, encoding="utf-8")
        self.catalog_path = self.root / "catalog.json"

    def tearDown(self):
        self.tmp.cleanup()

    def run_preflight(self, models=None, *, check=True):
        if models is not None:
            self.catalog_path.write_text(json.dumps(catalog(*models)), encoding="utf-8")
        return subprocess.run(
            [
                "python3", str(PREFLIGHT), "--codex-home", str(self.codex_home),
                "--catalog-file", str(self.catalog_path),
            ],
            capture_output=True,
            text=True,
            check=check,
        )

    def test_current_astra_max_passes_without_write(self):
        before = self.profile.read_bytes()
        result = self.run_preflight([model("gpt-6-astra", "low", "max")])
        self.assertIn("profile unchanged", result.stdout)
        self.assertEqual(self.profile.read_bytes(), before)

    def test_outdated_astra_updates_only_model_and_preserves_max(self):
        self.run_preflight([
            model("gpt-6-astra", "low", "max"),
            model("gpt-7-astra", "low", "max"),
        ])
        content = self.profile.read_text(encoding="utf-8")
        self.assertIn('model = "gpt-7-astra"', content)
        self.assertIn('model_reasoning_effort = "max"', content)

    def test_configured_newest_astra_passes_without_write(self):
        self.profile.write_text(PROFILE.replace('model = "gpt-6-astra"', 'model = "gpt-8-astra"'), encoding="utf-8")
        before = self.profile.read_bytes()
        result = self.run_preflight([
            model("gpt-7-astra", "low", "max"),
            model("gpt-8-astra", "low", "max"),
        ])
        self.assertIn("gpt-8-astra", result.stdout)
        self.assertEqual(self.profile.read_bytes(), before)

    def test_catalog_unavailable_fails_closed(self):
        self.catalog_path.write_text("not json", encoding="utf-8")
        result = self.run_preflight(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cannot read mocked model catalog", result.stderr)

    def test_newest_without_max_fails_closed_even_if_older_supports_it(self):
        result = self.run_preflight([
            model("gpt-6-astra", "low", "max"),
            model("gpt-7-astra", "low", "high"),
        ], check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not advertise max", result.stderr)
        self.assertIn('model = "gpt-6-astra"', self.profile.read_text(encoding="utf-8"))

    def test_missing_profile_fails_with_install_guidance(self):
        self.profile.unlink()
        result = self.run_preflight([model("gpt-6-astra", "max")], check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("profile is missing", result.stderr)
        self.assertIn("copy skills/astra-advisor/codex.config.toml", result.stderr)

    def test_read_only_profile_reports_exact_edit_and_does_not_write(self):
        self.profile.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        before = self.profile.read_bytes()
        result = self.run_preflight([
            model("gpt-6-astra", "max"), model("gpt-7-astra", "max"),
        ], check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('model = "gpt-7-astra"', result.stderr)
        self.assertEqual(self.profile.read_bytes(), before)

    def test_launcher_does_not_start_advisor_until_preflight_succeeds(self):
        mock_bin = self.root / "mock-bin"
        mock_bin.mkdir()
        mock_codex = mock_bin / "codex"
        mock_codex.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys\n"
            "if sys.argv[1:3] == ['debug', 'models']:\n"
            " p = pathlib.Path(os.environ['MOCK_CATALOG'])\n"
            " if os.environ.get('MOCK_CATALOG_FAIL'):\n"
            "  print('catalog unavailable', file=sys.stderr); raise SystemExit(1)\n"
            " print(p.read_text()); raise SystemExit(0)\n"
            "if sys.argv[1:3] == ['exec', '--ephemeral']:\n"
            " text = pathlib.Path(os.environ['CODEX_HOME'], 'astra-advisor.config.toml').read_text()\n"
            " if 'model = \\\"gpt-7-astra\\\"' not in text: raise SystemExit('stale model reached advisor')\n"
            " if 'Astra preflight passed: gpt-7-astra at max' not in sys.argv[-1]: raise SystemExit('missing preflight attestation')\n"
            " print('ADVISOR_REACHED')\n"
            " raise SystemExit(0)\n"
            "raise SystemExit('unexpected codex invocation')\n",
            encoding="utf-8",
        )
        mock_codex.chmod(0o755)
        self.catalog_path.write_text(json.dumps(catalog(
            model("gpt-6-astra", "max"), model("gpt-7-astra", "max"),
        )), encoding="utf-8")
        env = {
            **os.environ,
            "CODEX_HOME": str(self.codex_home),
            "MOCK_CATALOG": str(self.catalog_path),
            "PATH": f"{mock_bin}{os.pathsep}{os.environ['PATH']}",
        }
        passed = subprocess.run(
            ["bash", str(LAUNCHER), "Situation: test"],
            env=env, capture_output=True, text=True,
        )
        self.assertEqual(passed.returncode, 0, passed.stderr)
        self.assertIn("ADVISOR_REACHED", passed.stdout)

        env["MOCK_CATALOG_FAIL"] = "1"
        blocked = subprocess.run(
            ["bash", str(LAUNCHER), "Situation: test"],
            env=env, capture_output=True, text=True,
        )
        self.assertNotEqual(blocked.returncode, 0)
        self.assertNotIn("ADVISOR_REACHED", blocked.stdout)
        self.assertIn("Astra preflight blocked", blocked.stderr)


if __name__ == "__main__":
    unittest.main()
