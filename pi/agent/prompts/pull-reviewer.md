---
description: fresh reviewers review, then verify adoption
---

Spawn fresh, context-free reviewer subagents in the background (no wait; count scaled to change size; one is enough for small changes) to review the current change without sharing your own conclusions. When each completes, merge findings (duplicated hits ranked higher, single-agent lower confidence), verify each against the actual code with a one-line adopt/reject, then STOP and present all findings with their verdicts for my decision.
