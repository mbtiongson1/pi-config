#!/usr/bin/env python3
"""Resolve and pin the latest max-capable Astra in Codex's model catalog."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import tomllib
except ImportError:  # Python 3.10
    import tomli as tomllib


PROFILE_NAME = "astra-advisor"
MODEL_PATTERN = re.compile(r"^gpt-(\d+(?:\.\d+)*)-astra$", re.IGNORECASE)


class PreflightError(Exception):
    pass


def fail(message: str) -> "None":
    raise PreflightError(message)


def catalog_from_codex(codex_bin: str) -> dict:
    env = os.environ.copy()
    result = subprocess.run(
        [codex_bin, "debug", "models"],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or f"exit status {result.returncode}"
        fail(f"Could not establish the installed Codex model catalog: {detail}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        fail(f"Codex returned an unreadable model catalog: {exc}")


def latest_astra(catalog: dict) -> tuple[str, dict]:
    models = catalog.get("models") if isinstance(catalog, dict) else None
    if not isinstance(models, list):
        fail("The Codex model catalog has no usable 'models' list.")

    candidates: list[tuple[tuple[int, ...], str, dict]] = []
    unorderable: list[str] = []
    for model in models:
        if not isinstance(model, dict) or not isinstance(model.get("slug"), str):
            continue
        slug = model["slug"]
        if "astra" not in slug.lower():
            continue
        match = MODEL_PATTERN.fullmatch(slug)
        if not match:
            unorderable.append(slug)
            continue
        candidates.append((tuple(int(part) for part in match.group(1).split(".")), slug, model))

    if unorderable:
        fail("Cannot reliably order Astra catalog entries: " + ", ".join(sorted(unorderable)))
    if not candidates:
        fail("The Codex model catalog contains no versioned Astra model.")

    candidates.sort(key=lambda item: item[0])
    newest_version = candidates[-1][0]
    newest = [entry for entry in candidates if entry[0] == newest_version]
    if len(newest) != 1:
        fail("The Codex model catalog has ambiguous Astra releases at the newest version.")
    _, slug, model = newest[0]
    levels = model.get("supported_reasoning_levels")
    max_supported = isinstance(levels, list) and any(
        isinstance(level, dict) and level.get("effort") == "max" for level in levels
    )
    if not max_supported:
        fail(f"Latest Astra {slug} does not advertise max reasoning; refusing to downgrade.")
    return slug, model


def read_profile(profile_path: Path) -> tuple[str, dict]:
    if not profile_path.is_file():
        fail(
            f"Codex profile is missing: {profile_path}\n"
            "Install the Astra Advisor profile first (or copy "
            "skills/astra-advisor/codex.config.toml to this exact path)."
        )
    try:
        raw = profile_path.read_text(encoding="utf-8")
        config = tomllib.loads(raw)
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as exc:
        fail(f"Cannot read or parse Codex profile {profile_path}: {exc}")

    if config.get("model_reasoning_effort") != "max":
        fail(f"{profile_path} must preserve model_reasoning_effort = \"max\"; refusing to run.")
    if config.get("sandbox_mode") != "read-only" or config.get("web_search") is not False:
        fail(f"{profile_path} must retain sandbox_mode = \"read-only\" and web_search = false.")
    model = config.get("model")
    if not isinstance(model, str) or not MODEL_PATTERN.fullmatch(model):
        fail(f"{profile_path} must configure a versioned Astra model at the top level; found {model!r}.")
    return raw, config


def set_model(profile_path: Path, raw: str, model: str) -> None:
    # Require exactly one top-level model assignment; never rewrite nested values.
    pattern = re.compile(r'(?m)^model\s*=\s*(["\']).*?\1\s*(?:#.*)?$')
    matches = list(pattern.finditer(raw))
    if len(matches) != 1:
        fail(f"Cannot safely identify one top-level model setting in {profile_path}.")
    updated = pattern.sub(f'model = "{model}"', raw, count=1)
    try:
        parsed = tomllib.loads(updated)
    except tomllib.TOMLDecodeError as exc:
        fail(f"Updated model setting would make {profile_path} invalid TOML: {exc}")
    if parsed.get("model") != model or parsed.get("model_reasoning_effort") != "max":
        fail("Refusing a model update that would alter the profile's required max setting.")

    mode = profile_path.stat().st_mode
    if not (mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH)) or not os.access(profile_path, os.W_OK):
        fail(
            f"Codex profile is not writable: {profile_path}\n"
            f"Required edit: change its top-level model setting to model = \"{model}\"."
        )
    fd = -1
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=f".{profile_path.name}.", dir=profile_path.parent)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(updated)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, stat.S_IMODE(mode))
        os.replace(temporary, profile_path)
    except OSError as exc:
        fail(
            f"Could not update Codex profile {profile_path}: {exc}\n"
            f"Required edit: change its top-level model setting to model = \"{model}\"."
        )
    finally:
        if fd >= 0:
            os.close(fd)
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, help="Codex home (defaults to CODEX_HOME or ~/.codex)")
    parser.add_argument("--catalog-file", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--codex-bin", default="codex", help=argparse.SUPPRESS)
    args = parser.parse_args()

    codex_home = args.codex_home or Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    profile_path = codex_home / f"{PROFILE_NAME}.config.toml"
    try:
        raw, config = read_profile(profile_path)
        if args.catalog_file:
            try:
                catalog = json.loads(args.catalog_file.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                fail(f"Cannot read mocked model catalog {args.catalog_file}: {exc}")
        else:
            codex_bin = shutil.which(args.codex_bin)
            if not codex_bin:
                fail("Codex CLI is unavailable; cannot establish its Astra model catalog.")
            catalog = catalog_from_codex(codex_bin)
        latest, _ = latest_astra(catalog)
        current = config["model"]
        if current == latest:
            print(f"Astra preflight passed: {latest} at max; profile unchanged.")
            return 0
        set_model(profile_path, raw, latest)
        print(f"Astra preflight passed: {latest} at max; profile updated ({current} -> {latest}).")
        return 0
    except PreflightError as exc:
        print(f"Astra preflight blocked: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
