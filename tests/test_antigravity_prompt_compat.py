"""Portable Node regression tests for the Antigravity prompt compatibility hook."""
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


class AntigravityPromptCompatibilityTests(unittest.TestCase):
    def test_node_regressions(self):
        result = subprocess.run(
            ["node", "--experimental-strip-types", "--test", "tests/antigravity-prompt-compat.test.mjs"],
            cwd=REPO, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
