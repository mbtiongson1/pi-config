---
description: Open a file or the latest downloaded media in the native viewer or player
argument-hint: "[file-or-path] [--chooser] [--preflight]"
---
Load the `open` skill and follow its instructions.

Run:

```bash
python3 "$(dirname "$(find ~/.pi/agent/skills ~/.agents/skills ~/pi-config/skills -type f -name 'open.py' 2>/dev/null | head -1)")/open.py" $ARGUMENTS
```

Then:
- Report the resolved file path and size.
- Report which platform opener was dispatched (`termux-open`, `open`, `xdg-open`, or `wslview`).
- If an error occurred or no opener was available, explain the preflight failure and remedy.
