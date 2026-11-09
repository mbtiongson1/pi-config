#!/usr/bin/env python3
"""Precise cross-platform downloader with device preflights.

Supports:
- Anime & episodic media via Kura with release verification, resume handling,
  and power management (wake-lock).
- Direct file / torrent / URL downloads via aria2c or curl.
- Android shared downloads organization & media scanning.
"""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time


def detect_platform() -> str:
    """Return normalized platform: termux, darwin, linux, wsl, or windows."""
    prefix = os.environ.get("PREFIX", "")
    if "com.termux" in prefix or "TERMUX_VERSION" in os.environ:
        return "termux"
    system = platform.system().lower()
    if system == "darwin":
        return "darwin"
    if system == "windows":
        return "windows"
    if system == "linux":
        try:
            with open("/proc/version", "r", encoding="utf-8", errors="ignore") as f:
                if "microsoft" in f.read().lower():
                    return "wsl"
        except OSError:
            pass
        return "linux"
    return system or "unknown"


def find_kura_python() -> str | None:
    """Find virtualenv python for Kura if installed."""
    candidates = [
        Path.home() / "kura" / ".venv" / "bin" / "python",
        Path.home() / ".kura" / ".venv" / "bin" / "python",
        Path("/data/data/com.termux/files/home/kura/.venv/bin/python"),
    ]
    for c in candidates:
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)
    # Check if kura is in current python
    try:
        res = subprocess.run([sys.executable, "-m", "kura", "--help"],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if res.returncode == 0:
            return sys.executable
    except Exception:
        pass
    return None


def get_destination_dirs(plat: str) -> dict:
    """Return primary shared and local download directories."""
    home = Path.home()
    if plat == "termux":
        shared = Path("/storage/emulated/0/Download")
        local = home / "Downloads"
        return {"shared": shared, "local": local, "primary": shared if shared.is_dir() else local}
    elif plat == "wsl":
        win_down = None
        c_users = Path("/mnt/c/Users")
        if c_users.is_dir():
            for u in c_users.iterdir():
                if u.is_dir() and u.name not in ("Default", "Public", "All Users"):
                    ud = u / "Downloads"
                    if ud.is_dir():
                        win_down = ud
                        break
        local = home / "Downloads"
        return {"shared": win_down, "local": local, "primary": win_down or local}
    else:
        local = home / "Downloads"
        return {"shared": None, "local": local, "primary": local}


@contextmanager
def acquire_power_lock(plat: str):
    """Keep system awake during download."""
    lock_proc = None
    if plat == "termux" and shutil.which("termux-wake-lock"):
        try:
            subprocess.run(["termux-wake-lock"], check=False)
        except Exception:
            pass
    try:
        yield
    finally:
        if plat == "termux" and shutil.which("termux-wake-unlock"):
            try:
                subprocess.run(["termux-wake-unlock"], check=False)
            except Exception:
                pass


def run_preflight() -> dict:
    """Run device preflights: check disk space, downloaders, wake locks, and storage."""
    plat = detect_platform()
    dirs = get_destination_dirs(plat)
    primary = dirs["primary"]

    # Disk usage
    disk_free_gb = 0.0
    try:
        primary.mkdir(parents=True, exist_ok=True)
        usage = shutil.disk_usage(primary)
        disk_free_gb = round(usage.free / (1024**3), 2)
    except OSError:
        pass

    kura_py = find_kura_python()
    aria2_bin = shutil.which("aria2c")
    curl_bin = shutil.which("curl")

    power_mgmt = None
    if plat == "termux":
        power_mgmt = "termux-wake-lock" if shutil.which("termux-wake-lock") else "none"
    elif plat == "darwin":
        power_mgmt = "caffeinate" if shutil.which("caffeinate") else "none"
    elif plat in ("linux", "wsl"):
        power_mgmt = "systemd-inhibit" if shutil.which("systemd-inhibit") else "none"

    preflight = {
        "platform": plat,
        "os_name": platform.system(),
        "arch": platform.machine(),
        "primary_destination": str(primary),
        "disk_free_gb": disk_free_gb,
        "has_kura": bool(kura_py),
        "kura_python": kura_py,
        "has_aria2c": bool(aria2_bin),
        "aria2c_binary": aria2_bin,
        "has_curl": bool(curl_bin),
        "power_management": power_mgmt,
        "ready": bool(kura_py or aria2_bin or curl_bin),
        "notes": [],
    }

    if plat == "termux":
        shared = Path("/storage/emulated/0/Download")
        if not shared.is_dir():
            preflight["notes"].append("Run 'termux-setup-storage' to grant shared storage access.")
        if shutil.which("termux-media-scan"):
            preflight["media_scanner"] = "termux-media-scan"

    if disk_free_gb < 1.0:
        preflight["notes"].append(f"Low disk space on {primary}: {disk_free_gb} GB remaining.")

    return preflight


def parse_episode_range(ep_str: str | int | None) -> list[int]:
    """Parse episode specification: 1, '1-3', '1,2,3'."""
    if ep_str is None:
        return [1]
    if isinstance(ep_str, int):
        return [ep_str]
    s = str(ep_str).strip()
    if not s:
        return [1]
    episodes: list[int] = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            start_s, _, end_s = part.partition("-")
            try:
                start = int(start_s.strip())
                end = int(end_s.strip())
                episodes.extend(range(start, end + 1))
            except ValueError:
                pass
        else:
            try:
                episodes.append(int(part))
            except ValueError:
                pass
    return episodes or [1]


def download_with_kura(query: str, episodes: list[int], resolution: str, dry_run: bool,
                       kura_py: str, plat: str) -> dict:
    """Download episodes via local Kura engine with verification."""
    results = []
    dest_flag = "shared" if plat == "termux" and Path("/storage/emulated/0/Download").is_dir() else "private"
    kura_cwd = Path(kura_py).parents[2] if "bin" in kura_py else Path.cwd()

    with acquire_power_lock(plat):
        for ep in episodes:
            cmd = [kura_py, "-m", "kura", "download", query, "--episode", str(ep),
                   "--destination", dest_flag]
            if resolution and resolution != "any":
                cmd.extend(["--resolution", resolution])
            if dry_run:
                cmd.append("--dry-run")
            else:
                cmd.append("--yes")

            proc = subprocess.run(cmd, cwd=str(kura_cwd), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                data = json.loads(proc.stdout)
            except Exception:
                data = {"raw_stdout": proc.stdout, "raw_stderr": proc.stderr}

            ok = (proc.returncode == 0 and data.get("success", False))

            # If not dry run and successful, organize to downloads
            if ok and not dry_run:
                job_data = data.get("data", {})
                evidence = job_data.get("evidence", {})
                file_path = Path(evidence.get("path", ""))
                if file_path.exists():
                    filename = file_path.name
                    # On Termux, ensure direct file in /storage/emulated/0/Download/ and symlink in ~/Downloads
                    if plat == "termux":
                        shared_target = Path("/storage/emulated/0/Download") / filename
                        if str(file_path) != str(shared_target):
                            try:
                                shutil.copy2(file_path, shared_target)
                                if shutil.which("termux-media-scan"):
                                    subprocess.run(["termux-media-scan", str(shared_target)], check=False)
                            except Exception:
                                pass
                        local_target = Path.home() / "Downloads" / filename
                        try:
                            Path.home().joinpath("Downloads").mkdir(parents=True, exist_ok=True)
                            if local_target.exists() or local_target.is_symlink():
                                local_target.unlink()
                            local_target.symlink_to(file_path)
                        except Exception:
                            pass

            results.append({"episode": ep, "success": ok, "exit_code": proc.returncode, "data": data})
            if not ok and not dry_run:
                break

    all_ok = all(r["success"] for r in results)
    return {"engine": "kura", "query": query, "episodes": episodes, "success": all_ok, "results": results}


def download_direct_url(url: str, dest_dir: Path, plat: str) -> dict:
    """Download generic URL with aria2c or curl."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    aria2_bin = shutil.which("aria2c")
    curl_bin = shutil.which("curl")

    with acquire_power_lock(plat):
        if aria2_bin:
            cmd = [aria2_bin, "--dir", str(dest_dir), "--summary-interval=0", url]
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            ok = (proc.returncode == 0)
            return {"engine": "aria2c", "url": url, "destination": str(dest_dir), "success": ok, "output": proc.stdout}
        elif curl_bin:
            filename = url.rstrip("/").split("/")[-1] or "downloaded_file"
            target = dest_dir / filename
            cmd = [curl_bin, "-L", "-o", str(target), url]
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            ok = (proc.returncode == 0)
            return {"engine": "curl", "url": url, "destination": str(target), "success": ok, "output": proc.stderr}
        else:
            return {"engine": "none", "url": url, "success": False, "error": "Neither aria2c nor curl found in PATH"}


def main():
    parser = argparse.ArgumentParser(description="Precise downloader with device preflights")
    parser.add_argument("query", nargs="?", help="Series title, query, or direct URL")
    parser.add_argument("--episode", "-e", default="1", help="Episode number, range (e.g. 1-3), or comma-separated list")
    parser.add_argument("--resolution", "-r", default="1080p", choices=["480p", "720p", "1080p", "2160p", "any"], help="Target resolution")
    parser.add_argument("--dry-run", action="store_true", help="Inspect and plan download without running")
    parser.add_argument("--preflight", action="store_true", help="Run device preflight checks and print status")
    parser.add_argument("--json", action="store_true", help="Output machine-readable JSON")
    args = parser.parse_args()

    preflight = run_preflight()
    if args.preflight or not args.query:
        if args.json:
            print(json.dumps(preflight, indent=2))
        else:
            print(f"Platform: {preflight['platform']} ({preflight['os_name']} {preflight['arch']})")
            print(f"Primary download destination: {preflight['primary_destination']}")
            print(f"Free disk space: {preflight['disk_free_gb']} GB")
            print(f"Kura available: {preflight['has_kura']} ({preflight['kura_python']})")
            print(f"aria2c available: {preflight['has_aria2c']}")
            print(f"Power management: {preflight['power_management']}")
            print(f"Ready: {preflight['ready']}")
            for n in preflight["notes"]:
                print(f"Note: {n}")
        sys.exit(0 if preflight["ready"] else 1)

    plat = preflight["platform"]
    query = args.query.strip()
    is_url = query.startswith("http://") or query.startswith("https://") or query.startswith("magnet:")

    if is_url:
        dest = Path(preflight["primary_destination"])
        res = download_direct_url(query, dest, plat)
    elif preflight["has_kura"]:
        episodes = parse_episode_range(args.episode)
        res = download_with_kura(query, episodes, args.resolution, args.dry_run, preflight["kura_python"], plat)
    else:
        res = {"success": False, "error": "Kura is not available and input is not a direct URL."}

    if args.json:
        print(json.dumps(res, indent=2))
    else:
        if res.get("success"):
            print(f"Download complete / planned successfully: {query}")
        else:
            print(f"Download failed: {res.get('error', 'Check output logs')}", file=sys.stderr)

    sys.exit(0 if res.get("success") else 1)


if __name__ == "__main__":
    main()
