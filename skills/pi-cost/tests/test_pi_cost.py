"""Focused pricing and provenance regressions for pi-cost (no network)."""
import importlib.util
import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "scripts" / "pi_cost.py"
spec = importlib.util.spec_from_file_location("pi_cost", MODULE)
cost = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cost)
NOW = datetime(2026, 9, 25, 20, 0, tzinfo=timezone.utc)


def catalog(date=NOW):
    return {
        "_meta": {"fetched_at": date.strftime("%Y-%m-%dT%H:%M:%SZ")},
        "gemini/gemini-3.8-flash": {"input": 7.5e-7, "output": 3.75e-6,
                                    "cache_read": 7.5e-8, "cache_write": None},
        "gpt-6-luna": {"input": 1e-7, "output": 5e-7,
                        "cache_read": 1e-8, "cache_write": 1.25e-7},
    }


class PriceTests(unittest.TestCase):
    def test_worker_all_four_components_at_explicit_rates(self):
        usage = {"input": 1_000_000, "output": 1_000_000,
                 "cacheRead": 1_000_000, "cacheWrite": 1_000_000}
        priced = cost.price_worker(usage, "openai-codex/gpt-6-luna:xhigh", catalog())
        self.assertEqual(priced["model_key"], "gpt-6-luna")
        self.assertAlmostEqual(priced["parts"]["input"], .1)
        self.assertAlmostEqual(priced["parts"]["output"], .5)
        self.assertAlmostEqual(priced["parts"]["cacheRead"], .01)
        self.assertAlmostEqual(priced["parts"]["cacheWrite"], .125)
        self.assertAlmostEqual(priced["total"], .735)

    def test_flash_exact_cache_read_and_missing_cache_write_fail_closed(self):
        usage = {"input": 1_000_000, "output": 1_000_000, "cacheRead": 1_000_000}
        flash = cost.price_worker(usage, "antigravity/gemini-3.8-flash:medium", catalog())
        self.assertEqual(flash["model_key"], "gemini/gemini-3.8-flash")
        self.assertAlmostEqual(flash["parts"]["cacheRead"], .075)
        self.assertAlmostEqual(flash["total"], 4.575)
        usage["cacheWrite"] = 1
        flash = cost.price_worker(usage, "antigravity/gemini-3.8-flash:medium", catalog())
        self.assertIsNone(flash["total"])
        self.assertEqual(flash["unpriced"], ["cacheWrite"])

    def test_unknown_variant_not_guessed(self):
        self.assertIsNone(cost.price_worker({"input": 1}, "openrouter/gemini-3.8-flash:batch", catalog())["total"])
        self.assertIsNone(cost.price_worker({"input": 1}, "antigravity/gemini-3.8-flash:unknown", catalog())["total"])
        self.assertIsNone(cost.price_worker({"input": -1}, "openai-codex/gpt-6-luna:xhigh", catalog())["total"])

    def test_main_logged_cost_unchanged_and_all_parallel_and_nested_results(self):
        child = {"agent": "child", "model": "openai-codex/gpt-6-luna:medium", "task": "graph",
                 "exitCode": 0, "usage": {"input": 1_000_000, "cacheRead": 1_000_000, "turns": 2, "cost": .01}}
        direct = {"agent": "worker", "model": "antigravity/gemini-3.8-flash:medium", "task": "graph",
                  "exitCode": 0, "usage": {"input": 1_000_000, "cacheRead": 1_000_000, "turns": 3, "cost": .01},
                  "messages": [{"role": "toolResult", "toolName": "subagent", "toolCallId": "nested-1",
                                "details": {"results": [child]}}]}
        second = {**direct, "messages": [], "agent": "second", "task": "lifecycle"}
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "main.jsonl"
            records = [
                {"message": {"role": "assistant", "model": "gpt-6-sol", "provider": "openai-codex",
                             "content": [{"type": "text", "text": "x"}],
                             "usage": {"input": 5, "output": 2, "cost": {"total": 11.0}}}},
                {"message": {"role": "assistant", "model": "gpt-6-sol", "provider": "openai-codex",
                             "content": [{"type": "toolCall"}],
                             "usage": {"input": 0, "output": 0, "cacheRead": 0,
                                       "cost": {"total": 0}}}},
                {"message": {"role": "toolResult", "toolName": "subagent",
                             "details": {"results": [direct, second]}}},
            ]
            path.write_text("\n".join(json.dumps(x) for x in records))
            report = cost.report_session(path, catalog())
        self.assertEqual(report["main"]["logged_cost"], 11.0)
        self.assertFalse(report["main"]["cost_missing"])
        self.assertEqual(len(report["direct"]), 2)
        self.assertEqual(len(report["nested"]), 1)
        self.assertAlmostEqual(report["worker_priced_usd"], 2 * .825 + .11)
        self.assertAlmostEqual(report["total_usd"], 11 + 2 * .825 + .11)

    def test_seven_day_staleness_uses_meta_even_when_mtime_new(self):
        old = catalog(NOW - timedelta(days=8))
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "prices.json"
            path.write_text(json.dumps(old))  # fresh file, but old embedded fetch date
            with patch.object(cost, "refresh_prices", return_value=catalog()) as fetch:
                _, stale = cost.load_prices(path, now=NOW)
                fetch.assert_called_once()
                self.assertFalse(stale)
            with patch.object(cost, "refresh_prices", side_effect=AssertionError("offline fetched")):
                _, stale = cost.load_prices(path, now=NOW, offline=True)
                self.assertTrue(stale)

    def test_refresh_validates_and_replaces_atomically(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "prices.json"
            old = catalog(NOW - timedelta(days=8))
            path.write_text(json.dumps(old))
            fresh = {f"test-{i}": {"input_cost_per_token": .1} for i in range(100)}
            fresh["gpt-6-luna"] = {"input_cost_per_token": 1e-7, "cache_read_input_token_cost": 1e-8}
            fresh["gemini/gemini-3.8-flash"] = {"input_cost_per_token": 7.5e-7,
                                                   "cache_read_input_token_cost": 7.5e-8}
            with patch.object(cost.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(fresh).encode())):
                updated = cost.refresh_prices(path, now=NOW)
            self.assertEqual(updated["_meta"]["fetched_at"], "2026-09-25T20:00:00Z")
            self.assertEqual(json.loads(path.read_text())["gpt-6-luna"]["cache_read"], 1e-8)
            with patch.object(cost.urllib.request, "urlopen", return_value=io.BytesIO(b"{}")):
                with self.assertRaisesRegex(ValueError, "incomplete"):
                    cost.refresh_prices(path, now=NOW)
            self.assertEqual(json.loads(path.read_text())["_meta"]["fetched_at"], "2026-09-25T20:00:00Z")

    def test_forced_refresh_failure_is_not_silent(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "prices.json"
            path.write_text(json.dumps(catalog()))
            with patch.object(cost, "refresh_prices", side_effect=OSError("offline")):
                with self.assertRaisesRegex(ValueError, "forced price refresh failed"):
                    cost.load_prices(path, now=NOW, force=True)


if __name__ == "__main__":
    unittest.main()
