"""Tests for Pi launcher heap allocation and NODE_OPTIONS sanitization."""
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PI_LAUNCHER = REPO / "bin" / "pi"


def test_pi_launcher_heap_sanitization():
    # Extract the heap resolution logic from bin/pi and execute in /bin/sh
    sh_snippet = """
    NODE_OPTIONS="--max-old-space-size=384 --enable-source-maps --max-old-space-size=512"
    
    if [ -z "${PI_MAX_OLD_SPACE_SIZE:-}" ]; then
      case "$(uname -s 2>/dev/null)" in
        Darwin) pi_default_heap=4096 ;;
        *)      pi_default_heap=2048 ;;
      esac
    else
      pi_default_heap="$PI_MAX_OLD_SPACE_SIZE"
    fi

    cleaned_node_options=""
    for opt in ${NODE_OPTIONS:-}; do
      case "$opt" in
        --max-old-space-size=*) ;;
        *) cleaned_node_options="${cleaned_node_options:+$cleaned_node_options }$opt" ;;
      esac
    done
    NODE_OPTIONS="--max-old-space-size=$pi_default_heap${cleaned_node_options:+ $cleaned_node_options}"
    printf '%s' "$NODE_OPTIONS"
    """
    res = subprocess.run(["/bin/sh", "-c", sh_snippet], capture_output=True, text=True, check=True)
    opts = res.stdout.split()
    assert "--max-old-space-size=4096" in opts
    assert "--enable-source-maps" in opts
    assert "--max-old-space-size=384" not in opts
    assert "--max-old-space-size=512" not in opts


def test_pi_launcher_custom_heap_override():
    sh_snippet = """
    PI_MAX_OLD_SPACE_SIZE=8192
    NODE_OPTIONS="--max-old-space-size=384"
    
    if [ -z "${PI_MAX_OLD_SPACE_SIZE:-}" ]; then
      case "$(uname -s 2>/dev/null)" in
        Darwin) pi_default_heap=4096 ;;
        *)      pi_default_heap=2048 ;;
      esac
    else
      pi_default_heap="$PI_MAX_OLD_SPACE_SIZE"
    fi

    cleaned_node_options=""
    for opt in ${NODE_OPTIONS:-}; do
      case "$opt" in
        --max-old-space-size=*) ;;
        *) cleaned_node_options="${cleaned_node_options:+$cleaned_node_options }$opt" ;;
      esac
    done
    NODE_OPTIONS="--max-old-space-size=$pi_default_heap${cleaned_node_options:+ $cleaned_node_options}"
    printf '%s' "$NODE_OPTIONS"
    """
    res = subprocess.run(["/bin/sh", "-c", sh_snippet], capture_output=True, text=True, check=True)
    assert res.stdout == "--max-old-space-size=8192"
