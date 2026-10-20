"""Bunny agent family, device profiles, and routing policy — repository tests.

Covers the static half of the acceptance matrix:

  * the approved Bunny agents exist with explicit thinking levels
  * the convenience aliases point at the documented variants
  * no Bunny agent carries a turn-count cap
  * the device profile for the enrolled device is sanitized and opt-in
  * the tracked profile mirrors the extension's route schedule
  * nothing sensitive is committed
  * existing Flash defaults and premium agents are untouched
  * the behavioural routing matrix (node --test) passes
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
AGENTS_DIR = REPO_ROOT / "agents"
PROFILE_ROOT = REPO_ROOT / "device-profiles"
EXTENSIONS_DIR = REPO_ROOT / "extensions"

BUNNY_IDENTITY = "bunny/minimax-m3.1-flash"
FAMILY_LEVELS = ["low", "medium", "high", "xhigh", "max"]

# name -> pinned thinking level
BUNNY_AGENTS = {
    "scout-bunny-low": "low",
    "scout-bunny-medium": "medium",
    "worker-bunny-low": "low",
    "worker-bunny-medium": "medium",
    "worker-bunny-high": "high",
    "worker-bunny-xhigh": "xhigh",
    "worker-bunny-max": "max",
    # convenience aliases
    "scout-bunny": "low",
    "worker-bunny": "high",
}

# Files that must never be committed to the repository.
FORBIDDEN_LOCAL_FILES = ["auth.json", "models.json", "trust.json", ".env"]

# Keys that must never appear in a committed device profile.
FORBIDDEN_PROFILE_KEYS = [
    "key",
    "apiKey",
    "api_key",
    "token",
    "accessToken",
    "refreshToken",
    "secret",
    "password",
    "balance",
    "creditBalance",
    "accountId",
    "account_id",
    "hostname",
    "userName",
    "username",
    "homeDir",
    "machineId",
]


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
        fields[key.strip()] = value.strip()
    return fields


class TestBunnyAgents(unittest.TestCase):
    def test_all_bunny_agents_exist(self):
        for name in BUNNY_AGENTS:
            with self.subTest(agent=name):
                self.assertTrue((AGENTS_DIR / f"{name}.md").is_file(), f"missing agent file: {name}.md")

    def test_agents_pin_the_stable_identity_and_level(self):
        for name, level in BUNNY_AGENTS.items():
            with self.subTest(agent=name):
                fields = read_frontmatter(AGENTS_DIR / f"{name}.md")
                self.assertEqual(fields.get("name"), name)
                self.assertEqual(fields.get("model"), f"{BUNNY_IDENTITY}:{level}")
                self.assertEqual(fields.get("thinking"), level)
                self.assertIn(level, FAMILY_LEVELS)

    def test_aliases_point_at_the_documented_variants(self):
        aliases = {"scout-bunny": "scout-bunny-low", "worker-bunny": "worker-bunny-high"}
        for alias, variant in aliases.items():
            with self.subTest(alias=alias):
                fields = read_frontmatter(AGENTS_DIR / f"{alias}.md")
                variant_fields = read_frontmatter(AGENTS_DIR / f"{variant}.md")
                self.assertEqual(fields.get("model"), variant_fields.get("model"))
                self.assertEqual(fields.get("thinking"), variant_fields.get("thinking"))
                self.assertIn(variant, fields.get("description", ""))

    def test_no_bunny_agent_caps_turns(self):
        for name in BUNNY_AGENTS:
            with self.subTest(agent=name):
                fields = read_frontmatter(AGENTS_DIR / f"{name}.md")
                self.assertNotIn("max_turns", fields)
                self.assertNotIn("max_turns", (AGENTS_DIR / f"{name}.md").read_text(encoding="utf-8"))

    def test_no_bunny_agent_caps_cost(self):
        for name in BUNNY_AGENTS:
            with self.subTest(agent=name):
                fields = read_frontmatter(AGENTS_DIR / f"{name}.md")
                self.assertNotIn("max_cost", fields)

    def test_scouts_are_read_only_by_default(self):
        for name in ["scout-bunny", "scout-bunny-low", "scout-bunny-medium"]:
            with self.subTest(agent=name):
                fields = read_frontmatter(AGENTS_DIR / f"{name}.md")
                self.assertEqual(fields.get("role"), "scout")
                tools = {tool.strip() for tool in fields.get("tools", "").split(",") if tool.strip()}
                self.assertNotIn("write", tools)
                self.assertNotIn("edit", tools)

    def test_workers_have_a_worker_role(self):
        for name, _ in BUNNY_AGENTS.items():
            if not name.startswith("worker-"):
                continue
            with self.subTest(agent=name):
                fields = read_frontmatter(AGENTS_DIR / f"{name}.md")
                self.assertEqual(fields.get("role"), "worker")

    def test_no_bunny_planner_or_advisor_exists(self):
        for path in AGENTS_DIR.glob("*bunny*.md"):
            with self.subTest(agent=path.name):
                self.assertNotIn("planner", path.name)
                self.assertNotIn("advisor", path.name)


class TestExistingRoutingUnchanged(unittest.TestCase):
    def test_default_flash_provider_is_untouched(self):
        settings = json.loads((REPO_ROOT / "settings.json.template").read_text(encoding="utf-8"))
        self.assertEqual(settings["defaultProvider"], "antigravity")
        self.assertEqual(settings["defaultModel"], "gemini-3.8-flash")
        self.assertIn("antigravity/gemini-3.8-flash", settings["enabledModels"])

    def test_premium_agents_are_untouched(self):
        expected = {
            "worker-luna": "openai/gpt-6-luna",
            "worker-sol": "openai/gpt-6.1-sol",
            "worker-astra": "openai/gpt-6-astra",
            "scout-luna": "openai/gpt-6-luna",
            "worker-flash-high": "antigravity/gemini-3.8-flash",
        }
        for name, model in expected.items():
            with self.subTest(agent=name):
                path = AGENTS_DIR / f"{name}.md"
                if not path.is_file():
                    self.skipTest(f"{name}.md is not part of this repository")
                fields = read_frontmatter(path)
                self.assertTrue(fields.get("model", "").startswith(model.split(":")[0]))

    def test_no_default_model_points_at_the_bunny_identity(self):
        settings = json.loads((REPO_ROOT / "settings.json.template").read_text(encoding="utf-8"))
        self.assertNotIn(BUNNY_IDENTITY, settings["defaultModel"])
        self.assertFalse(
            any(BUNNY_IDENTITY in model for model in settings.get("enabledModels", [])),
            "the Bunny virtual model must not change the default model scope",
        )


class TestDeviceProfiles(unittest.TestCase):
    def setUp(self):
        self.profiles = sorted(p.name for p in PROFILE_ROOT.iterdir() if (p / "profile.json").is_file())
        self.assertTrue(self.profiles, "no device profile found")

    def test_schema_and_template_exist(self):
        self.assertTrue((PROFILE_ROOT / "schema.json").is_file())
        self.assertTrue((PROFILE_ROOT / "README.md").is_file())
        self.assertTrue((PROFILE_ROOT / "templates" / "device-profile.example.json").is_file())

    def test_profiles_validate_against_the_schema(self):
        try:
            import jsonschema
        except ImportError:  # pragma: no cover - optional dependency
            self.skipTest("jsonschema is not installed")
        schema = json.loads((PROFILE_ROOT / "schema.json").read_text(encoding="utf-8"))
        for device_id in self.profiles:
            with self.subTest(device=device_id):
                profile = json.loads((PROFILE_ROOT / device_id / "profile.json").read_text(encoding="utf-8"))
                jsonschema.validate(profile, schema)

    def test_template_validates_against_the_schema(self):
        try:
            import jsonschema
        except ImportError:  # pragma: no cover - optional dependency
            self.skipTest("jsonschema is not installed")
        schema = json.loads((PROFILE_ROOT / "schema.json").read_text(encoding="utf-8"))
        template = json.loads(
            (PROFILE_ROOT / "templates" / "device-profile.example.json").read_text(encoding="utf-8")
        )
        jsonschema.validate(template, schema)

    def test_enrolled_profile_is_opted_in(self):
        profile = json.loads((PROFILE_ROOT / "macbook-air-m1" / "profile.json").read_text(encoding="utf-8"))
        self.assertTrue(profile["optIn"]["enabled"])
        self.assertEqual(profile["device"]["id"], "macbook-air-m1")
        self.assertEqual(profile["device"]["platform"], "darwin")
        self.assertEqual(profile["device"]["architecture"], "arm64")

    def test_profile_contains_no_sensitive_fields(self):
        for device_id in self.profiles:
            for name in ["profile.json", "model-catalog.json"]:
                path = PROFILE_ROOT / device_id / name
                if not path.is_file():
                    continue
                with self.subTest(device=device_id, file=name):
                    payload = json.loads(path.read_text(encoding="utf-8"))
                    keys = set(re.findall(r'"([^"]+)"\s*:', path.read_text(encoding="utf-8")))
                    for forbidden in FORBIDDEN_PROFILE_KEYS:
                        self.assertNotIn(forbidden, keys, f"{forbidden} must stay local")

    def test_profile_contains_no_machine_identifiers(self):
        for device_id in self.profiles:
            path = PROFILE_ROOT / device_id / "profile.json"
            text = path.read_text(encoding="utf-8")
            with self.subTest(device=device_id):
                self.assertNotIn(str(Path.home()), text)
                self.assertNotIn("/Users/", text)
                self.assertNotIn("hostname", text.lower())

    def test_profile_routes_match_the_extension_schedule(self):
        profile = json.loads((PROFILE_ROOT / "macbook-air-m1" / "profile.json").read_text(encoding="utf-8"))
        source = (EXTENSIONS_DIR / "bunny-route.mjs").read_text(encoding="utf-8")
        for route in profile["bunny"]["routes"]:
            with self.subTest(route=route["id"]):
                self.assertIn(f'id: "{route["id"]}"', source)
                self.assertIn(f'provider: "{route["provider"]}"', source)
                self.assertIn(f'model: "{route["model"]}"', source)
                self.assertIn(f'freeGuarantee: "{route["freeGuarantee"]}"', source)
        # The cutoff is a single shared constant in the routing core.
        cutoff = profile["bunny"]["routes"][0]["freeUntil"]
        self.assertIn(f'export const PROMOTION_CUTOFF = "{cutoff}"', source)
        self.assertEqual(profile["bunny"]["identity"], BUNNY_IDENTITY)
        self.assertEqual(profile["bunny"]["thinkingLevels"], FAMILY_LEVELS)

    def test_profile_subagents_match_the_agent_files(self):
        profile = json.loads((PROFILE_ROOT / "macbook-air-m1" / "profile.json").read_text(encoding="utf-8"))
        for name, entry in profile["bunny"]["subagents"].items():
            with self.subTest(agent=name):
                fields = read_frontmatter(AGENTS_DIR / f"{name}.md")
                self.assertEqual(fields.get("thinking"), entry["thinkingLevel"])
                self.assertEqual(fields.get("model"), f"{BUNNY_IDENTITY}:{entry['thinkingLevel']}")

    def test_profile_policy_forbids_automatic_spending(self):
        profile = json.loads((PROFILE_ROOT / "macbook-air-m1" / "profile.json").read_text(encoding="utf-8"))
        policy = profile["bunny"]["policy"]
        self.assertFalse(policy["autoPurchase"])
        self.assertFalse(policy["autoTopUp"])
        self.assertFalse(policy["paidOpenRouterFallback"])
        self.assertFalse(policy["minimaxDirectPaid"])
        self.assertTrue(policy["paidUseRequiresExplicitAuthorization"])

    def test_local_only_files_are_not_committed(self):
        for name in FORBIDDEN_LOCAL_FILES:
            with self.subTest(file=name):
                self.assertFalse((REPO_ROOT / name).exists(), f"{name} must stay local")

    def test_gitignore_keeps_local_state_out_of_the_repository(self):
        gitignore = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
        for name in ["auth.json", "models.json", "trust.json"]:
            with self.subTest(file=name):
                self.assertIn(name, gitignore)


class TestDeviceModelsCli(unittest.TestCase):
    def test_cli_entry_points_exist(self):
        self.assertTrue((REPO_ROOT / "bin" / "device-models.sh").is_file())
        self.assertTrue((REPO_ROOT / "bin" / "device-models.py").is_file())

    def test_cli_lists_profiles(self):
        completed = subprocess.run(
            ["bash", str(REPO_ROOT / "bin" / "device-models.sh"), "list"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("macbook-air-m1", completed.stdout)

    def test_cli_help(self):
        completed = subprocess.run(
            ["bash", str(REPO_ROOT / "bin" / "device-models.sh"), "--help"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        for command in ["enroll", "status", "sync", "diff", "restore", "verify", "disable"]:
            self.assertIn(command, completed.stdout)


class TestDeviceModelsLifecycle(unittest.TestCase):
    """End-to-end enrollment, sync, diff, and restore against a temp agent dir."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="pi-config-device-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.agent_dir = self.tmp / "agent"
        self.agent_dir.mkdir(parents=True)
        self.profile_root = self.tmp / "device-profiles"
        shutil.copytree(PROFILE_ROOT, self.profile_root)
        self.env = dict(os.environ)
        self.env["PI_CODING_AGENT_DIR"] = str(self.agent_dir)
        self.env["PI_CONFIG_DEVICE_PROFILES"] = str(self.profile_root)

    def run_cli(self, *args, expect=0):
        completed = subprocess.run(
            ["bash", str(REPO_ROOT / "bin" / "device-models.sh"), *args],
            capture_output=True,
            text=True,
            env=self.env,
            check=False,
        )
        self.assertEqual(completed.returncode, expect, completed.stdout + completed.stderr)
        return completed

    def test_enroll_creates_an_opted_in_local_state(self):
        self.run_cli("enroll", "macbook-air-m1")
        state = json.loads((self.agent_dir / "device-profile.json").read_text(encoding="utf-8"))
        self.assertTrue(state["enabled"])
        self.assertEqual(state["device"], "macbook-air-m1")
        self.assertIn("openrouter-free", state["routing"]["routes"])
        self.assertIn("vercel-ai-gateway", state["routing"]["routes"])
        # No authorization is granted by enrolling.
        for route in state["routing"]["routes"].values():
            self.assertFalse(route["paidAuthorized"])
        # The spend cap is carried over from the tracked policy.
        self.assertEqual(state["routing"]["spend"]["capUsd"], 5)

    def test_enroll_does_not_touch_credentials_or_models(self):
        (self.agent_dir / "auth.json").write_text('{"openrouter": {"type": "oauth"}}', encoding="utf-8")
        (self.agent_dir / "models.json").write_text('{"providers": {}}', encoding="utf-8")
        before_auth = (self.agent_dir / "auth.json").read_text(encoding="utf-8")
        before_models = (self.agent_dir / "models.json").read_text(encoding="utf-8")
        self.run_cli("enroll", "macbook-air-m1")
        self.assertEqual((self.agent_dir / "auth.json").read_text(encoding="utf-8"), before_auth)
        self.assertEqual((self.agent_dir / "models.json").read_text(encoding="utf-8"), before_models)

    def test_enroll_is_idempotent(self):
        self.run_cli("enroll", "macbook-air-m1")
        completed = self.run_cli("enroll", "macbook-air-m1")
        self.assertIn("Already enrolled", completed.stdout)

    def test_sync_writes_a_sanitized_snapshot(self):
        self.run_cli("enroll", "macbook-air-m1")
        self.run_cli("sync", "macbook-air-m1")
        snapshot_path = self.profile_root / "macbook-air-m1" / "model-catalog.json"
        self.assertTrue(snapshot_path.is_file())
        text = snapshot_path.read_text(encoding="utf-8")
        snapshot = json.loads(text)
        self.assertEqual(snapshot["device"], "macbook-air-m1")
        for forbidden in FORBIDDEN_PROFILE_KEYS:
            self.assertNotIn(f'"{forbidden}"', text)
        self.assertNotIn(str(self.tmp), text)
        self.assertNotIn(str(Path.home()), text)

    def test_diff_reports_the_local_versus_tracked_state(self):
        self.run_cli("enroll", "macbook-air-m1")
        completed = self.run_cli("diff", "macbook-air-m1")
        self.assertIn("Sanitized metadata that is safe to commit", completed.stdout)
        self.assertIn("Local-only fields that are never committed", completed.stdout)

    def test_restore_preserves_credentials_and_unrelated_models(self):
        auth = '{"openrouter": {"type": "oauth"}}'
        (self.agent_dir / "auth.json").write_text(auth, encoding="utf-8")
        models = {"providers": {"antigravity": {"modelOverrides": {"gemini-3.8-flash": {"contextWindow": 272000}}}}}
        (self.agent_dir / "models.json").write_text(json.dumps(models), encoding="utf-8")
        store = {
            "openrouter": {
                "models": [
                    {
                        "id": "minimax/minimax-m3.1-flash:free",
                        "name": "MiniMax: MiniMax M3.1 Flash (free)",
                        "api": "openai-completions",
                        "baseUrl": "https://openrouter.ai/api/v1",
                        "reasoning": True,
                        "contextWindow": 1000000,
                        "maxTokens": 524288,
                    }
                ]
            }
        }
        (self.agent_dir / "models-store.json").write_text(json.dumps(store), encoding="utf-8")
        self.run_cli("enroll", "macbook-air-m1")
        self.run_cli("restore", "macbook-air-m1", "--yes")
        self.assertEqual((self.agent_dir / "auth.json").read_text(encoding="utf-8"), auth)
        restored = json.loads((self.agent_dir / "models.json").read_text(encoding="utf-8"))
        self.assertIn("antigravity", restored["providers"])
        self.assertIn("gemini-3.8-flash", restored["providers"]["antigravity"]["modelOverrides"])
        # The device profile's model is added, not substituted.
        added = [m["id"] for m in restored["providers"]["openrouter"]["models"]]
        self.assertIn("minimax/minimax-m3.1-flash:free", added)

    def test_restore_requires_confirmation(self):
        completed = self.run_cli("restore", "macbook-air-m1", expect=1)
        self.assertIn("--yes", completed.stdout)
        self.assertFalse((self.agent_dir / "models.json").exists())

    def test_disable_turns_routing_off(self):
        self.run_cli("enroll", "macbook-air-m1")
        self.run_cli("disable")
        state = json.loads((self.agent_dir / "device-profile.json").read_text(encoding="utf-8"))
        self.assertFalse(state["enabled"])
        self.assertFalse(state["routing"]["enabled"])

    def test_unenrolled_machine_has_no_device_state(self):
        self.run_cli("status")
        self.assertFalse((self.agent_dir / "device-profile.json").exists())

    def test_status_reports_the_enrollment(self):
        self.run_cli("enroll", "macbook-air-m1")
        completed = self.run_cli("status")
        self.assertIn("macbook-air-m1", completed.stdout)
        self.assertIn("active route", completed.stdout)

    def test_sync_does_not_copy_authentication_material(self):
        (self.agent_dir / "auth.json").write_text('{"openrouter": {"key": "sk-secret-value"}}', encoding="utf-8")
        self.run_cli("enroll", "macbook-air-m1")
        self.run_cli("sync", "macbook-air-m1")
        text = (self.profile_root / "macbook-air-m1" / "model-catalog.json").read_text(encoding="utf-8")
        self.assertNotIn("sk-secret-value", text)


class TestBunnyRoutingBehaviour(unittest.TestCase):
    """Runs the behavioural routing matrix (node --test)."""

    def test_node_routing_matrix_passes(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        completed = subprocess.run(
            [node, "--test", str(REPO_ROOT / "tests" / "bunny-router.test.mjs")],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout[-4000:] + completed.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()
