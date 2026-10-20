#!/usr/bin/env python3
"""Device-scoped model catalog and Bunny routing for Pi.

Managed by pi-config. Architecture:

    repo/device-profiles/<device>/profile.json   sanitized, Git-trackable policy
    repo/device-profiles/<device>/model-catalog.json
                                                  sanitized catalog snapshot
    <agent-dir>/device-profile.json              local-only enrollment + routing
                                                  state (never committed)

The local state file is what `extensions/bunny-router.ts` reads at request
time. It holds only non-secret authorization flags. Credentials stay in
`auth.json` / the environment and are never read into a profile, never copied,
and never printed.

Commands:
    list                       List device profiles in this repository
    status                     Show local enrollment, resolved route, readiness
    enroll <device-id>         Opt this machine into a device profile
    disable                    Turn Bunny routing off on this machine
    sync <device-id>           Write a sanitized snapshot into the repo
    diff [device-id]           Compare the local catalog with the tracked profile
    restore <device-id>        Apply tracked model preferences locally (opt-in)
    verify                     Re-check catalog + credentials, refresh local state
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[1]
# The tracked profile root. Overridable so tests (and side-by-side checkouts)
# never write into the real repository.
PROFILE_ROOT = Path(
    os.environ.get("PI_CONFIG_DEVICE_PROFILES", REPO_ROOT / "device-profiles")
).expanduser()
LOCAL_STATE_NAME = "device-profile.json"
BACKUP_SUFFIX = ".bak"

BUNNY_IDENTITY = "bunny/minimax-m3.1-flash"
BUNNY_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"]

# Environment variables that make a provider usable without auth.json.
PROVIDER_ENV_VARS = {
    "openrouter": ["OPENROUTER_API_KEY"],
    "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
    "minimax": ["MINIMAX_API_KEY"],
    "anthropic": ["ANTHROPIC_API_KEY"],
    "openai": ["OPENAI_API_KEY"],
}

# Fields copied out of a Pi catalog entry. Anything not listed here is dropped.
SAFE_MODEL_FIELDS = [
    "id",
    "name",
    "api",
    "baseUrl",
    "reasoning",
    "thinkingLevelMap",
    "input",
    "contextWindow",
    "maxTokens",
    "cost",
    "compat",
]

# Keys that must never appear in a committed profile.
FORBIDDEN_KEYS = {
    "key",
    "apiKey",
    "api_key",
    "token",
    "accessToken",
    "refreshToken",
    "secret",
    "password",
    "authorization",
    "accountId",
    "account_id",
    "balance",
    "creditBalance",
    "hostname",
    "hostName",
    "userName",
    "username",
    "home",
    "homeDir",
    "machineId",
    "serialNumber",
}


def agent_dir() -> Path:
    return Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi" / "agent")).expanduser()


def local_state_path() -> Path:
    return agent_dir() / LOCAL_STATE_NAME


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> Optional[Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def atomic_write_json(path: Path, payload: Any, backup: bool = True) -> None:
    """Write JSON atomically, keeping a single rotating backup."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if backup and path.exists():
        shutil.copy2(path, path.with_suffix(path.suffix + BACKUP_SUFFIX))
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=False)
        handle.write("\n")
    os.replace(tmp, path)


def pi_version() -> Optional[str]:
    current = agent_dir() / "install" / "current-version"
    try:
        value = current.read_text(encoding="utf-8").strip()
        if value:
            return value
    except OSError:
        pass
    releases = agent_dir() / "install" / "releases"
    if releases.is_dir():
        versions = sorted(p.name for p in releases.iterdir() if p.is_dir())
        if versions:
            return versions[-1]
    return None


def local_catalog() -> Dict[str, List[Dict[str, Any]]]:
    """Provider -> sanitized model list, read from the local Pi model store."""
    store = load_json(agent_dir() / "models-store.json")
    if not isinstance(store, dict):
        return {}
    catalog: Dict[str, List[Dict[str, Any]]] = {}
    for provider, entry in store.items():
        if not isinstance(entry, dict):
            continue
        models = entry.get("models")
        if not isinstance(models, list):
            continue
        safe: List[Dict[str, Any]] = []
        for model in models:
            if not isinstance(model, dict):
                continue
            safe.append({key: model[key] for key in SAFE_MODEL_FIELDS if key in model})
        catalog[provider] = safe
    return catalog


def credential_status(providers: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    """Provider -> {configured, source}. Reads names only, never key material."""
    auth = load_json(agent_dir() / "auth.json")
    stored = set()
    if isinstance(auth, dict):
        stored = {key for key in auth.keys() if isinstance(key, str)}
    status: Dict[str, Dict[str, Any]] = {}
    for provider in providers:
        env_names = PROVIDER_ENV_VARS.get(provider, [])
        if provider in stored:
            status[provider] = {"configured": True, "source": "stored"}
            continue
        if any(os.environ.get(name) for name in env_names):
            status[provider] = {"configured": True, "source": "environment"}
            continue
        status[provider] = {"configured": False, "source": "none"}
    return status


def sanitize(value: Any) -> Any:
    """Strip any key that could carry a secret or machine identifier."""
    if isinstance(value, dict):
        cleaned: Dict[str, Any] = {}
        for key, item in value.items():
            if key in FORBIDDEN_KEYS:
                continue
            cleaned[key] = sanitize(item)
        return cleaned
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    return value


def profile_dir(device_id: str) -> Path:
    return PROFILE_ROOT / device_id


def list_profiles() -> List[str]:
    if not PROFILE_ROOT.is_dir():
        return []
    return sorted(p.name for p in PROFILE_ROOT.iterdir() if (p / "profile.json").is_file())


def load_profile(device_id: str) -> Optional[Dict[str, Any]]:
    profile = load_json(profile_dir(device_id) / "profile.json")
    return profile if isinstance(profile, dict) else None


def load_local_state() -> Optional[Dict[str, Any]]:
    state = load_json(local_state_path())
    return state if isinstance(state, dict) else None


ROUTE_BRIDGE = """
import { resolveBunnyRoute } from "file://__MODULE__";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
process.stdout.write(JSON.stringify(resolveBunnyRoute(input)));
"""


def route_model_ids() -> List[str]:
    """provider/model entries the Bunny schedule can select."""
    return [
        "openrouter/minimax/minimax-m3.1-flash:free",
        "vercel-ai-gateway/minimax/minimax-m3.1-flash",
    ]


def trim_catalog(catalog: Dict[str, Any]) -> Dict[str, Any]:
    """Keep only the models the Bunny schedule can select."""
    trimmed: Dict[str, Any] = {}
    for entry in route_model_ids():
        provider, _, model_id = entry.partition("/")
        models = catalog.get(provider, [])
        match = next((m for m in models if m.get("id") == model_id), None)
        if match is not None:
            trimmed.setdefault(provider, {})[model_id] = match
    return trimmed


def resolve_route(state: Optional[Dict[str, Any]], catalog: Dict[str, Any]) -> Dict[str, Any]:
    """Mirror of the extension's route decision, for local reporting only.

    The JavaScript core stays the single source of truth; this shells out to
    node so the CLI and the Pi extension can never disagree.
    """
    node = shutil.which("node")
    if not node:
        return {"ok": False, "blockers": ["node is not available; cannot evaluate the Bunny route schedule."]}
    module_path = (REPO_ROOT / "extensions" / "bunny-route.mjs").resolve()
    script = ROUTE_BRIDGE.replace("__MODULE__", str(module_path))
    credentials = {
        provider: {"configured": bool(value.get("configured"))}
        for provider, value in credential_status(list(catalog.keys())).items()
    }
    payload = {
        "now": datetime.now(timezone.utc).isoformat(),
        "state": state,
        "catalog": trim_catalog(catalog),
        "credentials": credentials,
    }
    try:
        completed = subprocess.run(
            [node, "--input-type=module", "-e", script],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "blockers": [f"route engine unavailable: {exc}"]}
    if completed.returncode != 0:
        detail = (completed.stderr or "").strip().splitlines()
        return {"ok": False, "blockers": [f"route engine failed: {detail[-1] if detail else completed.returncode}"]}
    try:
        return json.loads(completed.stdout or "{}")
    except ValueError as exc:
        return {"ok": False, "blockers": [f"route engine returned invalid output: {exc}"]}


def cmd_list(_args: argparse.Namespace) -> int:
    profiles = list_profiles()
    if not profiles:
        print("No device profiles found in device-profiles/.")
        return 0
    print("Device profiles:")
    for device_id in profiles:
        profile = load_profile(device_id) or {}
        alias = profile.get("device", {}).get("alias", device_id)
        enabled = profile.get("optIn", {}).get("enabled", False)
        print(f"  {device_id:20s} {alias:24s} opt-in={'yes' if enabled else 'no'}")
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    state = load_local_state()
    catalog = local_catalog()
    print("Pi device model status")
    print(f"  agent dir        : {agent_dir()}")
    print(f"  pi version       : {pi_version() or 'unknown'}")
    print(f"  platform         : {platform.system()} {platform.machine()}")
    if not state:
        print("  enrollment       : none (Bunny routing uses the published default schedule)")
    else:
        print(f"  enrollment       : {state.get('device', 'unknown')} (enabled={state.get('enabled', False)})")
        print(f"  enrolled at      : {state.get('enrolledAt', 'unknown')}")
    routes = (state or {}).get("routing", {}).get("routes", {})
    for route_id, route_state in routes.items():
        flags = []
        if route_state.get("freeVerified"):
            flags.append("free-verified")
        if route_state.get("paidAuthorized"):
            flags.append("paid-authorized")
        if not flags:
            flags.append("no-authorization")
        print(f"  route {route_id:20s} {', '.join(flags)}")
    result = resolve_route(state, catalog)
    if result.get("ok"):
        route = result["route"]
        print(f"  active route     : {route['id']} -> {route['provider']}/{route['model']}")
        print(f"  free window      : {'yes' if route.get('inFreeWindow') else 'no (past published cutoff)'}")
    else:
        print("  active route     : none")
        for blocker in result.get("blockers", []):
            print(f"    - {blocker}")
    return 0


def cmd_enroll(args: argparse.Namespace) -> int:
    device_id = args.device
    profile = load_profile(device_id)
    if profile is None:
        print(f"Unknown device profile: {device_id}", file=sys.stderr)
        print("Available: " + ", ".join(list_profiles()), file=sys.stderr)
        return 2

    existing = load_local_state()
    if existing and existing.get("device") == device_id and not args.force:
        print(f"Already enrolled as {device_id}. Use --force to re-enroll.")
        return 0

    routes = profile.get("bunny", {}).get("routes", [])
    credentials = credential_status([route.get("provider", "") for route in routes])
    route_state: Dict[str, Any] = {}
    for route in routes:
        route_id = route.get("id", "")
        provider = route.get("provider", "")
        previous = (existing or {}).get("routing", {}).get("routes", {}).get(route_id, {})
        route_state[route_id] = {
            "available": bool(credentials.get(provider, {}).get("configured", False)),
            "freeVerified": bool(previous.get("freeVerified", False)),
            "verifiedAt": previous.get("verifiedAt"),
            "paidAuthorized": bool(previous.get("paidAuthorized", False)),
            "note": previous.get(
                "note",
                "Set with 'bin/device-models.sh verify' after checking the account."
                if credentials.get(provider, {}).get("configured")
                else f"No credentials for {provider}; set {route.get('credential', 'the provider credential')}.",
            ),
        }

    state = {
        "version": 1,
        "device": device_id,
        "enabled": True,
        "enrolledAt": (existing or {}).get("enrolledAt", now_iso()),
        "updatedAt": now_iso(),
        "routing": {
            "enabled": True,
            "preferredRouteId": None,
            "routes": route_state,
            "spend": {
                "capUsd": profile.get("bunny", {}).get("policy", {}).get("spendCapUsd", 5),
                "usedUsd": (existing or {}).get("routing", {}).get("spend", {}).get("usedUsd", 0),
            },
        },
    }
    atomic_write_json(local_state_path(), state)
    print(f"Enrolled {device_id}.")
    print(f"Local state: {local_state_path()}")
    print("Credentials were not touched. No model outside this profile was modified.")
    result = resolve_route(state, local_catalog())
    if result.get("ok"):
        route = result["route"]
        print(f"Active route: {route['id']} -> {route['provider']}/{route['model']}")
    else:
        print("Active route: none")
        for blocker in result.get("blockers", []):
            print(f"  - {blocker}")
    return 0


def cmd_disable(_args: argparse.Namespace) -> int:
    state = load_local_state()
    if not state:
        print("Not enrolled; nothing to disable.")
        return 0
    state["enabled"] = False
    state["routing"]["enabled"] = False
    state["updatedAt"] = now_iso()
    atomic_write_json(local_state_path(), state)
    print(f"Disabled Bunny routing for {state.get('device')}.")
    return 0


def tracked_model_ids(profile: Dict[str, Any]) -> Dict[str, List[str]]:
    """provider -> model ids that belong to this device profile.

    The snapshot stays small and reviewable: it records the models the device
    actually routes to, not the whole provider catalog.
    """
    tracked: Dict[str, List[str]] = {}
    for route in profile.get("bunny", {}).get("routes", []):
        provider = route.get("provider", "")
        model_id = route.get("model", "")
        if provider and model_id:
            tracked.setdefault(provider, []).append(model_id)
    for entry in profile.get("models", {}).get("enabled", []):
        provider, _, model_id = entry.partition("/")
        if provider and model_id:
            tracked.setdefault(provider, []).append(model_id)
    return tracked


def build_snapshot(device_id: str, providers: List[str], profile: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    catalog = local_catalog()
    credentials = credential_status(providers)
    tracked = tracked_model_ids(profile or {})
    snapshot: Dict[str, Any] = {
        "version": 1,
        "device": device_id,
        "generatedAt": now_iso(),
        "source": {"piVersion": pi_version(), "catalog": "models-store.json"},
        "providers": {},
    }
    for provider in providers:
        wanted = tracked.get(provider, [])
        models = [m for m in catalog.get(provider, []) if m.get("id") in wanted]
        entry = {
            "auth": {
                "configured": bool(credentials.get(provider, {}).get("configured", False)),
                "source": credentials.get(provider, {}).get("source", "none"),
            },
            "models": models,
        }
        snapshot["providers"][provider] = entry
    return sanitize(snapshot)


def cmd_sync(args: argparse.Namespace) -> int:
    device_id = args.device
    profile = load_profile(device_id)
    if profile is None:
        print(f"Unknown device profile: {device_id}", file=sys.stderr)
        return 2

    providers = args.providers or list(profile.get("providers", {}).get("available", []))
    if not providers:
        print("No providers selected; nothing to sync.")
        return 2

    snapshot = build_snapshot(device_id, providers, profile)
    target = profile_dir(device_id) / "model-catalog.json"
    before = load_json(target)
    atomic_write_json(target, snapshot, backup=False)
    print(f"Wrote sanitized snapshot: {target}")
    if before == snapshot:
        print("  no change")
    else:
        print("  changed (review with: git diff -- device-profiles/)")
    print("No credentials, account identifiers, balances, or host metadata were written.")

    refreshed = refresh_profile_metadata(device_id, providers)
    atomic_write_json(profile_dir(device_id) / "profile.json", refreshed, backup=False)
    print(f"Refreshed profile metadata: {profile_dir(device_id) / 'profile.json'}")
    return 0


def refresh_profile_metadata(device_id: str, providers: List[str]) -> Dict[str, Any]:
    profile = load_profile(device_id) or {}
    catalog = local_catalog()
    credentials = credential_status(providers)
    profile["providers"] = {
        "available": providers,
        "credentials": {
            provider: {
                "configured": bool(credentials.get(provider, {}).get("configured", False)),
                "source": credentials.get(provider, {}).get("source", "none"),
                "verifiedAt": now_iso(),
            }
            for provider in providers
        },
    }
    enabled_models: List[str] = []
    availability: Dict[str, Any] = {}
    levels = set(BUNNY_THINKING_LEVELS)
    for route in profile.get("bunny", {}).get("routes", []):
        provider = route.get("provider", "")
        model_id = route.get("model", "")
        if provider and model_id:
            enabled_models.append(f"{provider}/{model_id}")
        model = next((m for m in catalog.get(provider, []) if m.get("id") == model_id), None)
        if model is None:
            availability[f"{provider}/{model_id}"] = {
                "status": "unavailable",
                "note": "Not in the local Pi catalog. Run 'pi update --models' after configuring the provider credential.",
            }
            continue
        map_levels = model.get("thinkingLevelMap")
        supported = (
            [level for level in BUNNY_THINKING_LEVELS if isinstance(map_levels, dict) and map_levels.get(level) is not None]
            if isinstance(map_levels, dict)
            else list(BUNNY_THINKING_LEVELS)
        )
        availability[f"{provider}/{model_id}"] = {
            "status": "available",
            "thinkingLevels": supported,
            "contextWindow": model.get("contextWindow"),
            "maxTokens": model.get("maxTokens"),
        }
    profile["models"] = {
        "enabled": enabled_models,
        "supportedThinkingLevels": list(BUNNY_THINKING_LEVELS),
    }
    profile["availability"] = {"checkedAt": now_iso(), "models": availability}
    profile["lastVerifiedAt"] = now_iso()

    local = load_local_state()
    if local and local.get("device") == device_id:
        opt_in = profile.setdefault("optIn", {"enabled": True})
        opt_in["enabled"] = True
        opt_in["enrolledAt"] = local.get("enrolledAt", opt_in.get("enrolledAt"))
        opt_in["enrolledBy"] = opt_in.get("enrolledBy", "bin/device-models.sh enroll")
    return sanitize(profile)


def cmd_diff(args: argparse.Namespace) -> int:
    device_id = args.device
    if device_id is None:
        state = load_local_state()
        device_id = (state or {}).get("device")
    if not device_id:
        print("No device specified and no local enrollment found.", file=sys.stderr)
        return 2
    profile = load_profile(device_id)
    if profile is None:
        print(f"Unknown device profile: {device_id}", file=sys.stderr)
        return 2
    providers = list(profile.get("providers", {}).get("available", []))
    local_snapshot = build_snapshot(device_id, providers, profile)
    tracked = load_json(profile_dir(device_id) / "model-catalog.json") or {}

    print(f"Device: {device_id}")
    print("Sanitized metadata that is safe to commit:")
    local_providers = local_snapshot.get("providers", {})
    tracked_providers = tracked.get("providers", {}) if isinstance(tracked, dict) else {}
    for provider in providers:
        local_models = {m.get("id") for m in local_providers.get(provider, {}).get("models", [])}
        tracked_models = {m.get("id") for m in tracked_providers.get(provider, {}).get("models", [])}
        only_local = sorted(local_models - tracked_models)
        only_tracked = sorted(tracked_models - local_models)
        status = "in sync" if not only_local and not only_tracked else "differs"
        print(f"  provider {provider}: {status} ({len(local_models)} local / {len(tracked_models)} tracked)")
        for model_id in only_local:
            print(f"    + local only : {model_id}")
        for model_id in only_tracked:
            print(f"    - tracked only: {model_id}")
    print("Local-only fields that are never committed:")
    print("  - auth.json keys and OAuth tokens")
    print("  - provider account identifiers")
    print("  - credit balances and billing data")
    print("  - hostname, username, home path, hardware identifiers")
    return 0


def cmd_restore(args: argparse.Namespace) -> int:
    device_id = args.device
    profile = load_profile(device_id)
    if profile is None:
        print(f"Unknown device profile: {device_id}", file=sys.stderr)
        return 2
    if not args.yes:
        print(f"Restore {device_id} model preferences into the local Pi config?")
        print("Credentials in auth.json are preserved. models.json entries outside the profile are preserved.")
        print("Re-run with --yes to apply.")
        return 1

    target = agent_dir() / "models.json"
    existing = load_json(target)
    if existing is None:
        existing = {"providers": {}}
    if not isinstance(existing, dict):
        print("Local models.json is not a JSON object; refusing to overwrite it.", file=sys.stderr)
        return 2
    providers = existing.setdefault("providers", {})
    catalog = local_catalog()
    for provider in profile.get("providers", {}).get("available", []):
        models = catalog.get(provider, [])
        if not models:
            continue
        entry = providers.setdefault(provider, {})
        existing_ids = {m.get("id") for m in entry.get("models", [])}
        added = [m for m in models if m.get("id") not in existing_ids]
        if added:
            entry["models"] = list(entry.get("models", [])) + added
        print(f"  provider {provider}: {len(added)} model(s) added, {len(existing_ids)} preserved")
    atomic_write_json(target, existing)
    print(f"Restored device model preferences into {target}")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    state = load_local_state()
    if not state:
        print("Not enrolled. Nothing to verify.", file=sys.stderr)
        return 2
    device_id = state.get("device", "unknown")
    profile = load_profile(device_id) or {}
    providers = list(profile.get("providers", {}).get("available", []))
    catalog = local_catalog()
    credentials = credential_status(providers)
    routes = state.get("routing", {}).get("routes", {})
    for route in profile.get("bunny", {}).get("routes", []):
        route_id = route.get("id", "")
        provider = route.get("provider", "")
        model_id = route.get("model", "")
        entry = routes.setdefault(route_id, {})
        entry["available"] = bool(credentials.get(provider, {}).get("configured", False))
        present = any(m.get("id") == model_id for m in catalog.get(provider, []))
        entry["inCatalog"] = present
        if not present:
            entry["note"] = f"{provider}/{model_id} is not in the local catalog; run 'pi update --models'."
        elif not entry["available"]:
            entry["note"] = f"No credentials for {provider}; set {route.get('credential', 'the provider credential')}."
    state["updatedAt"] = now_iso()
    atomic_write_json(local_state_path(), state)
    print(f"Verified local state for {device_id}.")
    result = resolve_route(state, catalog)
    if result.get("ok"):
        route = result["route"]
        print(f"Active route: {route['id']} -> {route['provider']}/{route['model']}")
    else:
        print("Active route: none")
        for blocker in result.get("blockers", []):
            print(f"  - {blocker}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="List device profiles").set_defaults(func=cmd_list)
    sub.add_parser("status", help="Show local enrollment and resolved route").set_defaults(func=cmd_status)

    enroll = sub.add_parser("enroll", help="Opt this machine into a device profile")
    enroll.add_argument("device")
    enroll.add_argument("--force", action="store_true", help="Re-enroll and reset local routing flags")
    enroll.set_defaults(func=cmd_enroll)

    sub.add_parser("disable", help="Turn Bunny routing off on this machine").set_defaults(func=cmd_disable)

    sync = sub.add_parser("sync", help="Write a sanitized snapshot into the repository")
    sync.add_argument("device")
    sync.add_argument("--providers", nargs="*", help="Providers to snapshot (defaults to the profile list)")
    sync.set_defaults(func=cmd_sync)

    diff = sub.add_parser("diff", help="Compare the local catalog with the tracked profile")
    diff.add_argument("device", nargs="?")
    diff.set_defaults(func=cmd_diff)

    restore = sub.add_parser("restore", help="Apply tracked model preferences locally")
    restore.add_argument("device")
    restore.add_argument("--yes", action="store_true", help="Apply without the interactive confirmation")
    restore.set_defaults(func=cmd_restore)

    verify = sub.add_parser("verify", help="Re-check catalog and credentials")
    verify.set_defaults(func=cmd_verify)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
