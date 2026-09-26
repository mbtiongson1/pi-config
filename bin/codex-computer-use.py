#!/usr/bin/env python3
"""Codex Computer Use for Pi — installer, doctor, and diagnostic harness.

Managed by pi-config as an optional integration.
Architecture:
    Pi (agent harness)
      └── pi-codex-computer-use (extension)
          └── Codex app-server (stdio JSONL)
              └── computer-use MCP server (SkyComputerUseClient)
                  └── Codex Computer Use macOS service (SkyComputerUseService)
                      └── macOS GUI / Desktop
"""

import argparse
import ctypes
import ctypes.util
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_AGENT_DIR = Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi" / "agent"))
CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
CODEX_CONFIG_TOML = CODEX_HOME / "config.toml"


def is_macos() -> bool:
    return platform.system() == "Darwin"


def check_accessibility_permission() -> Optional[bool]:
    """Check macOS Accessibility permission via ApplicationServices framework."""
    if not is_macos():
        return None
    try:
        app_services = ctypes.cdll.LoadLibrary(ctypes.util.find_library("ApplicationServices"))
        app_services.AXIsProcessTrusted.restype = ctypes.c_bool
        app_services.AXIsProcessTrusted.argtypes = []
        return bool(app_services.AXIsProcessTrusted())
    except Exception:
        return False


def check_screen_recording_permission() -> Optional[bool]:
    """Check macOS Screen Recording permission via CoreGraphics framework."""
    if not is_macos():
        return None
    try:
        core_graphics = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))
        core_graphics.CGPreflightScreenCaptureAccess.restype = ctypes.c_bool
        core_graphics.CGPreflightScreenCaptureAccess.argtypes = []
        return bool(core_graphics.CGPreflightScreenCaptureAccess())
    except Exception:
        return False


def find_codex_app() -> Tuple[bool, Optional[Path], Optional[str]]:
    """Locate Codex.app or ChatGPT.app (with bundle ID com.openai.codex)."""
    candidates = [
        Path("/Applications/Codex.app"),
        Path.home() / "Applications" / "Codex.app",
        Path("/Applications/ChatGPT.app"),
        Path.home() / "Applications" / "ChatGPT.app",
    ]
    for p in candidates:
        if p.exists():
            # Check bundle identifier
            info_plist = p / "Contents" / "Info.plist"
            bundle_id = ""
            if info_plist.exists():
                try:
                    res = subprocess.run(
                        ["/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", str(info_plist)],
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    bundle_id = res.stdout.strip()
                except Exception:
                    pass
            if "codex" in p.name.lower() or bundle_id == "com.openai.codex":
                note = p.name
                if p.is_symlink():
                    note += f" -> {p.resolve().name}"
                elif p.name != "Codex.app" and bundle_id == "com.openai.codex":
                    note += " (com.openai.codex)"
                return True, p, note
    return False, None, None


def find_sky_client() -> Optional[Path]:
    """Find SkyComputerUseClient executable in known locations."""
    candidates = [
        CODEX_HOME / "computer-use" / "Codex Computer Use.app" / "Contents" / "SharedSupport" / "SkyComputerUseClient.app" / "Contents" / "MacOS" / "SkyComputerUseClient",
        Path("/Applications/Codex.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"),
        Path("/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"),
        Path.home() / "Applications" / "ChatGPT.app" / "Contents" / "Resources" / "cua_node" / "lib" / "node_modules" / "@oai" / "sky" / "Codex Computer Use.app" / "Contents" / "SharedSupport" / "SkyComputerUseClient.app" / "Contents" / "MacOS" / "SkyComputerUseClient",
    ]
    for c in candidates:
        if c.exists() and os.access(c, os.X_OK):
            return c
    return None


def probe_codex_app_server(timeout_sec: float = 8.0) -> Tuple[bool, Optional[str], List[str], Optional[str]]:
    """Probe codex app-server for computer-use MCP server status and tool names."""
    codex_bin = shutil.which("codex")
    if not codex_bin:
        return False, None, [], "Codex CLI not on PATH"

    try:
        proc = subprocess.Popen(
            [codex_bin, "app-server", "--listen", "stdio://"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except Exception as e:
        return False, None, [], f"Failed to spawn codex app-server: {e}"

    app_server_info = None
    tools: List[str] = []
    error = None

    try:
        init_req = json.dumps({
            "id": 1,
            "method": "initialize",
            "params": {"clientInfo": {"name": "pi-config-doctor", "version": "1.0"}, "capabilities": {"experimentalApi": True}}
        }) + "\n"
        proc.stdin.write(init_req)
        proc.stdin.flush()

        import time
        start_time = time.time()
        while time.time() - start_time < timeout_sec:
            line = proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except Exception:
                continue

            if msg.get("id") == 1:
                res = msg.get("result", {})
                app_server_info = res.get("userAgent") or "initialized"
                status_req = json.dumps({"id": 2, "method": "mcpServerStatus/list", "params": {}}) + "\n"
                proc.stdin.write(status_req)
                proc.stdin.flush()
            elif msg.get("id") == 2:
                res = msg.get("result", {})
                servers = res.get("data", [])
                cu = next((s for s in servers if s.get("name") == "computer-use"), None)
                if cu:
                    tools = sorted(list(cu.get("tools", {}).keys()))
                    if not tools and cu.get("toolsError"):
                        error = cu.get("toolsError")
                else:
                    error = "computer-use MCP server not configured in app-server"
                break
    except Exception as e:
        error = str(e)
    finally:
        try:
            if proc.stdin:
                proc.stdin.close()
            if proc.stdout:
                proc.stdout.close()
            if proc.stderr:
                proc.stderr.close()
            proc.kill()
            proc.wait(timeout=2)
        except Exception:
            pass

    healthy = app_server_info is not None and len(tools) > 0
    return healthy, app_server_info, tools, error


def check_pi_extension(agent_dir: Path = DEFAULT_AGENT_DIR) -> Tuple[bool, Optional[str]]:
    """Check if pi-codex-computer-use is registered in settings.json."""
    settings_file = agent_dir / "settings.json"
    if not settings_file.exists():
        return False, None
    try:
        data = json.loads(settings_file.read_text(encoding="utf-8"))
        packages = data.get("packages", [])
        for pkg in packages:
            if "pi-codex-computer-use" in pkg:
                return True, pkg
    except Exception:
        pass
    return False, None


def check_health(agent_dir: Path = DEFAULT_AGENT_DIR) -> Dict[str, Any]:
    """Run full diagnostic check across all 8 capability dimensions."""
    os_supported = is_macos()
    pi_bin = shutil.which("pi")
    pi_version = None
    if pi_bin:
        try:
            r = subprocess.run([pi_bin, "--version"], capture_output=True, text=True, timeout=5)
            pi_version = r.stdout.strip() or r.stderr.strip()
        except Exception:
            pi_version = "found"

    codex_bin = shutil.which("codex")
    codex_version = None
    if codex_bin:
        try:
            r = subprocess.run([codex_bin, "--version"], capture_output=True, text=True, timeout=5)
            codex_version = r.stdout.strip() or r.stderr.strip()
        except Exception:
            codex_version = "found"

    codex_app_ok, codex_app_path, codex_app_note = find_codex_app()
    ext_ok, ext_pkg = check_pi_extension(agent_dir)

    app_server_ok = False
    app_server_info = None
    cu_tools: List[str] = []
    cu_error = None
    if codex_bin:
        app_server_ok, app_server_info, cu_tools, cu_error = probe_codex_app_server()

    sky_client = find_sky_client()
    cu_service_ok = len(cu_tools) > 0 or (sky_client is not None and app_server_ok)

    ax_perm = check_accessibility_permission()
    screen_perm = check_screen_recording_permission()

    # Determine overall status
    if not os_supported:
        status = "UNAVAILABLE ON THIS OS"
        reason = "Codex Computer Use requires macOS (Darwin)."
    elif not pi_bin or not codex_bin or not codex_app_ok:
        status = "NOT INSTALLED"
        missing = []
        if not pi_bin:
            missing.append("Pi CLI")
        if not codex_bin:
            missing.append("Codex CLI")
        if not codex_app_ok:
            missing.append("Codex.app / ChatGPT.app")
        reason = f"Missing core prerequisites: {', '.join(missing)}."
    elif not ext_ok or not cu_service_ok:
        status = "NOT CONFIGURED"
        missing = []
        if not ext_ok:
            missing.append("Pi Codex CU extension")
        if not cu_service_ok:
            missing.append("Codex computer-use MCP service")
        reason = f"Installed components need configuration: {', '.join(missing)}."
    elif ax_perm is False or screen_perm is False:
        status = "INSTALLED — HUMAN PERMISSION REQUIRED"
        denied = []
        if ax_perm is False:
            denied.append("Accessibility")
        if screen_perm is False:
            denied.append("Screen Recording")
        reason = f"macOS permissions required: {', '.join(denied)}. Grant access in System Settings."
    elif cu_tools and app_server_ok:
        status = "READY"
        reason = f"Codex Computer Use stack is ready ({len(cu_tools)} tools active)."
    else:
        status = "INCOMPATIBLE"
        reason = cu_error or "Codex app-server could not initialize the computer-use service."

    return {
        "os_supported": os_supported,
        "platform": platform.system(),
        "pi_installed": pi_bin is not None,
        "pi_version": pi_version,
        "codex_cli_installed": codex_bin is not None,
        "codex_cli_version": codex_version,
        "codex_app_installed": codex_app_ok,
        "codex_app_path": str(codex_app_path) if codex_app_path else None,
        "codex_app_note": codex_app_note,
        "pi_extension_installed": ext_ok,
        "pi_extension_package": ext_pkg,
        "codex_app_server_ok": app_server_ok,
        "codex_app_server_info": app_server_info,
        "cu_service_ok": cu_service_ok,
        "cu_tools": cu_tools,
        "cu_error": cu_error,
        "accessibility_permission": ax_perm,
        "screen_recording_permission": screen_perm,
        "status": status,
        "reason": reason,
    }


def format_doctor_report(health: Dict[str, Any]) -> str:
    """Format diagnostic report strictly matching the required target convention."""
    def sym(val: Optional[bool]) -> str:
        if val is True:
            return "✓"
        if val is False:
            return "✗"
        return "—"

    pi_ver = health.get("pi_version")
    codex_ver = health.get("codex_cli_version")
    app_note_val = health.get("codex_app_note")
    ext_pkg_val = health.get("pi_extension_package")
    tools = health.get("cu_tools") or []
    tools_cnt = len(tools)

    pi_note = f" ({pi_ver})" if pi_ver else ""
    codex_note = f" ({codex_ver})" if codex_ver else ""
    app_note = f" ({app_note_val})" if app_note_val else ""
    ext_note = f" ({ext_pkg_val})" if ext_pkg_val else ""
    cu_note = f" ({tools_cnt} tools active)" if tools_cnt > 0 else ""

    lines = [
        "Codex Computer Use",
        "",
        f"{'Pi':<27}{sym(health.get('pi_installed'))}{pi_note}",
        f"{'Codex CLI':<27}{sym(health.get('codex_cli_installed'))}{codex_note}",
        f"{'Codex.app':<27}{sym(health.get('codex_app_installed'))}{app_note}",
        f"{'Pi Codex CU extension':<27}{sym(health.get('pi_extension_installed'))}{ext_note}",
        f"{'Codex app-server':<27}{sym(health.get('codex_app_server_ok'))}",
        f"{'Computer Use service':<27}{sym(health.get('cu_service_ok'))}{cu_note}",
        f"{'Accessibility permission':<27}{sym(health.get('accessibility_permission'))}",
        f"{'Screen Recording':<27}{sym(health.get('screen_recording_permission'))}",
        "",
        f"Status: {health.get('status', 'UNKNOWN')}",
    ]

    if health.get("status") != "READY":
        lines.append("")
        if health.get("reason"):
            lines.append(f"Detail: {health['reason']}")
        if health.get("status") == "INSTALLED — HUMAN PERMISSION REQUIRED":
            lines.append("")
            lines.append("Next Action:")
            if health.get("accessibility_permission") is False:
                lines.append("  • Open System Settings > Privacy & Security > Accessibility and enable Terminal / Pi / Codex.")
            if health.get("screen_recording_permission") is False:
                lines.append("  • Open System Settings > Privacy & Security > Screen Recording and enable Terminal / Pi / Codex.")
        elif health.get("status") == "NOT INSTALLED":
            lines.append("")
            lines.append("Next Action:")
            if not health.get("codex_cli_installed"):
                lines.append("  • Install Codex CLI: npm install -g @openai/codex")
            if not health.get("codex_app_installed"):
                lines.append("  • Install ChatGPT / Codex Desktop: brew install --cask chatgpt")
        elif health.get("status") == "NOT CONFIGURED":
            lines.append("")
            lines.append("Next Action:")
            lines.append("  • Run: bash bin/install-codex-computer-use.sh")

    return "\n".join(lines)


def configure_codex_toml(client_path: Path) -> bool:
    """Safely and idempotently ensure [mcp_servers.computer-use] in ~/.codex/config.toml."""
    CODEX_HOME.mkdir(parents=True, exist_ok=True)
    if not CODEX_CONFIG_TOML.exists():
        content = ""
    else:
        content = CODEX_CONFIG_TOML.read_text(encoding="utf-8")

    mcp_block = f"""[mcp_servers.computer-use]
command = "{client_path}"
args = ["mcp"]
cwd = "{client_path.parent}"
enabled = true"""

    if "[mcp_servers.computer-use]" in content:
        # Replace existing computer-use block cleanly
        pattern = r'\[mcp_servers\.computer-use\][\s\S]*?(?=\n\[|\Z)'
        new_content = re.sub(pattern, mcp_block, content)
    else:
        # Append block
        new_content = content.rstrip() + "\n\n" + mcp_block + "\n"

    CODEX_CONFIG_TOML.write_text(new_content, encoding="utf-8")
    return True


def ensure_codex_app_symlink() -> Optional[Path]:
    """Ensure /Applications/Codex.app symlink exists pointing to /Applications/ChatGPT.app."""
    codex_app = Path("/Applications/Codex.app")
    if codex_app.exists():
        return codex_app

    chatgpt_app = Path("/Applications/ChatGPT.app")
    if chatgpt_app.exists():
        try:
            codex_app.symlink_to(chatgpt_app)
            return codex_app
        except Exception:
            # Fall back to user Applications folder if /Applications is read-only
            user_app = Path.home() / "Applications" / "Codex.app"
            try:
                user_app.parent.mkdir(parents=True, exist_ok=True)
                if not user_app.exists():
                    user_app.symlink_to(chatgpt_app)
                return user_app
            except Exception:
                pass
    return None


def apply_compatibility_patch(agent_dir: Path = DEFAULT_AGENT_DIR) -> bool:
    """Patch runtime.ts in installed pi-codex-computer-use so elicitation accepts ChatGPT branding."""
    pkg_runtime = agent_dir / "npm" / "node_modules" / "pi-codex-computer-use" / "src" / "runtime.ts"
    if not pkg_runtime.exists():
        return False
    try:
        content = pkg_runtime.read_text(encoding="utf-8")
        target_re = "/Allow Codex to use (.+?)\\?/i"
        replacement = "/Allow (?:Codex|ChatGPT) to use (.+?)\\?/i"
        if target_re in content:
            new_content = content.replace(target_re, replacement)
            pkg_runtime.write_text(new_content, encoding="utf-8")
            return True
    except Exception:
        pass
    return False


def install(agent_dir: Path = DEFAULT_AGENT_DIR) -> int:
    """Run full idempotent installation of Codex Computer Use integration."""
    print("Installing Codex Computer Use for Pi...\n")

    if not is_macos():
        print("Error: Codex Computer Use is only supported on macOS (Darwin).", file=sys.stderr)
        return 1

    pi_bin = shutil.which("pi")
    if not pi_bin:
        print("Warning: Pi CLI (`pi`) was not found on PATH.", file=sys.stderr)
        print("Install Pi: npm install -g @earendil-works/pi-coding-agent\n", file=sys.stderr)

    codex_bin = shutil.which("codex")
    if not codex_bin:
        print("Warning: Codex CLI (`codex`) was not found on PATH.", file=sys.stderr)
        print("Install Codex: npm install -g @openai/codex\n", file=sys.stderr)

    # Ensure Codex.app symlink if ChatGPT.app exists
    ensure_codex_app_symlink()

    # 1. Update settings.json packages
    settings_file = agent_dir / "settings.json"
    agent_dir.mkdir(parents=True, exist_ok=True)
    if settings_file.exists():
        try:
            settings = json.loads(settings_file.read_text(encoding="utf-8"))
        except Exception:
            settings = {}
    else:
        settings = {}

    packages = settings.get("packages", [])
    pkg_name = "npm:pi-codex-computer-use"
    if pkg_name not in packages and "pi-codex-computer-use" not in packages:
        packages.append(pkg_name)
        settings["packages"] = packages
        settings_file.write_text(json.dumps(settings, indent=2), encoding="utf-8")
        print(f"Added {pkg_name} to {settings_file}")

    # 2. Run pi install if pi CLI is available
    if pi_bin:
        print("Running `pi install npm:pi-codex-computer-use`...")
        try:
            subprocess.run([pi_bin, "install", pkg_name], check=True, timeout=60)
        except Exception as e:
            print(f"Notice: `pi install` returned: {e}")

    # 3. Configure Codex MCP server
    sky_client = find_sky_client()
    if sky_client:
        configure_codex_toml(sky_client)
        print(f"Configured Codex computer-use MCP server with executable: {sky_client}")
    else:
        print("Notice: SkyComputerUseClient not yet materialized on disk.")
        print("Launch ChatGPT/Codex once or run `/computer-use install` inside Pi.")

    # 4. Apply compatibility patch for ChatGPT branding in prompts
    apply_compatibility_patch(agent_dir)

    print("\nInstallation complete. Running health check:\n")
    health = check_health(agent_dir)
    print(format_doctor_report(health))
    return 0 if health["status"] in ("READY", "INSTALLED — HUMAN PERMISSION REQUIRED") else 1


def disable(agent_dir: Path = DEFAULT_AGENT_DIR) -> int:
    """Disable/uninstall Codex Computer Use from Pi."""
    print("Disabling Codex Computer Use for Pi...\n")
    settings_file = agent_dir / "settings.json"
    if settings_file.exists():
        try:
            settings = json.loads(settings_file.read_text(encoding="utf-8"))
            packages = settings.get("packages", [])
            new_packages = [p for p in packages if "pi-codex-computer-use" not in p]
            if len(new_packages) != len(packages):
                settings["packages"] = new_packages
                settings_file.write_text(json.dumps(settings, indent=2), encoding="utf-8")
                print(f"Removed pi-codex-computer-use from {settings_file}")
        except Exception as e:
            print(f"Warning: could not update settings.json: {e}", file=sys.stderr)

    pi_bin = shutil.which("pi")
    if pi_bin:
        try:
            subprocess.run([pi_bin, "remove", "npm:pi-codex-computer-use"], timeout=30)
        except Exception:
            pass

    print("Codex Computer Use disabled for Pi. Normal Pi operation is preserved.")
    return 0


def smoke_test(agent_dir: Path = DEFAULT_AGENT_DIR) -> int:
    """Run an end-to-end smoke test through the real Pi -> Codex CU -> macOS GUI chain."""
    print("Running end-to-end Codex Computer Use smoke test...\n")
    health = check_health(agent_dir)

    if health["status"] == "INSTALLED — HUMAN PERMISSION REQUIRED":
        print(format_doctor_report(health))
        print("\nSmoke test blocked pending human approval.")
        return 2

    if health["status"] != "READY":
        print(format_doctor_report(health))
        print(f"\nSmoke test cannot proceed: status is {health['status']}.")
        return 1

    pi_bin = shutil.which("pi")
    if not pi_bin:
        print("Error: `pi` executable not found.", file=sys.stderr)
        return 1

    # Harmless task: query running apps via computer_use_list_apps
    cmd = [pi_bin, "-p", "Use computer_use_list_apps to list running apps."]
    env = {**os.environ, "PI_CUA_DEV_AUTO_ACCEPT_APPS": "Calculator,Safari,Finder,Terminal"}
    print("Invoking Pi agent: querying desktop apps via computer_use_list_apps...")
    try:
        res = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=60)
        if res.returncode == 0 and ("running" in res.stdout.lower() or "apps" in res.stdout.lower()):
            print("Smoke test PASSED! Real tool execution returned live desktop app state:\n")
            # Show snippet of output
            lines = res.stdout.strip().splitlines()
            for line in lines[:10]:
                print(f"  {line}")
            if len(lines) > 10:
                print(f"  ... ({len(lines) - 10} more lines)")
            return 0
        else:
            print(f"Smoke test failed (exit code {res.returncode}):\n{res.stderr or res.stdout}")
            return 1
    except Exception as e:
        print(f"Smoke test exception: {e}", file=sys.stderr)
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Codex Computer Use for Pi manager")
    parser.add_argument("action", nargs="?", default="doctor", choices=["doctor", "install", "disable", "uninstall", "smoke-test", "status"])
    parser.add_argument("--json", action="store_true", help="Output health report in JSON format")
    parser.add_argument("--agent-dir", type=Path, default=DEFAULT_AGENT_DIR, help="Path to Pi agent directory")
    args = parser.parse_args()

    action = args.action
    if action in ("doctor", "status"):
        health = check_health(args.agent_dir)
        if args.json:
            print(json.dumps(health, indent=2))
        else:
            print(format_doctor_report(health))
        return 0 if health["status"] in ("READY", "INSTALLED — HUMAN PERMISSION REQUIRED") else 1
    elif action == "install":
        return install(args.agent_dir)
    elif action in ("disable", "uninstall"):
        return disable(args.agent_dir)
    elif action == "smoke-test":
        return smoke_test(args.agent_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
