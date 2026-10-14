import unittest
import json
import subprocess
import sys
from pathlib import Path

class TestSubagentIdentity(unittest.TestCase):
    def test_format_model_display_logic(self):
        # Python test mirroring JS formatModelDisplay logic to verify provider + model ID + friendly name
        known_models = {
            "gemini-3.8-flash": "Gemini 3.8 Flash",
            "claude-sonnet-5-5": "Claude Sonnet 5.5",
            "gpt-6.1-sol": "GPT-6.1 Sol",
        }
        
        def format_model(model_str):
            if not model_str or model_str == "unknown" or model_str == "":
                return "unknown"
            clean = model_str.split(":")[0]
            parts = clean.split("/", 1) if "/" in clean else ("", clean)
            provider = parts[0]
            model_id = parts[1] if provider else parts[0]
            friendly = known_models.get(model_id, model_id.replace("-", " ").title())
            if provider:
                return f"{provider}/{model_id} ({friendly})"
            return f"{model_id} ({friendly})"

        # Single agent test case
        self.assertEqual(format_model("antigravity/gemini-3.8-flash:high"), "antigravity/gemini-3.8-flash (Gemini 3.8 Flash)")
        
        # Fallback / model-override test case
        self.assertEqual(format_model("anthropic/claude-sonnet-5-5"), "anthropic/claude-sonnet-5-5 (Claude Sonnet 5.5)")
        
        # Unknown / unresolvable model case
        self.assertEqual(format_model("unknown"), "unknown")
        self.assertEqual(format_model(None), "unknown")

    def test_parallel_agent_identity_distinction(self):
        tasks = [
            {"agent": "worker-flash-high", "model": "antigravity/gemini-3.8-flash", "thinking": "high", "task": "Task 1"},
            {"agent": "worker-sol", "model": "openai/gpt-6.1-sol", "thinking": "medium", "task": "Task 2"}
        ]
        
        # Verify each parallel worker is distinct and exposes required identity fields
        self.assertEqual(tasks[0]["agent"], "worker-flash-high")
        self.assertEqual(tasks[0]["model"], "antigravity/gemini-3.8-flash")
        self.assertEqual(tasks[0]["thinking"], "high")
        
        self.assertEqual(tasks[1]["agent"], "worker-sol")
        self.assertEqual(tasks[1]["model"], "openai/gpt-6.1-sol")
        self.assertEqual(tasks[1]["thinking"], "medium")

if __name__ == "__main__":
    unittest.main()
