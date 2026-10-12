"""Engineering-discipline contract: installer, workflow prompts, and Pi loading."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
INSTALLER = REPO / "bin" / "install-append-system.sh"
CONTRACT = (REPO / "APPEND_SYSTEM.md").read_text()
BEGIN, END = "<!-- pi-config:begin -->", "<!-- pi-config:end -->"
PI_DIST = Path(os.environ.get(
    "PI_DIST",
    Path.home() / ".pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist",
))


def install(dest):
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(dest)}
    return subprocess.run(["bash", str(INSTALLER)], env=env, capture_output=True, text=True)


class InstallerTests(unittest.TestCase):
    def test_contract_is_small(self):
        self.assertLess(len(CONTRACT.split()), 160)

    def test_fresh_install_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td) / "agent"
            for _ in range(3):
                r = install(dest)
                self.assertEqual(r.returncode, 0, r.stderr)
            text = (dest / "APPEND_SYSTEM.md").read_text()
            self.assertEqual(text, f"{BEGIN}\n{CONTRACT.rstrip(chr(10))}\n{END}\n")
            self.assertEqual(text.count("Engineering Discipline"), 1)
            self.assertIn("already current", r.stdout)
            self.assertFalse((dest / "SYSTEM.md").exists())

    def test_preserves_user_text_and_refreshes_block(self):
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td)
            target = dest / "APPEND_SYSTEM.md"
            target.write_text("# Mine\nkeep me\n")
            self.assertEqual(install(dest).returncode, 0)
            # Simulate an outdated managed block with user text on both sides.
            stale = target.read_text().replace("Inspect relevant", "OLD") + "after\n"
            target.write_text(stale)
            self.assertEqual(install(dest).returncode, 0)
            text = target.read_text()
            self.assertTrue(text.startswith("# Mine\nkeep me\n"))
            self.assertTrue(text.endswith(f"{END}\nafter\n"))
            self.assertNotIn("OLD", text)
            self.assertEqual(text.count(BEGIN), 1)

    def test_refuses_symlink(self):
        with tempfile.TemporaryDirectory() as td:
            real = Path(td) / "real.md"
            real.write_text("x")
            (Path(td) / "APPEND_SYSTEM.md").symlink_to(real)
            self.assertNotEqual(install(Path(td)).returncode, 0)
            self.assertEqual(real.read_text(), "x")


class PromptTests(unittest.TestCase):
    def test_tiny_tasks_do_not_force_agent_chain(self):
        for name in ("implement.md", "implement-and-review.md"):
            text = (REPO / "prompts" / name).read_text()
            self.assertNotIn("chain parameter", text)
            self.assertRegex(text, r"(?i)tiny/localized")
            self.assertIn("directly", text)

    def test_high_risk_keeps_independent_review(self):
        impl = (REPO / "prompts" / "implement.md").read_text()
        self.assertRegex(impl, r"(?s)high-risk.*parallel.*independent `reviewer`")
        review = (REPO / "prompts" / "implement-and-review.md").read_text()
        self.assertIn("independent `reviewer` subagent that did not write the change", review)


LOADER_JS = r"""
const [dist, agentDir, cwd, append] = process.argv.slice(1);
const { DefaultResourceLoader, SettingsManager } = await import(dist + "/index.js");
const { buildSystemPrompt } = await import(dist + "/core/system-prompt.js");
const settingsManager = SettingsManager.inMemory ? SettingsManager.inMemory() : undefined;
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  appendSystemPrompt: append ? [append] : undefined });
await loader.reload();
const appendText = loader.getAppendSystemPrompt().join("\n\n");
const full = buildSystemPrompt({ cwd, appendSystemPrompt: appendText, selectedTools: ["read"] });
console.log(JSON.stringify({ sources: loader.getAppendSystemPromptSourcePaths?.() ?? null,
  count: full.split("## Engineering Discipline").length - 1 }));
"""


@unittest.skipUnless((PI_DIST / "index.js").exists() and shutil.which("node"), "installed Pi not found")
class PiLoaderTests(unittest.TestCase):
    def load(self, agent_dir, cwd, append=""):
        r = subprocess.run(["node", "--input-type=module", "-e", LOADER_JS, str(PI_DIST),
                            str(agent_dir), str(cwd), append], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout.strip().splitlines()[-1])

    def test_global_contract_loaded_once_and_skipped_by_explicit_append(self):
        with tempfile.TemporaryDirectory() as td:
            agent, cwd = Path(td) / "agent", Path(td) / "proj"
            cwd.mkdir()
            self.assertEqual(install(agent).returncode, 0)
            parent = self.load(agent, cwd)
            self.assertEqual(parent["count"], 1)
            # Named Parke subagents pass --append-system-prompt <persona>, which
            # replaces APPEND_SYSTEM.md discovery in Pi 1.1.0.
            persona = Path(td) / "persona.md"
            persona.write_text("You are a worker.")
            self.assertEqual(self.load(agent, cwd, str(persona))["count"], 0)


if __name__ == "__main__":
    unittest.main()
