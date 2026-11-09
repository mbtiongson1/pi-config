#!/usr/bin/env python3
"""Cross-platform opener with device preflights.

Dispatches files, directories, or URLs to the native viewer/player:
- Android / Termux: termux-open (supports MX Player, VLC, Gallery, etc.)
- macOS: open
- Linux: xdg-open / gio
- Windows / WSL: wslview / explorer.exe / cmd.exe start
"""

import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys


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
        # Check for WSL
        try:
            with open("/proc/version", "r", encoding="utf-8", errors="ignore") as f:
                if "microsoft" in f.read().lower():
                    return "wsl"
        except OSError:
            pass
        return "linux"
    return system or "unknown"


def get_default_downloads_dirs(plat: str) -> list[Path]:
    """Return ordered list of candidate download directories for platform."""
    home = Path.home()
    dirs: list[Path] = []
    if plat == "termux":
        shared = Path("/storage/emulated/0/Download")
        if shared.is_dir():
            dirs.append(shared)
            kura_dir = shared / "Kura"
            if kura_dir.is_dir():
                dirs.append(kura_dir)
        user_down = home / "storage" / "downloads"
        if user_down.is_dir():
            dirs.append(user_down)
        dirs.append(home / "Downloads")
    elif plat == "darwin":
        dirs.append(home / "Downloads")
    elif plat == "wsl":
        # Check Windows user download directory mounted in /mnt/c
        user_profile = os.environ.get("USERPROFILE")
        if user_profile:
            win_down = Path(user_profile) / "Downloads"
            if win_down.is_dir():
                dirs.append(win_down)
        c_users = Path("/mnt/c/Users")
        if c_users.is_dir():
            for u in c_users.iterdir():
                if u.is_dir() and u.name not in ("Default", "Public", "All Users"):
                    ud = u / "Downloads"
                    if ud.is_dir():
                        dirs.append(ud)
        dirs.append(home / "Downloads")
    else:  # linux
        xdg_down = os.environ.get("XDG_DOWNLOAD_DIR")
        if xdg_down and Path(xdg_down).is_dir():
            dirs.append(Path(xdg_down))
        dirs.append(home / "Downloads")
    return dirs


def run_preflight() -> dict:
    """Evaluate device environment, opener tool availability, and downloads directories."""
    plat = detect_platform()
    checks: dict = {
        "platform": plat,
        "os_name": platform.system(),
        "arch": platform.machine(),
        "opener_binary": None,
        "opener_available": False,
        "gui_capable": True,
        "downloads_dirs": [str(d) for d in get_default_downloads_dirs(plat)],
        "ready": False,
        "notes": [],
    }

    if plat == "termux":
        checks["opener_binary"] = "termux-open"
        bin_path = shutil.which("termux-open")
        checks["opener_available"] = bool(bin_path)
        if not bin_path:
            checks["notes"].append("termux-tools or termux-open missing; run pkg install termux-tools")
        shared_down = Path("/storage/emulated/0/Download")
        if not shared_down.is_dir():
            checks["notes"].append("Storage permission not set; run termux-setup-storage")
        checks["ready"] = bool(checks["opener_available"])
    elif plat == "darwin":
        checks["opener_binary"] = "open"
        checks["opener_available"] = bool(shutil.which("open"))
        checks["ready"] = checks["opener_available"]
    elif plat == "wsl":
        for b in ("wslview", "cmd.exe", "powershell.exe", "explorer.exe"):
            if shutil.which(b):
                checks["opener_binary"] = b
                checks["opener_available"] = True
                break
        if not checks["opener_available"]:
            checks["notes"].append("No WSL opener found; install wslu (sudo apt install wslu) for wslview")
        checks["ready"] = checks["opener_available"]
    elif plat == "windows":
        for b in ("start", "explorer.exe", "powershell.exe"):
            if shutil.which(b) or b == "start":
                checks["opener_binary"] = b
                checks["opener_available"] = True
                break
        checks["ready"] = checks["opener_available"]
    else:  # linux
        for b in ("xdg-open", "gio"):
            if shutil.which(b):
                checks["opener_binary"] = b
                checks["opener_available"] = True
                break
        has_display = bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
        checks["gui_capable"] = has_display
        if not has_display:
            checks["notes"].append("No DISPLAY or WAYLAND_DISPLAY detected; running in headless Linux")
        checks["ready"] = checks["opener_available"]

    return checks


def find_latest_download(plat: str) -> Path | None:
    """Find the most recently modified download or media file."""
    search_dirs = get_default_downloads_dirs(plat)
    candidates: list[Path] = []
    exts = {".mkv", ".mp4", ".avi", ".webm", ".mp3", ".flac", ".pdf", ".zip", ".tar.gz", ".png", ".jpg"}

    for d in search_dirs:
        if not d.is_dir():
            continue
        try:
            # Check direct children and one level of subdirectories (e.g. Kura/<infohash>)
            for item in d.iterdir():
                if item.is_file() and (item.suffix.lower() in exts or not item.name.endswith(".aria2")):
                    candidates.append(item)
                elif item.is_dir() and item.name == "Kura":
                    for sub in item.iterdir():
                        if sub.is_dir():
                            for subfile in sub.iterdir():
                                if subfile.is_file() and subfile.suffix.lower() in exts:
                                    candidates.append(subfile)
        except OSError:
            continue

    if not candidates:
        return None
    # Sort by mtime descending
    candidates.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    return candidates[0]


def resolve_target(path_str: str | None, plat: str) -> Path:
    """Resolve file or find latest if none given."""
    if not path_str or path_str.strip() in ("", "--latest"):
        latest = find_latest_download(plat)
        if not latest:
            raise FileNotFoundError("No recent downloaded files found in downloads directories.")
        return latest

    p = Path(path_str).expanduser()
    if p.exists():
        return p

    # Check downloads dirs for partial filename match
    clean_name = path_str.strip().lower()
    for d in get_default_downloads_dirs(plat):
        if not d.is_dir():
            continue
        try:
            for item in d.rglob("*"):
                if item.is_file() and clean_name in item.name.lower():
                    return item
        except OSError:
            continue

    raise FileNotFoundError(f"File not found: {path_str}")


def open_target(target: Path, plat: str, chooser: bool = False, content_type: str | None = None) -> tuple[int, str]:
    """Open target with native platform tool."""
    target_abs = str(target.resolve() if target.is_symlink() else target.absolute())

    if plat == "termux":
        cmd = ["termux-open"]
        if chooser:
            cmd.append("--chooser")
        if content_type:
            cmd.extend(["--content-type", content_type])
        cmd.append(target_abs)
    elif plat == "darwin":
        cmd = ["open", target_abs]
    elif plat == "wsl":
        wslview = shutil.which("wslview")
        if wslview:
            cmd = ["wslview", target_abs]
        else:
            # Fallback to cmd.exe /c start
            try:
                win_path = subprocess.check_output(["wslpath", "-w", target_abs], text=True).strip()
            except Exception:
                win_path = target_abs
            cmd = ["cmd.exe", "/c", "start", "", win_path]
    elif plat == "windows":
        cmd = ["cmd.exe", "/c", "start", "", target_abs]
    else:  # linux
        cmd = ["xdg-open", target_abs]

    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out = (proc.stdout + proc.stderr).strip()
    return proc.returncode, out


def main():
    parser = argparse.ArgumentParser(description="Cross-platform native opener with preflights")
    parser.add_argument("path", nargs="?", default=None, help="Path or filename to open (omitted for latest download)")
    parser.add_argument("--preflight", action="store_true", help="Run device preflight checks and print status")
    parser.add_argument("--chooser", action="store_true", help="Prompt with Android/OS app chooser")
    parser.add_argument("--content-type", help="MIME content type hint")
    parser.add_argument("--json", action="store_true", help="Output result as JSON")
    args = parser.parse_args()

    preflight = run_preflight()
    if args.preflight:
        if args.json:
            print(json.dumps(preflight, indent=2))
        else:
            print(f"Platform: {preflight['platform']} ({preflight['os_name']} {preflight['arch']})")
            print(f"Opener binary: {preflight['opener_binary']} (available: {preflight['opener_available']})")
            print(f"Ready: {preflight['ready']}")
            if preflight["downloads_dirs"]:
                print(f"Downloads dirs: {', '.join(preflight['downloads_dirs'])}")
            if preflight["notes"]:
                for n in preflight["notes"]:
                    print(f"Note: {n}")
        sys.exit(0 if preflight["ready"] else 1)

    plat = preflight["platform"]
    try:
        target = resolve_target(args.path, plat)
    except FileNotFoundError as e:
        if args.json:
            print(json.dumps({"success": False, "error": str(e), "preflight": preflight}))
        else:
            print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    code, out = open_target(target, plat, chooser=args.chooser, content_type=args.content_type)
    success = (code == 0)

    if args.json:
        result = {
            "success": success,
            "exit_code": code,
            "target": str(target),
            "platform": plat,
            "opener": preflight["opener_binary"],
            "output": out,
        }
        print(json.dumps(result, indent=2))
    else:
        if success:
            print(f"Opened with {preflight['opener_binary']}: {target}")
        else:
            print(f"Failed to open {target} (code {code}): {out}", file=sys.stderr)

    sys.exit(code)


if __name__ == "__main__":
    main()
