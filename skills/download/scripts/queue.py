#!/usr/bin/env python3
"""Torrent and media download queuing system.

Supports:
- Adding episodic media or direct URLs to a persistent queue:
  /queue Dark item 06 1080p
  /queue "Just Because!" 01-03 1080p
  /queue add "https://example.com/file.torrent"
- Batch sequential processing when on Wi-Fi:
  /queue start
- Queue management:
  /queue list
  /queue clear
  /queue remove <id>
"""

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import time

# Try importing preflight and download helpers from download.py in same directory
try:
    from .download import (
        acquire_power_lock,
        detect_platform,
        download_direct_url,
        download_with_kura,
        find_kura_python,
        get_destination_dirs,
        parse_episode_range,
        run_preflight,
    )
except ImportError:
    # If run directly as a script without package
    script_dir = Path(__file__).resolve().parent
    sys.path.insert(0, str(script_dir))
    try:
        from download import (
            acquire_power_lock,
            detect_platform,
            download_direct_url,
            download_with_kura,
            find_kura_python,
            get_destination_dirs,
            parse_episode_range,
            run_preflight,
        )
    except ImportError:
        # Fallback minimal stubs if download.py is relocated
        def detect_platform() -> str:
            prefix = os.environ.get("PREFIX", "")
            return "termux" if ("com.termux" in prefix or "TERMUX_VERSION" in os.environ) else sys.platform

        def find_kura_python() -> str | None:
            c = Path.home() / "kura" / ".venv" / "bin" / "python"
            return str(c) if c.is_file() else sys.executable

        def get_destination_dirs(plat: str) -> dict:
            shared = Path("/storage/emulated/0/Download")
            local = Path.home() / "Downloads"
            return {"shared": shared, "local": local, "primary": shared if shared.is_dir() else local}

        @contextmanager
        def acquire_power_lock(plat: str):
            yield

        def run_preflight() -> dict:
            return {"platform": detect_platform(), "ready": True, "primary_destination": str(Path.home() / "Downloads"), "disk_free_gb": 10.0}

        def parse_episode_range(ep_str) -> list[int]:
            return [int(ep_str)] if str(ep_str).isdigit() else [1]

        def download_with_kura(*args, **kwargs) -> dict:
            return {"success": False, "error": "Kura downloader helper missing"}

        def download_direct_url(*args, **kwargs) -> dict:
            return {"success": False, "error": "Direct downloader helper missing"}


def get_queue_file() -> Path:
    """Return path to persistent queue JSON file."""
    # Preferred: inside Kura state directory (~/.local/share/kura/queue.json)
    kura_dir = Path.home() / ".local" / "share" / "kura"
    try:
        kura_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        return kura_dir / "queue.json"
    except OSError:
        pass
    fallback = Path.home() / ".kura"
    fallback.mkdir(parents=True, exist_ok=True, mode=0o700)
    return fallback / "queue.json"


@contextmanager
def queue_lock(queue_path: Path):
    """File lock around queue reads and writes to prevent race conditions."""
    lock_path = queue_path.with_suffix(".lock")
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(fd)


def load_queue(queue_path: Path | None = None) -> dict:
    """Load queue data dictionary from disk."""
    path = queue_path or get_queue_file()
    if not path.is_file():
        return {"version": 1, "items": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or "items" not in data:
            return {"version": 1, "items": []}
        return data
    except Exception:
        return {"version": 1, "items": []}


def save_queue(data: dict, queue_path: Path | None = None) -> None:
    """Atomically save queue data dictionary to disk."""
    path = queue_path or get_queue_file()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp_path = path.with_suffix(".tmp")
    content = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    tmp_path.write_text(content, encoding="utf-8")
    os.replace(str(tmp_path), str(path))


def parse_queue_entry(text: str) -> dict:
    """Smart parse natural query string into structured download parameters.

    Examples:
    - 'Dark item 06 1080p' -> query: 'Dark item', episode: '6', resolution: '1080p'
    - 'Dark item 06'       -> query: 'Dark item', episode: '6', resolution: '1080p'
    - 'Dark item 1080p'    -> query: 'Dark item', episode: '1', resolution: '1080p'
    - '"Dark item" 06'     -> query: 'Dark item', episode: '6', resolution: '1080p'
    - 'Dark item S02E06'   -> query: 'Dark item S02', episode: '6', resolution: '1080p'
    - 'Dark item 01-03'    -> query: 'Dark item', episode: '01-03', resolution: '1080p'
    - 'https://.../t.torrent' -> direct URL
    """
    text = text.strip()
    if not text:
        raise ValueError("Empty queue query")

    # Direct URL or magnet
    if text.startswith(("http://", "https://", "magnet:")):
        return {"query": text, "episode": "1", "resolution": "any", "is_url": True}

    res_val = None
    episode_val = None

    # Handle explicit --resolution / -r
    res_m = re.search(r'(?:--resolution|-r)(?:=|\s+)([a-zA-Z0-9]+)', text, re.I)
    if res_m:
        res_val = res_m.group(1).lower()
        text = text[:res_m.start()] + " " + text[res_m.end():]

    # Handle explicit --episode / -e
    ep_m = re.search(r'(?:--episode|-e)(?:=|\s+)([0-9,-]+)', text, re.I)
    if ep_m:
        episode_val = ep_m.group(1)
        text = text[:ep_m.start()] + " " + text[ep_m.end():]

    try:
        raw_tokens = shlex.split(text)
    except ValueError:
        raw_tokens = text.split()

    tokens = [t.strip() for t in raw_tokens if t.strip()]

    # Extract resolution from tokens if not found via flag
    if not res_val:
        for i, t in enumerate(tokens):
            if re.fullmatch(r'(?:480|720|1080|2160)p|any', t, re.I):
                res_val = t.lower()
                tokens.pop(i)
                break

    # Extract episode if not found via flag
    # Check for S01E06 or S02E06 pattern in tokens
    if not episode_val:
        for i, t in enumerate(tokens):
            m = re.fullmatch(r'S(\d{1,2})E(\d{1,4})', t, re.I)
            if m:
                s_num = int(m.group(1))
                episode_val = str(int(m.group(2)))
                tokens[i] = f"S{s_num:02d}"
                break

    # Check for ep/episode prefixes: e.g. "ep 06", "e06", "ep. 6"
    if not episode_val:
        for i, t in enumerate(tokens):
            m = re.fullmatch(r'(?:ep|ep\.|e)(\d{1,4})', t, re.I)
            if m:
                episode_val = str(int(m.group(1)))
                tokens.pop(i)
                break
            if t.lower() in ("ep", "ep.", "episode") and i + 1 < len(tokens):
                if re.fullmatch(r'\d{1,4}(?:-\d{1,4})?', tokens[i+1]):
                    episode_val = tokens[i+1]
                    tokens.pop(i+1)
                    tokens.pop(i)
                    break

    # Check trailing standalone episode number or range (e.g. "06", "6", "01-03")
    if not episode_val:
        for i in range(len(tokens) - 1, -1, -1):
            t = tokens[i]
            if re.fullmatch(r'\d{1,4}(?:-\d{1,4})?', t):
                episode_val = t
                tokens.pop(i)
                break

    # Strip lingering delimiters
    while tokens and tokens[-1] in ("-", "–", "—", ":"):
        tokens.pop()

    title = " ".join(tokens).strip()
    if not title:
        raise ValueError("Could not extract series title or query")

    # Normalize episode numbers: "06" -> "6", but keep ranges like "01-03" or "1-3"
    if not episode_val:
        episode_val = "1"
    elif "-" not in episode_val and "," not in episode_val:
        try:
            episode_val = str(int(episode_val))
        except ValueError:
            pass

    return {
        "query": title,
        "episode": episode_val,
        "resolution": res_val or "1080p",
        "is_url": False,
    }


def add_to_queue(raw_query: str, queue_path: Path | None = None) -> dict:
    """Add a query to the download queue."""
    parsed = parse_queue_entry(raw_query)
    qpath = queue_path or get_queue_file()

    with queue_lock(qpath):
        data = load_queue(qpath)
        items = data.get("items", [])

        # Check for existing duplicate in pending state
        for item in items:
            if item.get("status") == "pending":
                if (item.get("query", "").lower() == parsed["query"].lower() and
                        str(item.get("episode")) == str(parsed["episode"]) and
                        item.get("resolution", "").lower() == parsed["resolution"].lower()):
                    return {
                        "success": True,
                        "action": "already_queued",
                        "item": item,
                        "pending_count": sum(1 for i in items if i.get("status") == "pending"),
                        "total_count": len(items),
                        "message": f"Already in queue: {item['query']} - Episode {item['episode']} ({item['resolution']})",
                    }

        next_id = max([i.get("id", 0) for i in items], default=0) + 1
        new_item = {
            "id": next_id,
            "raw_input": raw_query,
            "query": parsed["query"],
            "episode": parsed["episode"],
            "resolution": parsed["resolution"],
            "is_url": parsed["is_url"],
            "status": "pending",
            "added_at": time.time(),
            "started_at": None,
            "completed_at": None,
            "error": None,
            "result": None,
        }
        items.append(new_item)
        data["items"] = items
        save_queue(data, qpath)

        pending_count = sum(1 for i in items if i.get("status") == "pending")
        return {
            "success": True,
            "action": "added",
            "item": new_item,
            "pending_count": pending_count,
            "total_count": len(items),
            "message": f"Added to queue [#{next_id}]: {new_item['query']} - Episode {new_item['episode']} ({new_item['resolution']})",
        }


def list_queue(queue_path: Path | None = None) -> dict:
    """Return all items in the queue with statistics."""
    qpath = queue_path or get_queue_file()
    with queue_lock(qpath):
        data = load_queue(qpath)
        items = data.get("items", [])

        pending = [i for i in items if i.get("status") == "pending"]
        completed = [i for i in items if i.get("status") == "complete" or i.get("status") == "completed"]
        failed = [i for i in items if i.get("status") == "failed"]

        return {
            "success": True,
            "total_count": len(items),
            "pending_count": len(pending),
            "completed_count": len(completed),
            "failed_count": len(failed),
            "items": items,
        }


def remove_from_queue(item_id: int, queue_path: Path | None = None) -> dict:
    """Remove a specific item by ID from the queue."""
    qpath = queue_path or get_queue_file()
    with queue_lock(qpath):
        data = load_queue(qpath)
        items = data.get("items", [])

        orig_len = len(items)
        items = [i for i in items if i.get("id") != item_id]
        found = (len(items) < orig_len)

        if found:
            data["items"] = items
            save_queue(data, qpath)

        return {
            "success": found,
            "item_id": item_id,
            "message": f"Removed item #{item_id} from queue" if found else f"Item #{item_id} not found in queue",
            "remaining_count": len(items),
        }


def clear_queue(clear_all: bool = False, queue_path: Path | None = None) -> dict:
    """Clear finished or all items from the queue."""
    qpath = queue_path or get_queue_file()
    with queue_lock(qpath):
        data = load_queue(qpath)
        items = data.get("items", [])

        if clear_all:
            cleared_count = len(items)
            data["items"] = []
        else:
            # Clear only completed or failed
            kept = [i for i in items if i.get("status") == "pending"]
            cleared_count = len(items) - len(kept)
            data["items"] = kept

        save_queue(data, qpath)
        return {
            "success": True,
            "cleared_count": cleared_count,
            "remaining_count": len(data["items"]),
            "cleared_all": clear_all,
            "message": f"Cleared {cleared_count} item(s) from queue.",
        }


def start_queue_downloads(dry_run: bool = False, stop_on_error: bool = False,
                          queue_path: Path | None = None) -> dict:
    """Download all pending items in the queue sequentially with verification."""
    qpath = queue_path or get_queue_file()
    preflight = run_preflight()
    plat = preflight.get("platform", "unknown")
    kura_py = preflight.get("kura_python")
    dirs = get_destination_dirs(plat)
    primary_dest = dirs.get("primary", Path.home() / "Downloads")

    with queue_lock(qpath):
        data = load_queue(qpath)
        items = data.get("items", [])
        pending_indices = [idx for idx, item in enumerate(items) if item.get("status") == "pending"]

    if not pending_indices:
        return {
            "success": True,
            "message": "Queue has no pending items to download.",
            "processed": 0,
            "completed": 0,
            "failed": 0,
            "results": [],
        }

    results = []
    completed_count = 0
    failed_count = 0

    with acquire_power_lock(plat):
        for idx in pending_indices:
            # Re-read and mark current item as downloading
            with queue_lock(qpath):
                data = load_queue(qpath)
                item = data["items"][idx]
                item["status"] = "downloading"
                item["started_at"] = time.time()
                save_queue(data, qpath)

            query = item["query"]
            episode_str = item.get("episode", "1")
            resolution = item.get("resolution", "1080p")
            is_url = item.get("is_url", False)

            item_success = False
            item_error = None
            item_data = None

            try:
                if is_url:
                    res = download_direct_url(query, Path(primary_dest), plat)
                    item_success = bool(res.get("success", False))
                    item_data = res
                    if not item_success:
                        item_error = res.get("error", "Direct download failed")
                else:
                    episodes = parse_episode_range(episode_str)
                    res = download_with_kura(query, episodes, resolution, dry_run, kura_py, plat)
                    item_success = bool(res.get("success", False))
                    item_data = res
                    if not item_success:
                        # Extract error message from results
                        err_parts = []
                        for sub_r in res.get("results", []):
                            err_msg = sub_r.get("data", {}).get("error", {}).get("message")
                            if err_msg:
                                err_parts.append(err_msg)
                        item_error = "; ".join(err_parts) if err_parts else "Kura acquisition failed"
            except Exception as e:
                item_success = False
                item_error = str(e)
                item_data = {"exception": str(e)}

            # Update item status in queue
            with queue_lock(qpath):
                data = load_queue(qpath)
                cur_item = data["items"][idx]
                cur_item["status"] = "completed" if item_success else "failed"
                cur_item["completed_at"] = time.time()
                cur_item["error"] = item_error
                cur_item["result"] = item_data
                save_queue(data, qpath)

            if item_success:
                completed_count += 1
            else:
                failed_count += 1

            results.append({
                "id": item.get("id"),
                "query": query,
                "episode": episode_str,
                "resolution": resolution,
                "success": item_success,
                "error": item_error,
                "data": item_data,
            })

            if not item_success and stop_on_error:
                break

    all_done = (failed_count == 0)
    return {
        "success": all_done,
        "processed": len(results),
        "completed": completed_count,
        "failed": failed_count,
        "results": results,
        "message": f"Queue execution finished: {completed_count} completed, {failed_count} failed out of {len(results)} processed.",
    }


def main():
    parser = argparse.ArgumentParser(description="Torrent and media download queuing system")
    subparsers = parser.add_subparsers(dest="subcommand", help="Queue subcommand")

    # /queue start
    start_p = subparsers.add_parser("start", help="Download all pending queue items sequentially")
    start_p.add_argument("--dry-run", action="store_true", help="Inspect and plan without downloading")
    start_p.add_argument("--stop-on-error", action="store_true", help="Halt queue processing on first failed item")
    start_p.add_argument("--json", action="store_true", help="Output machine-readable JSON")

    # /queue list
    list_p = subparsers.add_parser("list", help="List all items in the queue")
    list_p.add_argument("--all", action="store_true", help="Include completed and failed items")
    list_p.add_argument("--json", action="store_true", help="Output machine-readable JSON")

    # /queue add
    add_p = subparsers.add_parser("add", help="Add an item to the queue")
    add_p.add_argument("query", nargs="+", help="Series title, query, or direct URL")
    add_p.add_argument("--episode", "-e", help="Explicit episode number or range")
    add_p.add_argument("--resolution", "-r", choices=["480p", "720p", "1080p", "2160p", "any"], help="Target resolution")
    add_p.add_argument("--json", action="store_true", help="Output machine-readable JSON")

    # /queue remove
    rm_p = subparsers.add_parser("remove", help="Remove an item from the queue by ID")
    rm_p.add_argument("id", type=int, help="Queue item ID to remove")
    rm_p.add_argument("--json", action="store_true", help="Output machine-readable JSON")

    # /queue clear
    clear_p = subparsers.add_parser("clear", help="Clear finished items from the queue")
    clear_p.add_argument("--all", action="store_true", help="Clear entire queue including pending items")
    clear_p.add_argument("--json", action="store_true", help="Output machine-readable JSON")

    # /queue status (alias for list)
    status_p = subparsers.add_parser("status", help="Show queue status summary")
    status_p.add_argument("--json", action="store_true", help="Output machine-readable JSON")

    # If first arg is not a known subcommand and not a help flag, treat as direct add:
    # E.g.: python3 queue.py Dark item 06 1080p
    known_commands = {"start", "list", "add", "remove", "rm", "delete", "clear", "status", "show", "help"}
    raw_args = sys.argv[1:]

    if raw_args and not raw_args[0].startswith("-") and raw_args[0].lower() not in known_commands:
        # Implicit add
        raw_args = ["add"] + raw_args

    args = parser.parse_args(raw_args)

    if not args.subcommand or args.subcommand in ("list", "status", "show"):
        res = list_queue()
        is_json = getattr(args, "json", False)
        if is_json:
            print(json.dumps(res, indent=2))
        else:
            items = res.get("items", [])
            print(f"Torrent Download Queue ({res['pending_count']} pending, {res['completed_count']} completed, {res['failed_count']} failed):")
            if not items:
                print("  (Queue is empty. Add items with '/queue <title> [ep] [res]')")
            else:
                for it in items:
                    st = it.get("status", "unknown").upper()
                    ep_disp = f"Ep {it.get('episode')}" if not it.get("is_url") else "URL"
                    res_disp = f"({it.get('resolution')})" if not it.get("is_url") else ""
                    print(f"  [#{it.get('id')}] [{st:9}] {it.get('query')} - {ep_disp} {res_disp}")
                    if it.get("error"):
                        print(f"       Error: {it.get('error')}")
        sys.exit(0)

    if args.subcommand == "add":
        query_text = " ".join(args.query).strip()
        if args.episode:
            query_text += f" --episode {args.episode}"
        if args.resolution:
            query_text += f" --resolution {args.resolution}"
        try:
            res = add_to_queue(query_text)
            if args.json:
                print(json.dumps(res, indent=2))
            else:
                print(res["message"])
                print(f"Total pending: {res['pending_count']}. Run '/queue start' when on Wi-Fi.")
            sys.exit(0)
        except Exception as e:
            if args.json:
                print(json.dumps({"success": False, "error": str(e)}))
            else:
                print(f"Error adding to queue: {e}", file=sys.stderr)
            sys.exit(1)

    if args.subcommand == "start":
        res = start_queue_downloads(dry_run=args.dry_run, stop_on_error=args.stop_on_error)
        if args.json:
            print(json.dumps(res, indent=2))
        else:
            print(res["message"])
            for r in res.get("results", []):
                sym = "✓" if r["success"] else "✗"
                print(f"  {sym} [#{r['id']}] {r['query']} Ep {r['episode']} ({r['resolution']})")
                if not r["success"]:
                    print(f"      Failure reason: {r.get('error')}")
        sys.exit(0 if res.get("success") else 1)

    if args.subcommand in ("remove", "rm", "delete"):
        res = remove_from_queue(args.id)
        if args.json:
            print(json.dumps(res, indent=2))
        else:
            print(res["message"])
        sys.exit(0 if res.get("success") else 1)

    if args.subcommand == "clear":
        res = clear_queue(clear_all=args.all)
        if args.json:
            print(json.dumps(res, indent=2))
        else:
            print(res["message"])
        sys.exit(0)


if __name__ == "__main__":
    main()
