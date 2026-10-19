import unittest
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import tomllib
except ImportError:
    import tomli as tomllib

REPO_ROOT = Path(__file__).resolve().parent.parent

class TestAstraAdvisor(unittest.TestCase):
    def test_skill_markdown_structure(self):
        skill_path = REPO_ROOT / "skills/astra-advisor/SKILL.md"
        self.assertTrue(skill_path.exists(), "SKILL.md must exist in skills/astra-advisor/")
        content = skill_path.read_text(encoding="utf-8")

        # Frontmatter checks
        self.assertTrue(content.startswith("---"), "SKILL.md must have YAML frontmatter")
        self.assertIn("name: astra-advisor", content)
        self.assertIn("description:", content)

        # Canonical behavior & output format checks
        self.assertIn("## Decision", content)
        self.assertIn("## Reasoning", content)
        self.assertIn("## Risks", content)
        self.assertIn("## Confidence", content)

        # Context prerequisites checks
        self.assertIn("Situation", content)
        self.assertIn("Constraints", content)
        self.assertIn("Options", content)
        self.assertIn("Goal", content)
        self.assertIn("❌ **Insufficient context.**", content)

        # Behavioral & governance constraints
        self.assertIn("Pure reasoning only", content)
        self.assertIn("Read-only and advisory by default", content)
        self.assertIn("Explicit user authorization required", content)
        self.assertIn("Explicit thinking levels", content)
        self.assertIn("Codex Model Preflight", content)
        self.assertIn("You never use tools", content)
        self.assertIn("No autonomous delegation", content)
        self.assertIn("One round", content)
        self.assertIn("Skill vs. Agent Boundary", content)

    def test_codex_profile_toml(self):
        profile_path = REPO_ROOT / "skills/astra-advisor/codex.config.toml"
        self.assertTrue(profile_path.exists(), "codex.config.toml must exist")
        raw = profile_path.read_text(encoding="utf-8")

        data = tomllib.loads(raw)
        self.assertEqual(data.get("sandbox_mode"), "read-only")
        self.assertEqual(data.get("approval_policy"), "on-request")
        self.assertFalse(data.get("web_search"))
        self.assertEqual(data.get("model_reasoning_effort"), "max")
        self.assertIn("instructions", data)
        self.assertIn("You are advisor-astra", data["instructions"])
        self.assertIn("Never call tools", data["instructions"])
        self.assertIn("Never dispatch subagents", data["instructions"])
        self.assertIn("One round", data["instructions"])
        self.assertIn("## Decision", data["instructions"])
        self.assertIn("## Confidence", data["instructions"])

        # Test against codex CLI if installed
        codex_bin = shutil.which("codex")
        if codex_bin:
            with tempfile.TemporaryDirectory() as tmp_codex_home:
                target_cfg = Path(tmp_codex_home) / "astra-advisor.config.toml"
                shutil.copy(profile_path, target_cfg)
                res = subprocess.run(
                    [codex_bin, "-p", "astra-advisor", "--strict-config", "--help"],
                    env={**os.environ, "CODEX_HOME": tmp_codex_home},
                    capture_output=True,
                    text=True
                )
                self.assertEqual(res.returncode, 0, f"Codex strict config check failed: {res.stderr}")

    def test_pi_advisor_definitions(self):
        astra_agent = REPO_ROOT / "agents/advisor-astra.md"
        argon_agent = REPO_ROOT / "agents/advisor-argon.md"

        self.assertTrue(astra_agent.exists(), "agents/advisor-astra.md must exist")
        self.assertTrue(argon_agent.exists(), "agents/advisor-argon.md must exist")

        astra_content = astra_agent.read_text(encoding="utf-8")
        argon_content = argon_agent.read_text(encoding="utf-8")

        self.assertIn("role: advisor", astra_content)
        self.assertIn("role: advisor", argon_content)
        self.assertIn(":max", astra_content, "Astra agent must explicitly set max thinking")
        self.assertIn(":max", argon_content, "Argon agent must explicitly set max thinking")

        for content in [astra_content, argon_content]:
            self.assertIn("## Decision", content)
            self.assertIn("## Reasoning", content)
            self.assertIn("## Risks", content)
            self.assertIn("## Confidence", content)
            self.assertIn("❌ **Insufficient context.**", content)

    def test_installer_script(self):
        installer = REPO_ROOT / "bin/install-astra-advisor.sh"
        self.assertTrue(installer.exists(), "install-astra-advisor.sh must exist")
        self.assertTrue(os.access(installer, os.X_OK), "installer must be executable")

        with tempfile.TemporaryDirectory() as td:
            tmp_pi = Path(td) / "pi"
            tmp_codex = Path(td) / "codex"
            env = {
                **os.environ,
                "PI_CODING_AGENT_DIR": str(tmp_pi),
                "CODEX_HOME": str(tmp_codex),
            }
            res = subprocess.run(["bash", str(installer), "--all"], env=env, capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, f"Installer execution failed: {res.stderr}")

            # Verify Pi installation
            self.assertTrue((tmp_pi / "skills/astra-advisor/SKILL.md").exists())
            self.assertTrue((tmp_pi / "agents/advisor-astra.md").exists())

            # Verify Codex installation
            self.assertTrue((tmp_codex / "skills/astra-advisor/SKILL.md").exists())
            self.assertTrue((tmp_codex / "skills/astra-advisor/preflight.py").exists())
            self.assertTrue((tmp_codex / "skills/astra-advisor/run-astra-advisor.sh").exists())
            self.assertTrue((tmp_codex / "astra-advisor.config.toml").exists())

            # Repeated install is idempotent and preserves the user's profile.
            target_profile = tmp_codex / "astra-advisor.config.toml"
            customized_profile = target_profile.read_text(encoding="utf-8").replace(
                'model = "gpt-6-astra"', 'model = "gpt-7-astra"'
            )
            target_profile.write_text(customized_profile, encoding="utf-8")
            subprocess.run(["bash", str(installer), "--codex"], env=env, check=True, capture_output=True, text=True)
            self.assertEqual(target_profile.read_text(encoding="utf-8"), customized_profile)

    def test_no_secrets_or_personal_paths(self):
        files_to_check = [
            REPO_ROOT / "skills/astra-advisor/SKILL.md",
            REPO_ROOT / "skills/astra-advisor/codex.config.toml",
            REPO_ROOT / "bin/install-astra-advisor.sh",
        ]
        forbidden_substrings = [
            "/data/data/com.termux",
            "/Users/marcotiongson",
            "ya29.",
            "gho_",
            "ghp_",
            "sk-ant-",
        ]
        for f in files_to_check:
            text = f.read_text(encoding="utf-8")
            for sub in forbidden_substrings:
                self.assertNotIn(sub, text, f"Forbidden substring '{sub}' found in {f.name}")

if __name__ == "__main__":
    unittest.main()
