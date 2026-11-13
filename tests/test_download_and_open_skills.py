import importlib.util
import json
from pathlib import Path
import re
import unittest
import jsonschema

REPO_ROOT = Path(__file__).resolve().parents[1]
SKILLS_DIR = REPO_ROOT / "skills"
PROMPTS_DIR = REPO_ROOT / "prompts"
TEMPLATES_DIR = REPO_ROOT / "device-profiles" / "templates"
SCHEMA_PATH = REPO_ROOT / "device-profiles" / "schema.json"


def load_module_from_path(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_frontmatter(path: Path) -> dict:
    content = path.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n", content, re.S)
    if not match:
        return {}
    fields = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip().strip('"').strip("'")
    return fields


class TestDownloadAndOpenSkills(unittest.TestCase):
    def test_skills_frontmatter_and_presence(self):
        open_skill = SKILLS_DIR / "open" / "SKILL.md"
        self.assertTrue(open_skill.is_file(), "skills/open/SKILL.md must exist")
        fm_open = read_frontmatter(open_skill)
        self.assertEqual(fm_open.get("name"), "open")
        self.assertTrue(bool(fm_open.get("description")), "open skill must have description")

        download_skill = SKILLS_DIR / "download" / "SKILL.md"
        self.assertTrue(download_skill.is_file(), "skills/download/SKILL.md must exist")
        fm_dl = read_frontmatter(download_skill)
        self.assertEqual(fm_dl.get("name"), "download")
        self.assertTrue(bool(fm_dl.get("description")), "download skill must have description")

    def test_prompts_frontmatter_and_presence(self):
        open_prompt = PROMPTS_DIR / "open.md"
        self.assertTrue(open_prompt.is_file(), "prompts/open.md must exist")
        fm_open = read_frontmatter(open_prompt)
        self.assertTrue(bool(fm_open.get("description")), "open prompt must have description")
        self.assertTrue("argument-hint" in fm_open, "open prompt must declare argument-hint")

        download_prompt = PROMPTS_DIR / "download.md"
        self.assertTrue(download_prompt.is_file(), "prompts/download.md must exist")
        fm_dl = read_frontmatter(download_prompt)
        self.assertTrue(bool(fm_dl.get("description")), "download prompt must have description")
        self.assertTrue("argument-hint" in fm_dl, "download prompt must declare argument-hint")

        queue_prompt = PROMPTS_DIR / "queue.md"
        self.assertTrue(queue_prompt.is_file(), "prompts/queue.md must exist")
        fm_queue = read_frontmatter(queue_prompt)
        self.assertTrue(bool(fm_queue.get("description")), "queue prompt must have description")
        self.assertTrue("argument-hint" in fm_queue, "queue prompt must declare argument-hint")

    def test_queue_script_and_extension_presence(self):
        queue_py = SKILLS_DIR / "download" / "scripts" / "queue.py"
        self.assertTrue(queue_py.is_file(), "skills/download/scripts/queue.py must exist")

        queue_ext = REPO_ROOT / "extensions" / "queue.ts"
        self.assertTrue(queue_ext.is_file(), "extensions/queue.ts must exist")

    def test_queue_smart_parsing(self):
        queue_py = SKILLS_DIR / "download" / "scripts" / "queue.py"
        mod = load_module_from_path("queue_script", queue_py)

        # User's example: /queue Dark item 06 1080p
        r1 = mod.parse_queue_entry("Dark item 06 1080p")
        self.assertEqual(r1["query"], "Dark item")
        self.assertEqual(r1["episode"], "6")
        self.assertEqual(r1["resolution"], "1080p")
        self.assertFalse(r1["is_url"])

        # Omitted resolution defaults to 1080p
        r2 = mod.parse_queue_entry("Dark item 06")
        self.assertEqual(r2["query"], "Dark item")
        self.assertEqual(r2["episode"], "6")
        self.assertEqual(r2["resolution"], "1080p")

        # Range
        r3 = mod.parse_queue_entry("Dark item 01-03 1080p")
        self.assertEqual(r3["query"], "Dark item")
        self.assertEqual(r3["episode"], "01-03")
        self.assertEqual(r3["resolution"], "1080p")

        # S02E06
        r4 = mod.parse_queue_entry("Dark item S02E06 1080p")
        self.assertEqual(r4["query"], "Dark item S02")
        self.assertEqual(r4["episode"], "6")
        self.assertEqual(r4["resolution"], "1080p")

        # Direct URL
        r5 = mod.parse_queue_entry("https://example.com/file.torrent")
        self.assertTrue(r5["is_url"])
        self.assertEqual(r5["query"], "https://example.com/file.torrent")

    def test_queue_lifecycle_and_crud(self):
        queue_py = SKILLS_DIR / "download" / "scripts" / "queue.py"
        mod = load_module_from_path("queue_script_crud", queue_py)
        import tempfile
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as tmpdir:
            qpath = Path(tmpdir) / "test_queue.json"

            # 1. Initially empty
            init_list = mod.list_queue(qpath)
            self.assertEqual(init_list["total_count"], 0)
            self.assertEqual(init_list["pending_count"], 0)

            # 2. Add first item
            add1 = mod.add_to_queue("Dark item 06 1080p", qpath)
            self.assertTrue(add1["success"])
            self.assertEqual(add1["action"], "added")
            self.assertEqual(add1["item"]["id"], 1)
            self.assertEqual(add1["pending_count"], 1)

            # 3. Duplicate check
            add_dup = mod.add_to_queue("Dark item 06 1080p", qpath)
            self.assertTrue(add_dup["success"])
            self.assertEqual(add_dup["action"], "already_queued")
            self.assertEqual(add_dup["pending_count"], 1)

            # 4. Add second item
            add2 = mod.add_to_queue('"Just Because!" 01-03 1080p', qpath)
            self.assertTrue(add2["success"])
            self.assertEqual(add2["item"]["id"], 2)
            self.assertEqual(add2["pending_count"], 2)

            # 5. List items
            q_list = mod.list_queue(qpath)
            self.assertEqual(q_list["total_count"], 2)
            self.assertEqual(q_list["pending_count"], 2)

            # 6. Remove item 1
            rm1 = mod.remove_from_queue(1, qpath)
            self.assertTrue(rm1["success"])
            self.assertEqual(rm1["remaining_count"], 1)

            # 7. Start downloads mock
            with patch.object(mod, "download_with_kura", return_value={"success": True, "results": []}) as mock_dl:
                start_res = mod.start_queue_downloads(queue_path=qpath)
                self.assertTrue(start_res["success"])
                self.assertEqual(start_res["completed"], 1)
                self.assertEqual(start_res["failed"], 0)
                mock_dl.assert_called_once()

            # 8. Queue status after execution
            after_exec = mod.list_queue(qpath)
            self.assertEqual(after_exec["pending_count"], 0)
            self.assertEqual(after_exec["completed_count"], 1)

            # 9. Clear completed items
            clr = mod.clear_queue(clear_all=False, queue_path=qpath)
            self.assertTrue(clr["success"])
            self.assertEqual(clr["cleared_count"], 1)
            self.assertEqual(clr["remaining_count"], 0)

    def test_device_profile_templates_schema_validation(self):
        self.assertTrue(SCHEMA_PATH.is_file(), "device-profiles/schema.json must exist")
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

        expected_templates = [
            "android-termux.example.json",
            "macos-apple-silicon.example.json",
            "linux-desktop.example.json",
            "windows-wsl.example.json",
            "device-profile.example.json",
        ]
        for name in expected_templates:
            tpl_path = TEMPLATES_DIR / name
            self.assertTrue(tpl_path.is_file(), f"Template missing: {name}")
            data = json.loads(tpl_path.read_text(encoding="utf-8"))
            jsonschema.validate(instance=data, schema=schema)
            self.assertEqual(data.get("version"), 1)
            self.assertTrue(bool(data.get("device", {}).get("platform")))

    def test_open_script_preflight(self):
        open_py = SKILLS_DIR / "open" / "scripts" / "open.py"
        self.assertTrue(open_py.is_file())
        mod = load_module_from_path("open_script", open_py)

        preflight = mod.run_preflight()
        self.assertIn("platform", preflight)
        self.assertIn("opener_binary", preflight)
        self.assertIn("opener_available", preflight)
        self.assertIn("ready", preflight)
        self.assertIn("downloads_dirs", preflight)

        # Platform download dirs
        for p in ("termux", "darwin", "linux", "wsl"):
            dirs = mod.get_default_downloads_dirs(p)
            self.assertGreaterEqual(len(dirs), 1, f"Expected download dirs for platform: {p}")

    def test_download_script_preflight_and_parsing(self):
        dl_py = SKILLS_DIR / "download" / "scripts" / "download.py"
        self.assertTrue(dl_py.is_file())
        mod = load_module_from_path("dl_script", dl_py)

        preflight = mod.run_preflight()
        self.assertIn("platform", preflight)
        self.assertIn("primary_destination", preflight)
        self.assertIn("disk_free_gb", preflight)
        self.assertIn("ready", preflight)

        # Episode range parser
        self.assertEqual(mod.parse_episode_range(None), [1])
        self.assertEqual(mod.parse_episode_range(2), [2])
        self.assertEqual(mod.parse_episode_range("3"), [3])
        self.assertEqual(mod.parse_episode_range("1-3"), [1, 2, 3])
        self.assertEqual(mod.parse_episode_range("1,3,5"), [1, 3, 5])
        self.assertEqual(mod.parse_episode_range("1-2, 4"), [1, 2, 4])


if __name__ == "__main__":
    unittest.main()
