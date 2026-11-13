---
description: Add to or manage torrent download queue (/queue <title> [ep] [res], /queue start, /queue list, /queue clear)
argument-hint: "<title-or-url> [ep] [res] | start | list | clear | remove <id>"
---
Load the `download` skill and manage the torrent download queue using `queue.py`.

Run:

```bash
python3 "$(dirname "$(find ~/.pi/agent/skills ~/.agents/skills ~/pi-config/skills -type f -name 'queue.py' 2>/dev/null | head -1)")/queue.py" $ARGUMENTS
```

Then:
- If items were queued, report the queued title, episode, resolution, item ID, and total pending count.
- If `start` was executed, sequentially download each queued item using Kura/aria2c with wake-lock, piece verification, and Android/device storage organization. Report the downloaded files, sizes, verified piece hashes, and final paths.
- If `list` was executed, format and summarize all pending, completed, and failed torrents in the queue.
- If `clear` or `remove` was executed, confirm the removed items and remaining queue count.
