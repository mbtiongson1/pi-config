"""Subagent monitor — stale session context guard.

The statusline ticker keeps running for a moment after a session ends (print
mode exit, reload, or session replace). Pi's UI accessors throw on a stale
context, so the ticker used to crash the process after every subagent run.
The monitor must swallow that and stop ticking.
"""

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MONITOR = REPO_ROOT / "extensions" / "subagent-monitor.ts"


class TestSubagentMonitorStaleContext(unittest.TestCase):
    def setUp(self):
        self.source = MONITOR.read_text(encoding="utf-8")

    def test_monitor_exists(self):
        self.assertTrue(MONITOR.is_file())

    def test_update_statusline_is_guarded(self):
        body = self.source.split("function updateStatusline()", 1)[1].split("\n\tfunction ", 1)[0]
        self.assertIn("try {", body, "updateStatusline must guard stale-context UI access")
        self.assertIn("catch", body)
        self.assertIn("currentContext = null", body)

    def test_ticker_stops_when_the_context_is_gone(self):
        body = self.source.split("function syncTicker()", 1)[1].split("\n\tfunction ", 1)[0]
        self.assertIn("if (!currentContext)", body, "the ticker must stop when the session context is gone")
        self.assertIn("clearInterval(ticker)", body)

    def test_monitor_still_reports_active_tasks(self):
        # The guard must not remove the normal statusline behaviour.
        self.assertIn('setStatus("subagent-monitor"', self.source)
        self.assertRegex(self.source, r"function updateStatusline\(\)\s*:\s*void")


if __name__ == "__main__":
    unittest.main()
