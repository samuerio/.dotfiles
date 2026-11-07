---
name: review
description: Review changed code and report prioritized findings with a verdict, without fixing anything.
---

# Review: Findings Only

`resolve target → 1 review agent → findings only`

You are reporting on the changed code, not fixing it. Flag what the author would
fix if they knew about it, and leave the working tree exactly as you found it.

## Phase 0 — Gather the diff

Run `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1`
if there's no upstream) to get the unified diff. If there are uncommitted
changes, or the range diff is empty, also run `git diff HEAD` and include the
working-tree changes in scope.

Untracked files appear in no diff. List them with
`git ls-files --others --exclude-standard` and bring their contents into scope,
either by reading them or with `git diff --no-index /dev/null <file>`.

If a branch name, commit, or file path was passed as the argument, review that
target instead:

- an existing path: snapshot review of those files, no diff, judge the code as it stands
- a commit-ish: `git show --stat <x>`, then `git show <x>`
- anything else: treat it as a base branch

`git diff <base>` is wrong for a branch: it includes commits the base added and
you never had. Resolve `git rev-parse --abbrev-ref '<base>@{upstream}'`, then
`git merge-base HEAD <upstream>` (falling back to `git merge-base HEAD '<base>'`
when that lookup fails), then `git diff <mergeBase>`. Say so when the base has
no upstream and may be stale. If the target cannot be resolved, ask the user
instead of guessing.

State the exact commands whose output defines the scope.

## Phase 1 — Review

Launch **one review agent** via the task tool. Pass it, in the prompt:

- the target and the exact commands whose output defines the scope
- the diff
- the rubric below, verbatim
- the boundary: do not modify the working tree, no file edits, no shell
  redirection into files, no `git checkout`, `git switch`, `git restore` or
  `git stash`
- the instruction to put the whole report in its final message, because only
  that message is handed back
- the instruction to read `REVIEW_GUIDELINES.md` from the repository root
  (`git rev-parse --show-toplevel`) when it exists, and to let it override the
  rubric where they conflict

## Phase 2 — Report

Wait for the agent, dedup findings that point at the same line or the same
mechanism, and present the report as it came back. Do not add a summary, do not
reword it, do not fix anything.

Then give your own take, one line per finding, introduced by the literal label
`My take:` so your words are never mistaken for the reviewer's. Read the code
each finding points at, and the code around it, before you write the line: a
diff excerpt is not enough to accept or reject a claim.

```
My take:
- [P1] src/x.ts:42 - adopt: returning null hides the failure, rethrow is right
- [P2] src/y.ts:10 - adopt: the caller two frames up already rethrows
- [P3] src/z.ts:88 - reject: false positive, that helper lives in src/util/fs.ts:12
```

`adopt` means the finding is real and worth acting on, so say why it holds in
one clause. `reject` means it is not worth acting on, so say why: a false
positive, a change that would alter intended behavior, or work well outside the
diff. Do not restate the finding, do not say how to fix it, and do not turn the
line into a plan; the user still decides what gets fixed.

## The rubric

Apply this as written.

### Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word. If you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

#### Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code. It is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.
10. Treat silent local error recovery (especially parsing/IO/network fallbacks) as high-signal review candidates unless there is explicit boundary-level justification.

#### Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

#### Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use ```suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

#### Review priorities

1. Surface critical non-blocking human callouts (migrations, dependency churn, auth/permissions, compatibility, destructive operations) at the end.
2. Prefer simple, direct solutions over wrappers or abstractions without clear value.
3. Treat back pressure handling as critical to system stability.
4. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.
5. Ensure that errors are always checked against codes or stable identifiers, never error messages.

#### Fail-fast error handling (strict)

When reviewing added or modified error handling, default to fail-fast behavior.

1. Evaluate every new or changed `try/catch`: identify what can fail and why local handling is correct at that exact layer.
2. Prefer propagation over local recovery. If the current scope cannot fully recover while preserving correctness, rethrow (optionally with context) instead of returning fallbacks.
3. Flag catch blocks that hide failure signals (e.g. returning `null`/`[]`/`false`, swallowing JSON parse failures, logging-and-continue, or "best effort" silent recovery).
4. JSON parsing/decoding should fail loudly by default. Quiet fallback parsing is only acceptable with an explicit compatibility requirement and clear tested behavior.
5. Boundary handlers (HTTP routes, CLI entrypoints, supervisors) may translate errors, but must not pretend success or silently degrade.
6. If a catch exists only to satisfy lint/style without real handling, treat it as a bug.
7. When uncertain, prefer crashing fast over silent degradation.

#### Required human callouts (non-blocking, at the very end)

After findings/verdict, you MUST append this final section:

#### Human Reviewer Callouts (Non-Blocking)

Include only applicable callouts (no yes/no lines):

- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>

Rules for this section:
1. These are informational callouts for the human reviewer, not fix items.
2. Do not include them in Findings unless there is an independent defect.
3. These callouts alone must not change the verdict.
4. Only include callouts that apply to the reviewed change.
5. Keep each emitted callout bold exactly as written.
6. If none apply, write "- (none)".

#### Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.

#### Output format

Provide your findings in a clear, structured format:
1. Start with the verdict on its own first line: "Verdict: correct" (no blocking issues) or "Verdict: needs attention" (has blocking issues).
2. List each finding with its priority tag, file location, and explanation.
3. Findings must reference locations that overlap with the actual diff. Do not flag pre-existing code.
4. Keep line references as short as possible (avoid ranges over 5-10 lines; pick the most suitable subrange).
5. Ignore trivial style issues unless they obscure meaning or violate documented standards.
6. Do not generate a full PR fix. Only flag issues and optionally provide short suggestion blocks.
7. End with the required "Human Reviewer Callouts (Non-Blocking)" section and all applicable bold callouts (no yes/no).
8. Answer in the language of the user's message. Keep the priority tags and the verdict values in English.

Output all findings the author would fix if they knew about them. If there are no qualifying findings, explicitly state the code looks good. Don't stop at the first finding - list every qualifying issue. Then append the required non-blocking callouts section.
