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
