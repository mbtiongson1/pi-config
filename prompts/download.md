---
description: Download episodic media or files with device preflight and precise verification
argument-hint: "\"<title-or-url>\" [--episode 1-3] [--resolution 1080p|720p] [--dry-run] [--preflight]"
---
Load the `download` skill and follow its instructions.

Run:

```bash
python3 "$(dirname "$(find ~/.pi/agent/skills ~/.agents/skills ~/pi-config/skills -type f -name 'download.py' 2>/dev/null | head -1)")/download.py" $ARGUMENTS
```

Then:
- If preflight was requested, display disk space, available engines, and device readiness.
- If a download was performed, summarize acquired items, file sizes, verified piece hashes, and final download locations.
- If background processing is suitable for large batches, inform the operator and monitor via receipts.
