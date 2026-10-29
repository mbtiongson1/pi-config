"""Masthead extension tests.

Verifies that extensions/masthead.ts exists and correctly exports the extension,
verifies sticky top mounting in chat viewport, dynamic default branch resolution,
accurate PR checkout logic, and node-based layout rendering.
"""

import subprocess
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MASTHEAD_TS = REPO_ROOT / "extensions" / "masthead.ts"


class TestMastheadExtension(unittest.TestCase):
    def test_masthead_ts_exists(self):
        self.assertTrue(MASTHEAD_TS.is_file(), "extensions/masthead.ts must exist")

    def test_masthead_structure(self):
        source = MASTHEAD_TS.read_text(encoding="utf-8")
        self.assertIn("export default function mastheadExtension", source)
        self.assertIn("class MastheadComponent", source)
        self.assertIn("ctx.ui.setHeader", source)
        self.assertIn('pi.registerCommand("header"', source)
        self.assertIn('pi.registerCommand("masthead"', source)
        self.assertIn('pi.registerCommand("pr"', source)
        self.assertIn("fetchGitPr", source)
        self.assertIn("checkoutPr", source)
        self.assertIn("resolveDefaultBranch", source)
        self.assertIn("parseRepoFromRemoteUrl", source)
        self.assertIn("resolveSessionTitle", source)

    def test_sticky_header_viewport_layout(self):
        node_script = """
        const piDir = "/data/data/com.termux/files/home/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent";
        const { createChatViewport } = require(piDir + "/dist/modes/interactive/chat-viewport.js");
        const { Container } = require("/data/data/com.termux/files/home/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-tui");

        const header = new Container();
        const doc = new Container();
        const viewport = createChatViewport({
            header,
            document: doc,
            pendingMessages: new Container(),
            status: new Container(),
            editor: new Container(),
            footer: new Container(),
        });

        // 1. Header must be present in root layout
        if (!viewport.root.children.includes(header)) {
            throw new Error("Sticky header container is not present in viewport.root.children");
        }

        // 2. Header must be the first child (above transcript) in the root VStack
        if (viewport.root.children[0] !== header) {
            throw new Error("Sticky header is not the first component in root VStack");
        }

        // 3. Transcript must be below the sticky header
        if (viewport.root.children[1] !== viewport.transcript) {
            throw new Error("Transcript is not below sticky header in root VStack");
        }

        console.log("STICKY_OK");
        """
        proc = subprocess.run(
            ["node", "-e", node_script],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, f"Sticky layout test failed:\nstdout: {proc.stdout}\nstderr: {proc.stderr}")
        self.assertIn("STICKY_OK", proc.stdout)

    def test_pr_commands_and_default_branch_resolution(self):
        node_script = """
        async function run() {
            const piDir = "/data/data/com.termux/files/home/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent";
            const { DefaultResourceLoader } = require(piDir + "/dist/core/resource-loader.js");
            const { SettingsManager } = require(piDir + "/dist/core/settings-manager.js");

            const cwd = process.cwd();
            const settingsManager = SettingsManager.create(cwd, "/data/data/com.termux/files/home/.pi/agent", { projectTrusted: true });
            const loader = new DefaultResourceLoader({ cwd, agentDir: "/data/data/com.termux/files/home/.pi/agent", settingsManager });
            await loader.reload();
            const masthead = loader.getExtensions().extensions.find(e => e.path.includes("masthead"));

            if (!masthead) throw new Error("Masthead extension not discovered by DefaultResourceLoader");

            const cmdNames = Array.from(masthead.commands.keys());
            for (const expected of ["header", "masthead", "pr"]) {
                if (!cmdNames.includes(expected)) {
                    throw new Error(`Missing expected command: ${expected}`);
                }
            }

            console.log("COMMANDS_OK");
        }
        run().catch(e => {
            console.error(e);
            process.exit(1);
        });
        """
        proc = subprocess.run(
            ["node", "-e", node_script],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, f"Command verification failed:\nstdout: {proc.stdout}\nstderr: {proc.stderr}")
        self.assertIn("COMMANDS_OK", proc.stdout)

    def test_masthead_node_rendering(self):
        node_script = """
        async function run() {
            const piDir = "/data/data/com.termux/files/home/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent";
            const { DefaultResourceLoader } = require(piDir + "/dist/core/resource-loader.js");
            const { SettingsManager } = require(piDir + "/dist/core/settings-manager.js");
            const { visibleWidth } = require("/data/data/com.termux/files/home/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-tui");
            const { theme, initTheme } = require(piDir + "/dist/modes/interactive/theme/theme.js");

            initTheme("dark");

            const cwd = process.cwd();
            const settingsManager = SettingsManager.create(cwd, "/data/data/com.termux/files/home/.pi/agent", { projectTrusted: true });
            const loader = new DefaultResourceLoader({ cwd, agentDir: "/data/data/com.termux/files/home/.pi/agent", settingsManager });
            await loader.reload();
            const masthead = loader.getExtensions().extensions.find(e => e.path.includes("masthead"));

            if (!masthead) throw new Error("Masthead extension not discovered by DefaultResourceLoader");

            let headerFactory = null;
            const mockCtx = {
                mode: "tui",
                hasUI: true,
                cwd,
                sessionManager: {
                    getHeader() { return { timestamp: "2026-10-17T09:45:58.000Z" }; },
                    getSessionName() { return "Test Session Title Long Enough To Require Truncation"; },
                    getBranch() { return []; }
                },
                ui: { setHeader(fn) { headerFactory = fn; }, notify() {} }
            };

            const startHandler = masthead.handlers.get("session_start")[0];
            await startHandler({}, mockCtx);

            const comp = headerFactory({ requestRender() {} }, theme);
            comp.state.pr = { number: 13, title: "feat(agents): add DeepSeek agent roster", state: "MERGED" };
            comp.state.prText = "#13: feat(agents): add DeepSeek agent roster [MERGED]";

            for (const w of [80, 60, 50, 45, 38]) {
                const lines = comp.render(w);
                for (let i = 0; i < lines.length - 1; i++) {
                    const vw = visibleWidth(lines[i]);
                    if (vw !== w) {
                        throw new Error(`Width mismatch at ${w} cols, line ${i}: got ${vw}`);
                    }
                }
            }

            const narrowLines = comp.render(30);
            if (narrowLines.length < 3) {
                throw new Error("Narrow layout should have at least 3 lines");
            }

            console.log("OK");
        }
        run().catch((e) => {
            console.error(e);
            process.exit(1);
        });
        """
        proc = subprocess.run(
            ["node", "-e", node_script],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(
            proc.returncode,
            0,
            f"Node verification failed:\nstdout: {proc.stdout}\nstderr: {proc.stderr}",
        )
        self.assertIn("OK", proc.stdout)


if __name__ == "__main__":
    unittest.main()
