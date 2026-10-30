---
description: fresh reviewers review, then verify adoption
---

Spawn fresh, context-free reviewer subagents in the background (no wait; count scaled to change size; one is enough for small changes) to review the current change without sharing your own conclusions. When each completes, merge findings (duplicated hits ranked higher, single-agent lower confidence), verify each against the actual code with a one-line adopt/reject; in addition to your own criteria, also weigh:
- Only recommend changes whose expected benefit clearly exceeds their complexity and maintenance cost.
- Prefer deleting or simplifying code over introducing abstractions.
- If the code is already good enough for the stated requirements, say so explicitly.
Then STOP and present all findings with their verdicts for my decision. For each finding, quote the reviewer's report verbatim (merging duplicates by grouping the original texts, never by rewriting them), then append its one-line adopt/reject as above.
