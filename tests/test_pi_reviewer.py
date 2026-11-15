import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "bin" / "pi-reviewer"


def make_fake_pi(directory: Path, body: str) -> Path:
    fake_pi = directory / "fake-pi"
    fake_pi.write_text(f"#!/usr/bin/env python3\n{body}\n", encoding="utf-8")
    fake_pi.chmod(fake_pi.stat().st_mode | stat.S_IXUSR)
    return fake_pi


class TestPiReviewer(unittest.TestCase):
    def test_script_is_executable(self):
        self.assertTrue(SCRIPT_PATH.is_file(), "bin/pi-reviewer must exist")
        self.assertTrue(os.access(SCRIPT_PATH, os.X_OK), "bin/pi-reviewer must be executable")

    def test_sync_invocation_uses_default_reviewer_agent(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            agent_dir = tmp_path / "agent"
            (agent_dir / "agents").mkdir(parents=True)
            (agent_dir / "agents" / "reviewer.md").write_text(
                "---\n"
                "name: reviewer\n"
                "model: openai-codex/gpt-6.1-terra:high\n"
                "thinking: high\n"
                "tools: read, grep, find, ls\n"
                "---\n\n"
                "You are the test reviewer.\n",
                encoding="utf-8",
            )
            fake_pi = make_fake_pi(
                tmp_path,
                "import json, sys\nprint(json.dumps(sys.argv[1:]))\n",
            )

            env = os.environ.copy()
            env["PI_CODING_AGENT_DIR"] = str(agent_dir)
            env["PI_BIN"] = str(fake_pi)
            env["PI_REVIEWER_STATE_DIR"] = str(tmp_path / "state")

            proc = subprocess.run(
                [str(SCRIPT_PATH), "--json", "Review my diff"],
                env=env,
                cwd=tmp_path,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["status"], "completed")
            self.assertEqual(payload["agent"], "reviewer")
            self.assertEqual(payload["model"], "openai-codex/gpt-6.1-terra:high")
            self.assertEqual(payload["thinking"], "high")
            self.assertEqual(payload["tools"], "read,grep,find,ls")

            argv = json.loads(payload["result"])
            self.assertIn("-p", argv)
            self.assertIn("--no-session", argv)
            self.assertIn("--no-extensions", argv)
            self.assertIn("--model", argv)
            self.assertEqual(argv[argv.index("--model") + 1], "openai-codex/gpt-6.1-terra:high")
            self.assertEqual(argv[argv.index("--thinking") + 1], "high")
            self.assertEqual(argv[argv.index("--tools") + 1], "read,grep,find,ls")
            self.assertEqual(argv[argv.index("--system-prompt") + 1], "You are the test reviewer.")
            self.assertEqual(argv[-2:], ["--", "Review my diff"])

    def test_stdin_and_prompt_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            fake_pi = make_fake_pi(
                tmp_path,
                "import sys\nprint('GOT:' + sys.argv[-1])\n",
            )
            env = os.environ.copy()
            env["PI_CODING_AGENT_DIR"] = str(tmp_path / "missing-agent-dir")
            env["PI_BIN"] = str(fake_pi)

            proc_stdin = subprocess.run(
                [str(SCRIPT_PATH), "-"],
                input="Brief from stdin\n",
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(proc_stdin.returncode, 0, proc_stdin.stderr)
            self.assertEqual(proc_stdin.stdout.strip(), "GOT:Brief from stdin")

            brief_file = tmp_path / "brief.txt"
            brief_file.write_text("Brief from file\n", encoding="utf-8")
            proc_file = subprocess.run(
                [str(SCRIPT_PATH), "--prompt-file", str(brief_file)],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(proc_file.returncode, 0, proc_file.stderr)
            self.assertEqual(proc_file.stdout.strip(), "GOT:Brief from file")

    def test_background_start_wait_result_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            fake_pi = make_fake_pi(
                tmp_path,
                "import sys, time\ntime.sleep(0.2)\nprint('## Status\\nclean\\n\\nBrief: ' + sys.argv[-1])\n",
            )
            env = os.environ.copy()
            env["PI_CODING_AGENT_DIR"] = str(tmp_path / "missing-agent-dir")
            env["PI_BIN"] = str(fake_pi)
            env["PI_REVIEWER_STATE_DIR"] = str(tmp_path / "state")

            start_proc = subprocess.run(
                [str(SCRIPT_PATH), "--bg", "--json", "Check auth.ts"],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(start_proc.returncode, 0, start_proc.stderr)
            receipt = json.loads(start_proc.stdout)
            job_id = receipt["id"]
            self.assertIn(receipt["status"], {"starting", "running", "completed"})

            wait_proc = subprocess.run(
                [str(SCRIPT_PATH), "wait", job_id, "--timeout", "10", "--json"],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(wait_proc.returncode, 0, wait_proc.stderr)
            wait_data = json.loads(wait_proc.stdout)
            self.assertEqual(wait_data["status"], "completed")
            self.assertIn("## Status", wait_data["result"])
            self.assertIn("Brief: Check auth.ts", wait_data["result"])

            result_proc = subprocess.run(
                [str(SCRIPT_PATH), "result", job_id],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result_proc.returncode, 0, result_proc.stderr)
            self.assertIn("Brief: Check auth.ts", result_proc.stdout)

            list_proc = subprocess.run(
                [str(SCRIPT_PATH), "list", "--json"],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(list_proc.returncode, 0, list_proc.stderr)
            listed = json.loads(list_proc.stdout)
            self.assertEqual(len(listed), 1)
            self.assertEqual(listed[0]["id"], job_id)

    def test_background_kill(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            fake_pi = make_fake_pi(
                tmp_path,
                "import time\ntime.sleep(30)\n",
            )
            env = os.environ.copy()
            env["PI_CODING_AGENT_DIR"] = str(tmp_path / "missing-agent-dir")
            env["PI_BIN"] = str(fake_pi)
            env["PI_REVIEWER_STATE_DIR"] = str(tmp_path / "state")

            start_proc = subprocess.run(
                [str(SCRIPT_PATH), "start", "--json", "Long review"],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(start_proc.returncode, 0, start_proc.stderr)
            job_id = json.loads(start_proc.stdout)["id"]
            time.sleep(0.2)

            kill_proc = subprocess.run(
                [str(SCRIPT_PATH), "kill", job_id],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(kill_proc.returncode, 0, kill_proc.stderr)
            self.assertIn("status=killed", kill_proc.stdout)


if __name__ == "__main__":
    unittest.main()
