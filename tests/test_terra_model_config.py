import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


class TestTerraModelConfig(unittest.TestCase):
    def test_terra_agents_configuration(self):
        agents_dir = REPO_ROOT / "agents"
        terra_agents = [
            ("planner-terra.md", "openai/gpt-5.6-terra:max"),
            ("worker-terra.md", "openai/gpt-5.6-terra:medium"),
            ("worker-terra-low.md", "openai/gpt-5.6-terra:low"),
            ("worker-terra-high.md", "openai/gpt-5.6-terra:high"),
            ("worker-terra-xhigh.md", "openai/gpt-5.6-terra:xhigh"),
            ("worker-terra-max.md", "openai/gpt-5.6-terra:max"),
        ]
        for filename, expected_model in terra_agents:
            with self.subTest(agent=filename):
                agent_file = agents_dir / filename
                self.assertTrue(agent_file.exists(), f"Agent file missing: {agent_file}")
                content = agent_file.read_text(encoding="utf-8")
                self.assertIn(f"model: {expected_model}", content)


if __name__ == "__main__":
    unittest.main()
