import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


class TestSonnetOpusModelConfig(unittest.TestCase):
    def test_opus_agents_use_anthropic(self):
        agents_dir = REPO_ROOT / "agents"
        opus_agents = [
            ("planner-opus.md", "anthropic/claude-opus-5-5:high"),
            ("worker-opus.md", "anthropic/claude-opus-5-5:medium"),
            ("worker-opus-low.md", "anthropic/claude-opus-5-5:low"),
            ("worker-opus-medium.md", "anthropic/claude-opus-5-5:medium"),
            ("worker-opus-high.md", "anthropic/claude-opus-5-5:high"),
        ]
        for filename, expected_model in opus_agents:
            with self.subTest(agent=filename):
                agent_file = agents_dir / filename
                self.assertTrue(agent_file.exists(), f"Agent file missing: {agent_file}")
                content = agent_file.read_text(encoding="utf-8")
                self.assertIn(f"model: {expected_model}", content)

    def test_sonnet_agents_configuration(self):
        agents_dir = REPO_ROOT / "agents"
        sonnet_agents = [
            ("worker-sonnet.md", "antigravity/claude-sonnet-5-5"),
            ("worker-sonnet-low.md", "anthropic/claude-sonnet-5-5:low"),
            ("worker-sonnet-medium.md", "anthropic/claude-sonnet-5-5:medium"),
            ("worker-sonnet-high.md", "antigravity/claude-sonnet-5-5"),
        ]
        for filename, expected_model in sonnet_agents:
            with self.subTest(agent=filename):
                agent_file = agents_dir / filename
                self.assertTrue(agent_file.exists(), f"Agent file missing: {agent_file}")
                content = agent_file.read_text(encoding="utf-8")
                self.assertIn(f"model: {expected_model}", content)


if __name__ == "__main__":
    unittest.main()
