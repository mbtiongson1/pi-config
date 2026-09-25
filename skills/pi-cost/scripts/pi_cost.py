#!/usr/bin/env python3
"""Pi session costs: logged main-orchestrator dollars, catalog-priced workers.

Worker inference is priced from Gaia skill-cost's LiteLLM catalog, including
separate cache-read and cache-creation tokens. No worker inherits the harness's
possibly incorrect cost field. The main orchestrator is deliberately unchanged:
its harness-recorded cost is reported, never repriced by this script.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PRICES_JSON = Path(__file__).with_name("prices.json")
LITELLM_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main/"
    "model_prices_and_context_window.json"
)
MAX_CATALOG_BYTES = 25_000_000
EFFORT_SUFFIXES = (":low", ":medium", ":high", ":xhigh", ":minimal")
WORKER_PROVIDERS = ("antigravity/", "google-antigravity/", "openai-codex/", "openai/", "anthropic/", "google/")


def _timestamp(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError):
        return None


def _age_days(catalog: dict, now: datetime) -> float:
    # The embedded fetch date, not mtime: copying an old sheet must not reset TTL.
    fetched = _timestamp(catalog.get("_meta", {}).get("fetched_at"))
    if fetched is None or fetched > now:
        return float("inf")
    return (now - fetched).total_seconds() / 86400


def _read_catalog(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("_meta"), dict):
            raise ValueError("missing catalog metadata")
        return data
    except (OSError, ValueError, TypeError) as exc:
        print(f"warning: cannot read prices at {path}: {exc}", file=sys.stderr)
        return None


def refresh_prices(path: Path = PRICES_JSON, *, now: datetime | None = None) -> dict:
    """Fetch LiteLLM's public rate sheet, prune and atomically replace the cache."""
    now = now or datetime.now(timezone.utc)
    req = urllib.request.Request(LITELLM_URL, headers={"User-Agent": "pi-cost/skill-cost"})
    with urllib.request.urlopen(req, timeout=30) as response:
        raw = response.read(MAX_CATALOG_BYTES + 1)
    if len(raw) > MAX_CATALOG_BYTES:
        raise ValueError("price catalog exceeded size limit")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("price catalog must be an object")
    pruned = {}
    for name, item in data.items():
        if not isinstance(item, dict) or not isinstance(name, str):
            continue
        inp, out = item.get("input_cost_per_token"), item.get("output_cost_per_token")
        if inp is None and out is None:
            continue
        pruned[name] = {
            "input": inp, "output": out,
            "cache_read": item.get("cache_read_input_token_cost"),
            "cache_write": item.get("cache_creation_input_token_cost"),
            "provider": item.get("litellm_provider"),
        }
    # Reject a partial/error response rather than replacing a usable snapshot.
    if len(pruned) < 100 or "gpt-6-luna" not in pruned or "gemini/gemini-3.8-flash" not in pruned:
        raise ValueError("price catalog incomplete; keeping cached sheet")
    pruned["_meta"] = {
        "source": "BerriAI/litellm model_prices_and_context_window.json",
        "source_url": LITELLM_URL,
        "source_license": "MIT",
        "source_repo": "https://github.com/BerriAI/litellm",
        "fetched_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model_count": len(pruned),
        "note": "Pruned using gaia-research/skill-cost's catalog schema for pi-cost.",
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".prices-", suffix=".json", delete=False) as out:
            temp_path = Path(out.name)
            json.dump(pruned, out, indent=2, sort_keys=True)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
    return pruned


def load_prices(path: Path = PRICES_JSON, *, offline: bool = False, force: bool = False,
                now: datetime | None = None, max_age_days: int | None = None) -> tuple[dict, bool]:
    """On every invocation, refresh if the *catalog fetch date* is 7+ days old.

    On network failure use the dated cached catalog with an explicit warning.
    A missing/unparseable catalog without a successful refresh fails closed.
    """
    now = now or datetime.now(timezone.utc)
    if max_age_days is None:
        try:
            max_age_days = max(0, int(os.environ.get("PI_COST_MAX_AGE_DAYS", "7")))
        except ValueError:
            max_age_days = 7
    current = _read_catalog(path)
    stale = current is None or _age_days(current, now) >= max_age_days
    no_auto = os.environ.get("PI_COST_NO_AUTO_REFRESH", "").lower() in ("1", "true", "yes")
    if force and offline:
        raise ValueError("--refresh-prices cannot be combined with --offline")
    if (force or stale and not (offline or no_auto)):
        try:
            current = refresh_prices(path, now=now)
            stale = False
        except Exception as exc:
            if force:
                raise ValueError(f"forced price refresh failed: {exc}") from exc
            print(f"warning: price refresh failed ({exc}); using dated cached catalog if available", file=sys.stderr)
    if current is None:
        raise ValueError("no usable price catalog; refresh required")
    if stale:
        print(f"warning: price catalog is stale (fetched {current['_meta'].get('fetched_at', 'unknown')}); estimates are dated", file=sys.stderr)
    return current, stale


def _tokens(usage: dict, field: str) -> int | None:
    value = usage.get(field, 0)
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
        return number if number >= 0 and number == float(value) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _model_key(model: str, catalog: dict) -> str | None:
    """Only exact catalog keys after known Pi provider/effort normalization."""
    model = (model or "").lower()
    if model in catalog and model != "_meta":
        return model
    for prefix in WORKER_PROVIDERS:
        if model.startswith(prefix):
            model = model[len(prefix):]
            break
    else:
        if "/" in model:
            return None  # never guess a foreign provider's pricing
    for suffix in EFFORT_SUFFIXES:
        if model.endswith(suffix):
            model = model[:-len(suffix)]
            break
    candidates = [model]
    if model.startswith("gemini-"):
        candidates.insert(0, "gemini/" + model)
    for key in candidates:
        if key in catalog and key != "_meta":
            return key
    return None


def price_worker(usage: dict, model: str, catalog: dict) -> dict:
    """Price positive usage at explicit LiteLLM rates. Missing cache rate = unknown."""
    key = _model_key(model, catalog)
    fields = (("input", "input"), ("output", "output"),
              ("cacheRead", "cache_read"), ("cacheWrite", "cache_write"))
    tokens = {name: _tokens(usage, name) for name, _ in fields}
    result = {"model_key": key, "tokens": tokens, "parts": {}, "total": None, "unpriced": []}
    if key is None:
        result["unpriced"] = ["model"]
        return result
    rates = catalog[key]
    for name, rate_name in fields:
        count = tokens[name]
        rate = rates.get(rate_name)
        if count is None or count > 0 and (not isinstance(rate, (int, float)) or isinstance(rate, bool) or rate < 0):
            result["unpriced"].append(name)
        else:
            result["parts"][name] = count * (rate if count else 0)
    if not result["unpriced"]:
        result["total"] = sum(result["parts"].values())
    return result


def _main_logged_cost(usage: dict) -> float | None:
    cost = usage.get("cost")
    if isinstance(cost, dict):
        value = cost.get("total")
        if isinstance(value, (int, float)) and value > 0:
            return float(value)
    # Some compaction/tool events are zero-token, zero-cost usage records.
    if all(_tokens(usage, field) == 0 for field in ("input", "output", "cacheRead", "cacheWrite")):
        return 0.0
    # The main orchestrator is not repriced; uncosted nonzero usage is unknown.
    return None


def _runs(results: list, catalog: dict, *, origin: str, seen_nested: set) -> tuple[list, list]:
    direct, nested = [], []
    for result in results:
        usage = result.get("usage") or {}
        failed = result.get("exitCode") != 0
        zero_usage_failure = failed and all(
            _tokens(usage, field) == 0 for field in ("input", "output", "cacheRead", "cacheWrite")
        )
        priced = ({"model_key": None, "tokens": {}, "parts": {}, "total": 0.0, "unpriced": []}
                  if zero_usage_failure else price_worker(usage, result.get("model") or "", catalog))
        entry = {"origin": origin, "agent": result.get("agent"), "model": result.get("model"),
                 "task": result.get("task", ""), "turns": usage.get("turns", 0),
                 "failed": failed, "logged_cost": usage.get("cost"), **priced}
        direct.append(entry)
        for msg in result.get("messages") or []:
            if not isinstance(msg, dict) or msg.get("role") != "toolResult" or msg.get("toolName") != "subagent":
                continue
            call_id = msg.get("toolCallId")
            if call_id and call_id in seen_nested:
                continue
            if call_id:
                seen_nested.add(call_id)
            children = (msg.get("details") or {}).get("results") or []
            children_direct, descendants = _runs(children, catalog, origin="nested", seen_nested=seen_nested)
            nested.extend(children_direct)
            nested.extend(descendants)
    return direct, nested


def report_session(path: Path, catalog: dict) -> dict:
    main = {"turns": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
            "logged_cost": 0.0, "cost_missing": False, "models": set()}
    direct, nested = [], []
    seen_nested = set()
    with path.open(encoding="utf-8") as source:
        for line_num, line in enumerate(source, 1):
            try:
                data = json.loads(line)
            except ValueError:
                continue
            msg = data.get("message") or {}
            if msg.get("role") == "assistant" and msg.get("usage"):
                usage = msg["usage"]
                main["models"].add(f"{msg.get('provider') or data.get('provider') or ''}/{msg.get('model') or data.get('model') or ''}".lstrip("/"))
                content = msg.get("content") or []
                if not content or any(part.get("type") != "toolCall" for part in content if isinstance(part, dict)):
                    main["turns"] += 1
                for field in ("input", "output", "cacheRead", "cacheWrite"):
                    main[field] += _tokens(usage, field) or 0
                cost = _main_logged_cost(usage)
                if cost is None:
                    main["cost_missing"] = True
                else:
                    main["logged_cost"] += cost
            elif msg.get("role") == "toolResult" and msg.get("toolName") == "subagent":
                rs, ns = _runs((msg.get("details") or {}).get("results") or [], catalog,
                               origin=f"line {line_num}", seen_nested=seen_nested)
                direct.extend(rs)
                nested.extend(ns)
    main["models"] = sorted(main["models"])
    worker_runs = direct + nested
    unknown = any(run["total"] is None for run in worker_runs)
    workers = sum(run["total"] or 0 for run in worker_runs)
    return {"session": str(path), "main": main, "direct": direct, "nested": nested,
            "worker_priced_usd": None if unknown else workers,
            "total_usd": None if unknown or main["cost_missing"] else main["logged_cost"] + workers}


def _money(value: float | None) -> str:
    return "unavailable" if value is None else f"${value:.4f}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", help="path to a Pi JSONL session (default: PI_SESSION_FILE or newest)")
    parser.add_argument("--offline", action="store_true", help="skip network; mark stale catalog explicitly")
    parser.add_argument("--refresh-prices", action="store_true", help="force an atomic LiteLLM price refresh")
    parser.add_argument("--json", action="store_true", help="print machine-readable report")
    args = parser.parse_args(argv)
    try:
        catalog, stale = load_prices(offline=args.offline, force=args.refresh_prices)
    except ValueError as exc:
        parser.error(str(exc))
    session_file = args.session or os.environ.get("PI_SESSION_FILE")
    if not session_file:
        sessions = glob.glob(os.path.expanduser("~/.pi/agent/sessions/*/*.jsonl"))
        session_file = max(sessions, key=os.path.getmtime) if sessions else None
    if not session_file or not Path(session_file).is_file():
        parser.error("no Pi session file found")
    report = report_session(Path(session_file), catalog)
    report["catalog"] = {"source": catalog["_meta"].get("source_url"),
                         "fetched_at": catalog["_meta"].get("fetched_at"), "stale": stale}
    if args.json:
        print(json.dumps(report, indent=2))
        return 0
    m = report["main"]
    print(f"PI SESSION: {Path(session_file).name}")
    print(f"Catalog: {report['catalog']['fetched_at']} ({'STALE' if stale else 'current'}) · {report['catalog']['source']}")
    print(f"Main orchestrator (unchanged harness cost): {_money(None if m['cost_missing'] else m['logged_cost'])}; "
          f"{m['turns']} turns · input {m['input']:,}, output {m['output']:,}, "
          f"cache read {m['cacheRead']:,}, cache write {m['cacheWrite']:,}")
    for label, runs in (("Direct workers", report["direct"]), ("Nested workers", report["nested"])):
        print(f"{label}: {len(runs)} results ({sum(not r['failed'] for r in runs)} completed, "
              f"{sum(r['failed'] for r in runs)} failed)")
        for index, run in enumerate(runs, 1):
            tok = run["tokens"]
            print(f"  {index:2d}. {run['agent']} ({run['model'] or 'no model'}) "
                  f"{run['turns']} turns · {_money(run['total'])} public-rate "
                  f"[in={tok.get('input', 0)}, out={tok.get('output', 0)}, "
                  f"cache_r={tok.get('cacheRead', 0)}, cache_w={tok.get('cacheWrite', 0)}] "
                  f"{'FAILED' if run['failed'] else run['model_key'] or 'unpriced'}")
        if runs:
            print(f"  Subtotal: {_money(None if any(r['total'] is None for r in runs) else sum(r['total'] for r in runs))}")
    print(f"Workers public-rate estimate: {_money(report['worker_priced_usd'])}")
    print(f"Mixed-method total (logged main + priced workers): {_money(report['total_usd'])}")
    print("Rates are public estimates, not provider invoices; missing model/cache rates fail closed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
