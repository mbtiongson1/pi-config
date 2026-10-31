import json
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


class TestArgonModelConfig(unittest.TestCase):
    def test_argon_agents(self):
        agents_dir = REPO_ROOT / "agents"
        argon_agents = [
            ("worker-argon.md", "antigravity/gemini-4-argon:medium"),
            ("planner-argon.md", "antigravity/gemini-4-argon:max"),
            ("advisor-argon.md", "antigravity/gemini-4-argon:max"),
        ]
        for filename, expected_model in argon_agents:
            with self.subTest(agent=filename):
                agent_file = agents_dir / filename
                self.assertTrue(agent_file.exists(), f"Agent file missing: {agent_file}")
                content = agent_file.read_text(encoding="utf-8")
                self.assertIn(f"model: {expected_model}", content)

    def test_argon_model_metadata(self):
        template = REPO_ROOT / "models.json.template"
        tpl_data = json.loads(template.read_text(encoding="utf-8"))
        for provider in ["antigravity", "google-antigravity"]:
            with self.subTest(provider=provider):
                overrides = tpl_data["providers"][provider]["modelOverrides"]
                self.assertIn("gemini-4-argon", overrides)
                argon = overrides["gemini-4-argon"]
                self.assertEqual(argon["contextWindow"], 1048576)
                self.assertEqual(argon["maxTokens"], 65536)

    def test_argon_enabled_in_settings_template(self):
        settings = json.loads((REPO_ROOT / "settings.json.template").read_text(encoding="utf-8"))
        self.assertIn("npm:pi-antigravity", settings["packages"])
        self.assertIn("antigravity/gemini-4-argon", settings["enabledModels"])


if __name__ == "__main__":
    unittest.main()
