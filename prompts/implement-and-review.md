---
description: Implement a change, then get independent review and apply the feedback
---
Implement, then independently review: $@

1. **Implement** proportionally: tiny/localized work directly in the parent; larger or parallelizable work via `worker` subagents (`isolation:'worktree'` for parallel writers).
2. **Verify** with targeted tests or runtime evidence before review.
3. **Review** with an independent `reviewer` subagent that did not write the change; give it the goal, diff, and verification evidence. For tiny low-risk changes a focused self-review of the diff is sufficient; say so explicitly.
4. **Apply** blocking findings, re-verify, and report what was fixed, what was deferred, and the final evidence.
