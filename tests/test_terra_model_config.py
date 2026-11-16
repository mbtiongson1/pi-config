import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


class TestTerraModelConfig(unittest.TestCase):
    def test_terra_agents_configuration(self):
        agents_dir = REPO_ROOT / "agents"
        terra_agents = [
            ("planner-terra.md", "openai-codex/gpt-6.1-terra:max"),
            ("worker-terra.md", "openai-codex/gpt-6.1-terra:medium"),
            ("reviewer.md", "openai-codex/gpt-6.1-terra:high"),
        ]
        for filename, expected_model in terra_agents:
            with self.subTest(agent=filename):
                agent_file = agents_dir / filename
                self.assertTrue(agent_file.exists(), f"Agent file missing: {agent_file}")
                content = agent_file.read_text(encoding="utf-8")
                self.assertIn(f"model: {expected_model}", content)

    def test_reviewer_bash_is_verification_only(self):
        # Founder decision 2026-11-16: the reviewer may use bash to verify (git, tests,
        # builds) but must never mutate state. Edit tools stay absent.
        agents_dir = REPO_ROOT / "agents"
        content = (agents_dir / "reviewer.md").read_text(encoding="utf-8")
        self.assertIn("tools: read, grep, find, ls, bash", content)
        for forbidden in ("edit", "write"):
            self.assertNotIn(forbidden + ",", content.split("tools:", 1)[1].splitlines()[0])
        self.assertIn("Bash is for verification only", content)
        self.assertIn("Never modify tracked files, commit, push", content)


if __name__ == "__main__":
    unittest.main()
