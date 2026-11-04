"""Explicit Codex-provider mirrors must preserve the original personas."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / "agents"
EXPECTED = {
    "advisor": "xhigh",
    "advisor-astra": "xhigh",
    "planner": "xhigh",
    "planner-sol": "xhigh",
    "planner-terra": "xhigh",
    "reviewer": "high",
    "scout-luna": "minimal",
    "worker-astra": "medium",
    "worker-luna": "medium",
    "worker-luna-high": "high",
    "worker-sol": "medium",
    "worker-terra": "medium",
    "writer-sol-low": "low",
}


def parse(path):
    raw = path.read_text(encoding="utf-8")
    head, body = raw.split("\n---\n", 1)
    fields = dict(line.split(": ", 1) for line in head.splitlines()[1:] if ": " in line)
    return fields, body


class SharedAgentTests(unittest.TestCase):
    def test_complete_openai_family_has_shared_counterparts(self):
        originals = {
            path.stem for path in AGENTS.glob("*.md")
            if not path.stem.endswith("-shared")
            and parse(path)[0].get("model", "").split("/", 1)[0] in {"openai", "openai-codex"}
        }
        self.assertEqual(originals, set(EXPECTED))
        self.assertEqual({p.stem for p in AGENTS.glob("*-shared.md")},
                         {name + "-shared" for name in EXPECTED})

    def test_provider_persona_effort_and_tools_are_preserved(self):
        for name, effort in EXPECTED.items():
            with self.subTest(agent=name):
                source, source_body = parse(AGENTS / (name + ".md"))
                shared, shared_body = parse(AGENTS / (name + "-shared.md"))
                model = "openai-codex/" + source["model"].split("/", 1)[1]
                self.assertEqual(shared["name"], name + "-shared")
                self.assertEqual(shared["model"], model)
                self.assertEqual(shared["thinking"], effort)
                self.assertEqual(shared["role"], source["role"])
                if source["role"] == "advisor":
                    self.assertEqual(shared["tools"], "none")
                    self.assertEqual(shared["spawns"], "false")
                else:
                    self.assertEqual(shared.get("tools"), source.get("tools"))
                self.assertEqual(shared_body, source_body)
                self.assertEqual(shared["fallback_models"], "[" + model + "]")
                self.assertEqual(shared["max_retries"], "0")
                self.assertNotIn("timeout_ms", shared)
                self.assertNotIn("max_turns", shared)
                self.assertNotIn("antigravity/", shared["fallback_models"])

    def test_reviewer_shared_remains_read_only_terra_high(self):
        fields, _ = parse(AGENTS / "reviewer-shared.md")
        self.assertEqual(fields["tools"], "read, grep, find, ls")
        self.assertEqual(fields["model"], "openai-codex/gpt-6.1-terra:high")
        self.assertEqual(fields["thinking"], "high")


if __name__ == "__main__":
    unittest.main()
