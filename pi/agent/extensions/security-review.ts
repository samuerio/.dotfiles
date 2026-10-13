/**
 * Security Review Extension
 *
 * Provides a `/security-review` command that dispatches a security-focused
 * review prompt (rubric adapted from Claude Code's security-review command).
 * Identifies high-confidence vulnerabilities in code changes, filters false
 * positives via parallel subagents, and reports Vuln-style findings.
 *
 * Supported targets (shared target layer in lib/review-target.ts):
 * - Review a GitHub pull request (checks out the PR locally)
 * - Review against a base branch
 * - Review uncommitted changes
 * - Review a specific commit
 * - Review a folder (snapshot audit, not a diff)
 *
 * Modes (no Empty branch / loop fixing: security review produces a report,
 * not a fix loop; isolation is covered by the background dispatch):
 * - Current session (appends the prompt to the live conversation)
 * - Background task (dispatches to an unattended child Pi in the main repo
 *   via the background-task extension; fire-and-forget, results observed
 *   via /background-tasks)
 *
 * Usage:
 * - `/security-review` - show interactive selector
 * - `/security-review pr 123` - review PR #123 (checks out locally)
 * - `/security-review uncommitted` - review uncommitted changes directly
 * - `/security-review branch main` - review against main branch
 * - `/security-review commit abc123` - review specific commit
 * - `/security-review folder src docs` - audit specific folders/files
 * - `/security-review --extra "focus on auth"` - add extra instruction
 * - selector includes Add/Remove custom security review instructions
 *   (in-memory only; not persisted across sessions, unlike /review)
 *
 * No project guidelines are merged (REVIEW_GUIDELINES.md is code-review
 * advice; generic review guidance fights the false-positive-minimization
 * objective). Project-specific security context goes through custom
 * instructions or --extra.
 *
 * Note: PR review requires a clean working tree (no uncommitted changes to
 * tracked files).
 */

import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    applyUncommittedWorktree,
    buildTargetFocusPrompt,
    dispatchPromptTask,
    getUserFacingHint,
    makeCustomInstructionsToggle,
    resolveReviewTarget,
    type ReviewTarget,
    showTargetSelector,
} from "./lib/review-target.ts";

// In-memory custom instructions (deliberately not session-persisted).
let securityCustomInstructions: string | undefined;

// Per-target focus prompts (the concrete scope for the rubric below).
const SECURITY_UNCOMMITTED_PROMPT =
    "Perform a security review of the current code changes (staged, unstaged, and untracked files). Use `git status --porcelain`, `git diff`, `git diff --staged`, and `git ls-files --others --exclude-standard` to inspect the changes. Identify high-confidence security vulnerabilities newly introduced by these changes.";

const SECURITY_BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
    "Perform a security review of the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes relative to {baseBranch}. Identify high-confidence security vulnerabilities newly introduced by these changes.";

const SECURITY_BASE_BRANCH_PROMPT_FALLBACK =
    "Perform a security review of the code changes against the base branch '{branch}'. Start by finding the merge base between the current branch and {branch} (e.g., `git merge-base HEAD {branch}`), then run `git diff` against that SHA to see the changes that would be merged. Identify high-confidence security vulnerabilities newly introduced by these changes.";

const SECURITY_COMMIT_PROMPT_WITH_TITLE =
    'Perform a security review of the code changes introduced by commit {sha} ("{title}"). Run `git show {sha}` to inspect the change. Identify high-confidence security vulnerabilities newly introduced by these changes.';

const SECURITY_COMMIT_PROMPT =
    "Perform a security review of the code changes introduced by commit {sha}. Run `git show {sha}` to inspect the change. Identify high-confidence security vulnerabilities newly introduced by these changes.";

const SECURITY_PR_PROMPT =
    "Perform a security review of pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes that would be merged. Identify high-confidence security vulnerabilities newly introduced by these changes.";

const SECURITY_PR_PROMPT_FALLBACK =
    "Perform a security review of pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. Start by finding the merge base between the current branch and {baseBranch} (e.g., `git merge-base HEAD {baseBranch}`), then run `git diff` against that SHA to see the changes that would be merged. Identify high-confidence security vulnerabilities newly introduced by these changes.";

const SECURITY_FOLDER_PROMPT =
    "Perform a security audit of the code in the following paths: {paths}. This is a snapshot audit (not a diff). Read the files directly in these paths and identify high-confidence security vulnerabilities present in these files.";

// The detailed security review rubric (adapted from Claude Code's
// security-review command; the false-positive filtering sections are kept
// verbatim on purpose — they are field-tuned).
const SECURITY_RUBRIC = `# Security Review Guidelines

You are a senior security engineer conducting a focused security review of the changes under review.

OBJECTIVE:
Perform a security-focused code review to identify HIGH-CONFIDENCE security vulnerabilities that could have real exploitation potential. This is not a general code review - focus ONLY on security implications newly introduced by the changes under review (for folder targets: present in the audited files). Do not comment on existing security concerns.

CRITICAL INSTRUCTIONS:
1. MINIMIZE FALSE POSITIVES: Only flag issues where you're >80% confident of actual exploitability
2. AVOID NOISE: Skip theoretical issues, style concerns, or low-impact findings
3. FOCUS ON IMPACT: Prioritize vulnerabilities that could lead to unauthorized access, data breaches, or system compromise
4. EXCLUSIONS: Do NOT report the following issue types:
   - Denial of Service (DOS) vulnerabilities, even if they allow service disruption
   - Secrets or sensitive data stored on disk (these are handled by other processes)
   - Rate limiting or resource exhaustion issues

SECURITY CATEGORIES TO EXAMINE:

**Input Validation Vulnerabilities:**
- SQL injection via unsanitized user input
- Command injection in system calls or subprocesses
- XXE injection in XML parsing
- Template injection in templating engines
- NoSQL injection in database queries
- Path traversal in file operations

**Authentication & Authorization Issues:**
- Authentication bypass logic
- Privilege escalation paths
- Session management flaws
- JWT token vulnerabilities
- Authorization logic bypasses

**Crypto & Secrets Management:**
- Hardcoded API keys, passwords, or tokens
- Weak cryptographic algorithms or implementations
- Improper key storage or management
- Cryptographic randomness issues
- Certificate validation bypasses

**Injection & Code Execution:**
- Remote code execution via deserialization
- Pickle injection in Python
- YAML deserialization vulnerabilities
- Eval injection in dynamic code execution
- XSS vulnerabilities in web applications (reflected, stored, DOM-based)

**Data Exposure:**
- Sensitive data logging or storage
- PII handling violations
- API endpoint data leakage
- Debug information exposure

Additional notes:
- Even if something is only exploitable from the local network, it can still be a HIGH severity issue

ANALYSIS METHODOLOGY:

Phase 1 - Repository Context Research (Use file search tools):
- Identify existing security frameworks and libraries in use
- Look for established secure coding patterns in the codebase
- Examine existing sanitization and validation patterns
- Understand the project's security model and threat model

Phase 2 - Comparative Analysis:
- Compare new code changes against existing security patterns
- Identify deviations from established secure practices
- Look for inconsistent security implementations
- Flag code that introduces new attack surfaces

Phase 3 - Vulnerability Assessment:
- Examine each modified file for security implications
- Trace data flow from user inputs to sensitive operations
- Look for privilege boundaries being crossed unsafely
- Identify injection points and unsafe deserialization

REQUIRED OUTPUT FORMAT:

You MUST output your findings in markdown. The markdown output should contain the file, line number, severity, category (e.g. \`sql_injection\` or \`xss\`), description, exploit scenario, and fix recommendation.

For example:

# Vuln 1: XSS: \`foo.py:42\`

* Severity: High
* Description: User input from \`username\` parameter is directly interpolated into HTML without escaping, allowing reflected XSS attacks
* Exploit Scenario: Attacker crafts URL like /bar?q=<script>alert(document.cookie)</script> to execute JavaScript in victim's browser, enabling session hijacking or data theft
* Recommendation: Use Flask's escape() function or Jinja2 templates with auto-escaping enabled for all user inputs rendered in HTML

Write the report body in Chinese. Keep file paths, severity levels, category tags, and confidence scores in English.

SEVERITY GUIDELINES:
- **HIGH**: Directly exploitable vulnerabilities leading to RCE, data breach, or authentication bypass
- **MEDIUM**: Vulnerabilities requiring specific conditions but with significant impact
- **LOW**: Defense-in-depth issues or lower-impact vulnerabilities

CONFIDENCE SCORING:
- 0.9-1.0: Certain exploit path identified, tested if possible
- 0.8-0.9: Clear vulnerability pattern with known exploitation methods
- 0.7-0.8: Suspicious pattern requiring specific conditions to exploit
- Below 0.7: Don't report (too speculative)

FINAL REMINDER:
Focus on HIGH and MEDIUM findings only. Better to miss some theoretical issues than flood the report with false positives. Each finding should be something a security engineer would confidently raise in a PR review.

FALSE POSITIVE FILTERING:

> You do not need to run commands to reproduce the vulnerability, just read the code to determine if it is a real vulnerability. Do not use the bash tool or write to any files.
>
> HARD EXCLUSIONS - Automatically exclude findings matching these patterns:
> 1. Denial of Service (DOS) vulnerabilities or resource exhaustion attacks.
> 2. Secrets or credentials stored on disk if they are otherwise secured.
> 3. Rate limiting concerns or service overload scenarios.
> 4. Memory consumption or CPU exhaustion issues.
> 5. Lack of input validation on non-security-critical fields without proven security impact.
> 6. Input sanitization concerns for GitHub Action workflows unless they are clearly triggerable via untrusted input.
> 7. A lack of hardening measures. Code is not expected to implement all security best practices, only flag concrete vulnerabilities.
> 8. Race conditions or timing attacks that are theoretical rather than practical issues. Only report a race condition if it is concretely problematic.
> 9. Vulnerabilities related to outdated third-party libraries. These are managed separately and should not be reported here.
> 10. Memory safety issues such as buffer overflows or use-after-free-vulnerabilities are impossible in rust. Do not report memory safety issues in rust or any other memory safe languages.
> 11. Files that are only unit tests or only used as part of running tests.
> 12. Log spoofing concerns. Outputting un-sanitized user input to logs is not a vulnerability.
> 13. SSRF vulnerabilities that only control the path. SSRF is only a concern if it can control the host or protocol.
> 14. Including user-controlled content in AI system prompts is not a vulnerability.
> 15. Regex injection. Injecting untrusted content into a regex is not a vulnerability.
> 16. Regex DOS concerns.
> 16. Insecure documentation. Do not report any findings in documentation files such as markdown files.
> 17. A lack of audit logs is not a vulnerability.
>
> PRECEDENTS -
> 1. Logging high value secrets in plaintext is a vulnerability. Logging URLs is assumed to be safe.
> 2. UUIDs can be assumed to be unguessable and do not need to be validated.
> 3. Environment variables and CLI flags are trusted values. Attackers are generally not able to modify them in a secure environment. Any attack that relies on controlling an environment variable is invalid.
> 4. Resource management issues such as memory or file descriptor leaks are not valid.
> 5. Subtle or low impact web vulnerabilities such as tabnabbing, XS-Leaks, prototype pollution, and open redirects should not be reported unless they are extremely high confidence.
> 6. React and Angular are generally secure against XSS. These frameworks do not need to sanitize or escape user input unless it is using dangerouslySetInnerHTML, bypassSecurityTrustHtml, or similar methods. Do not report XSS vulnerabilities in React or Angular components or tsx files unless they are using unsafe methods.
> 7. Most vulnerabilities in github action workflows are not exploitable in practice. Before validating a github action workflow vulnerability ensure it is concrete and has a very specific attack path.
> 8. A lack of permission checking or authentication in client-side JS/TS code is not a vulnerability. Client-side code is not trusted and does not need to implement these checks, they are handled on the server-side. The same applies to all flows that send untrusted data to the backend, the backend is responsible for validating and sanitizing all inputs.
> 9. Only include MEDIUM findings if they are obvious and concrete issues.
> 10. Most vulnerabilities in ipython notebooks (*.ipynb files) are not exploitable in practice. Before validating a notebook vulnerability ensure it is concrete and has a very specific attack path where untrusted input can trigger the vulnerability.
> 11. Logging non-PII data is not a vulnerability even if the data may be sensitive. Only report logging vulnerabilities if they expose sensitive information such as secrets, passwords, or personally identifiable information (PII).
> 12. Command injection vulnerabilities in shell scripts are generally not exploitable in practice since shell scripts generally do not run with untrusted user input. Only report command injection vulnerabilities in shell scripts if they are concrete and have a very specific attack path for untrusted input.
>
> SIGNAL QUALITY CRITERIA - For remaining findings, assess:
> 1. Is there a concrete, exploitable vulnerability with a clear attack path?
> 2. Does this represent a real security risk vs theoretical best practice?
> 3. Are there specific code locations and reproduction steps?
> 4. Would this finding be actionable for a security team?
>
> For each finding, assign a confidence score from 1-10:
> - 1-3: Low confidence, likely false positive or noise
> - 4-6: Medium confidence, needs investigation
> - 7-10: High confidence, likely true vulnerability

START ANALYSIS:

Begin your analysis now. Do this in 3 steps:

1. Use the task tool to spawn a subagent that identifies vulnerabilities. The subagent should use the repository exploration tools to understand the codebase context, then analyze the changes under review for security implications. In the prompt for this subagent, include all of the above.
2. Then for each vulnerability identified by the above subagent, spawn a new task subagent to filter out false-positives. Launch these subagents as parallel subagents. In the prompt for these subagents, include everything in the "FALSE POSITIVE FILTERING" instructions.
3. Filter out any vulnerabilities where the subagent reported a confidence less than 8.

Your final reply must contain the markdown report and nothing else.`;

/**
 * Assemble the full security review prompt (rubric + per-target focus +
 * custom instructions + extra instruction). No project guidelines.
 */
async function buildFullSecurityPrompt(
    pi: ExtensionAPI,
    target: ReviewTarget,
    options?: { extraInstruction?: string },
): Promise<string> {
    const prompt = await buildTargetFocusPrompt(pi, target, {
        uncommitted: SECURITY_UNCOMMITTED_PROMPT,
        baseBranchWithMergeBase: SECURITY_BASE_BRANCH_PROMPT_WITH_MERGE_BASE,
        baseBranchFallback: SECURITY_BASE_BRANCH_PROMPT_FALLBACK,
        commitWithTitle: SECURITY_COMMIT_PROMPT_WITH_TITLE,
        commit: SECURITY_COMMIT_PROMPT,
        pullRequestWithMergeBase: SECURITY_PR_PROMPT,
        pullRequestFallback: SECURITY_PR_PROMPT_FALLBACK,
        folder: SECURITY_FOLDER_PROMPT,
    });
    let fullPrompt = `${SECURITY_RUBRIC}\n\n---\n\nPlease perform a security review with the following focus:\n\n${prompt}`;

    if (securityCustomInstructions) {
        fullPrompt += `\n\nShared custom security review instructions (applies to all security reviews):\n\n${securityCustomInstructions}`;
    }

    if (options?.extraInstruction?.trim()) {
        fullPrompt += `\n\nAdditional user-provided security review instruction:\n\n${options.extraInstruction.trim()}`;
    }

    return fullPrompt;
}

export default function securityReviewExtension(pi: ExtensionAPI) {
    /**
     * Show the shared preset selector with the Custom Instructions toggle.
     */
    async function showSecurityTargetSelector(
        ctx: ExtensionContext,
    ): Promise<ReviewTarget | null> {
        return showTargetSelector(pi, ctx, {
            extraItems: () => [
                makeCustomInstructionsToggle(ctx, {
                    get: () => securityCustomInstructions,
                    set: (instructions) => {
                        securityCustomInstructions = instructions;
                    },
                    noun: "security review",
                    scope: "security reviews",
                }),
            ],
        });
    }

    /**
     * Run the review in the current session (appends the prompt to the
     * live conversation).
     */
    async function executeSecurityReview(
        ctx: ExtensionCommandContext,
        target: ReviewTarget,
        extraInstruction?: string,
    ): Promise<void> {
        const fullPrompt = await buildFullSecurityPrompt(pi, target, {
            extraInstruction,
        });
        ctx.ui.notify(
            `Starting security review: ${getUserFacingHint(target)}`,
            "info",
        );
        pi.sendUserMessage(fullPrompt);
    }

    /**
     * Dispatch the review as a background task (no worktree: the child runs
     * directly in the main repo). Fire-and-forget: results are observed via
     * /background-tasks ("Add result to prompt" yields the clean report).
     */
    async function executeBackgroundSecurityReview(
        ctx: ExtensionCommandContext,
        target: ReviewTarget,
        extraInstruction?: string,
    ): Promise<void> {
        const fullPrompt = await buildFullSecurityPrompt(pi, target, {
            extraInstruction,
        });
        await dispatchPromptTask(pi, ctx, {
            command: "security-review",
            description: `security review: ${getUserFacingHint(target)}`,
            prompt: fullPrompt,
            notifyLead: "Background security review",
            target,
        });
    }

    // Register the /security-review command
    pi.registerCommand("security-review", {
        description:
            "Security review of code changes (PR, uncommitted, branch, commit, or folder)",
        handler: async (args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify(
                    "Security review requires interactive mode",
                    "error",
                );
                return;
            }

            const resolved = await resolveReviewTarget(pi, ctx, args, {
                commandLabel: "security review",
                selectTarget: showSecurityTargetSelector,
            });
            if (resolved.status !== "ok") {
                if (resolved.status === "cancelled") {
                    ctx.ui.notify("Security review cancelled", "info");
                }
                return;
            }

            let target: ReviewTarget | null = resolved.target;
            let fromSelector = resolved.fromSelector;
            const extraInstruction = resolved.extraInstruction;

            while (true) {
                if (!target && fromSelector) {
                    target = await showSecurityTargetSelector(ctx);
                    // Targets picked from the re-opened selector need the
                    // same worktree treatment as the initial resolution.
                    if (target) {
                        const applied = await applyUncommittedWorktree(
                            pi,
                            ctx,
                            target,
                        );
                        if (applied.status === "ok") {
                            target = applied.target;
                        } else {
                            // Cancelled: land back on the preset selector.
                            target = null;
                            continue;
                        }
                    }
                }

                if (!target) {
                    ctx.ui.notify("Security review cancelled", "info");
                    return;
                }

                // Always ask which mode to run the review in: background
                // dispatch is independent of session content, and current
                // session appends to the live conversation.
                const choice = await ctx.ui.select(
                    "Start security review in:",
                    ["Current session", "Background task"],
                );

                if (choice === undefined) {
                    if (fromSelector) {
                        target = null;
                        continue;
                    }
                    ctx.ui.notify("Security review cancelled", "info");
                    return;
                }

                if (choice === "Background task") {
                    await executeBackgroundSecurityReview(
                        ctx,
                        target,
                        extraInstruction,
                    );
                    return;
                }

                await executeSecurityReview(ctx, target, extraInstruction);
                return;
            }
        },
    });
}
