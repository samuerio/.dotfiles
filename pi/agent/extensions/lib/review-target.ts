/**
 * Shared review-target layer for the /review and /security-review extensions.
 *
 * Owns everything target-shaped that both commands need: the ReviewTarget
 * model, git plumbing (merge base, branches, commits, PR checkout), the
 * preset selector (with optional extra items for command-specific toggles),
 * direct-argument parsing, and the background prompt dispatch helper.
 * Per-command rubrics, prompt templates, and session machinery (loop
 * fixing, /end-review) stay in the command extensions.
 */


import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
    Container,
    fuzzyFilter,
    Input,
    type SelectItem,
    SelectList,
    Spacer,
    Text,
} from "@earendil-works/pi-tui";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
    dispatchBackgroundTask,
    TaskAliasConflictError,
    type DispatchResult,
} from "../background-task.ts";


// Review target types (matching Codex's approach)
export type ReviewTarget =
    | { type: "uncommitted"; worktreePath?: string }
    | { type: "baseBranch"; branch: string }
    | { type: "commit"; sha: string; title?: string }
    | {
          type: "pullRequest";
          prNumber: number;
          baseBranch: string;
          title: string;
          /** Branch that was checked out before the PR checkout (for the background review switch-back hint). */
          originalBranch?: string | null;
      }
    | { type: "folder"; paths: string[] };

/**
 * Get the merge base between HEAD and a branch
 */
export async function getMergeBase(
    pi: ExtensionAPI,
    branch: string,
): Promise<string | null> {
    try {
        // First try to get the upstream tracking branch
        const { stdout: upstream, code: upstreamCode } = await pi.exec("git", [
            "rev-parse",
            "--abbrev-ref",
            `${branch}@{upstream}`,
        ]);

        if (upstreamCode === 0 && upstream.trim()) {
            const { stdout: mergeBase, code } = await pi.exec("git", [
                "merge-base",
                "HEAD",
                upstream.trim(),
            ]);
            if (code === 0 && mergeBase.trim()) {
                return mergeBase.trim();
            }
        }

        // Fall back to using the branch directly
        const { stdout: mergeBase, code } = await pi.exec("git", [
            "merge-base",
            "HEAD",
            branch,
        ]);
        if (code === 0 && mergeBase.trim()) {
            return mergeBase.trim();
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Get list of local branches
 */
async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
    const { stdout, code } = await pi.exec("git", [
        "branch",
        "--format=%(refname:short)",
    ]);
    if (code !== 0) return [];
    return stdout
        .trim()
        .split("\n")
        .filter((b) => b.trim());
}

/**
 * Get list of recent commits
 */
async function getRecentCommits(
    pi: ExtensionAPI,
    limit: number = 10,
): Promise<Array<{ sha: string; title: string }>> {
    const { stdout, code } = await pi.exec("git", [
        "log",
        `--oneline`,
        `-n`,
        `${limit}`,
    ]);
    if (code !== 0) return [];

    return stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
            const [sha, ...rest] = line.trim().split(" ");
            return { sha, title: rest.join(" ") };
        });
}

/**
 * Check if there are uncommitted changes (staged, unstaged, or untracked)
 */
async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
    const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
    return code === 0 && stdout.trim().length > 0;
}

/**
 * Check if there are changes that would prevent switching branches
 * (staged or unstaged changes to tracked files - untracked files are fine)
 */
async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
    // Check for staged or unstaged changes to tracked files
    const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
    if (code !== 0) return false;

    // Filter out untracked files (lines starting with ??)
    const lines = stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim());
    const trackedChanges = lines.filter((line) => !line.startsWith("??"));
    return trackedChanges.length > 0;
}

type WorktreeEntry = {
    path: string;
    /** Checked-out branch without the refs/heads/ prefix; null for detached HEAD. */
    branch: string | null;
    bare: boolean;
};

/**
 * List git worktrees via `git worktree list --porcelain`. Returns null when
 * git itself fails (NOT when the repo simply has no worktrees): enumeration
 * failure is surfaced as an error and handled like a picker cancel, since
 * silently reviewing the current worktree while other worktrees may hold
 * the changes would hide the failure.
 *
 * Entries are blank-line separated; known keys are recognized line-by-line
 * and unknown keys (including `locked [reason]` and `prunable [reason]`)
 * are ignored. Locked entries are NOT filtered here: locked only prevents
 * removal, reviewing them is fine. Bare entries are kept but callers skip
 * them (no working tree, no uncommitted changes).
 */
async function listWorktrees(pi: ExtensionAPI): Promise<WorktreeEntry[] | null> {
    const { stdout, code } = await pi.exec("git", [
        "worktree",
        "list",
        "--porcelain",
    ]);
    if (code !== 0) return null;

    const entries: WorktreeEntry[] = [];
    let pending: {
        path?: string;
        branch: string | null;
        bare: boolean;
    } | null = null;

    const flush = () => {
        if (pending?.path) {
            entries.push({
                path: pending.path,
                branch: pending.branch,
                bare: pending.bare,
            });
        }
        pending = null;
    };

    for (const rawLine of stdout.split("\n")) {
        const line = rawLine.trim();
        if (!line) {
            flush();
            continue;
        }
        if (line.startsWith("worktree ")) {
            flush();
            pending = { path: line.slice("worktree ".length), branch: null, bare: false };
        } else if (line.startsWith("branch ")) {
            if (pending) {
                pending.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
            }
        } else if (line === "bare") {
            if (pending) pending.bare = true;
        } else if (line === "detached" || line.startsWith("HEAD ")) {
            // detached HEAD: leave branch as null; raw HEAD sha is unused
        }
        // ignore locked / prunable / unknown keys
    }
    flush();
    return entries;
}

/** Number of dirty files (tracked + untracked) in a worktree, or null if git fails. */
async function getWorktreeDirtyCount(
    pi: ExtensionAPI,
    worktreePath: string,
): Promise<number | null> {
    const { stdout, code } = await pi.exec("git", [
        "-C",
        worktreePath,
        "status",
        "--porcelain",
    ]);
    if (code !== 0) return null;
    const trimmed = stdout.trim();
    return trimmed ? trimmed.split("\n").length : 0;
}

/** Shorten an absolute path's home prefix to `~` for display. */
function prettyPath(value: string): string {
    const home = process.env.HOME;
    return home && value.startsWith(home)
        ? `~${value.slice(home.length)}`
        : value;
}

export type UncommittedWorktreeResult =
    | { status: "ok"; target: ReviewTarget }
    /** The user dismissed the worktree picker. */
    | { status: "cancelled" }
    /** git could not enumerate worktrees; callers treat this like cancel. */
    | { status: "error" };

/**
 * For an uncommitted review target in a multi-worktree repo, let the user
 * pick which worktree's uncommitted changes to review. The current worktree
 * is listed first (pre-selected) so the usual case is Enter; picking it
 * leaves `worktreePath` undefined so the prompt stays byte-identical to the
 * single-worktree behavior.
 */
export async function applyUncommittedWorktree(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
): Promise<UncommittedWorktreeResult> {
    if (target.type !== "uncommitted") {
        return { status: "ok", target };
    }

    const worktrees = await listWorktrees(pi);
    if (worktrees === null) {
        ctx.ui.notify(
            "Failed to list git worktrees; cannot offer a worktree choice.",
            "error",
        );
        return { status: "error" };
    }
    const cwd = path.resolve(ctx.cwd);

    // Skip bare entries and directories missing on disk (prunable/deleted).
    const candidates: Array<{ entry: WorktreeEntry; current: boolean }> = [];
    for (const entry of worktrees) {
        if (entry.bare) continue;
        const stat = await fs.stat(entry.path).catch(() => null);
        if (!stat?.isDirectory()) continue;
        candidates.push({ entry, current: path.resolve(entry.path) === cwd });
    }

    // No other valid worktree: nothing to disambiguate, behave as before.
    const hasOtherWorktree = candidates.some((c) => !c.current);
    if (!hasOtherWorktree) return { status: "ok", target };

    // Current worktree first (pre-selected), then others sorted by path.
    const currentEntries = candidates.filter((c) => c.current);
    const otherEntries = candidates
        .filter((c) => !c.current)
        .sort((a, b) => a.entry.path.localeCompare(b.entry.path));
    const ordered = [...currentEntries, ...otherEntries];

    const lines: Array<{ label: string; entry: WorktreeEntry; current: boolean }> = [];
    for (const { entry, current } of ordered) {
        const dirty = await getWorktreeDirtyCount(pi, entry.path);
        const counts =
            dirty === null ? "? dirty" : `${dirty} dirty`;
        const branchLabel = entry.branch ?? "detached HEAD";
        lines.push({
            entry,
            current,
            label: current
                ? `${prettyPath(entry.path)} (${branchLabel}, ${counts}, current)`
                : `${prettyPath(entry.path)} (${branchLabel}, ${counts})`,
        });
    }

    const choice = await ctx.ui.select(
        "Select worktree to review:",
        lines.map((line) => line.label),
    );
    if (choice === undefined) {
        return { status: "cancelled" };
    }

    const picked = lines.find((line) => line.label === choice);
    if (!picked || picked.current) {
        // Current worktree (or unknown selection): keep the default prompt.
        return { status: "ok", target: { type: "uncommitted" } };
    }
    return {
        status: "ok",
        target: { type: "uncommitted", worktreePath: picked.entry.path },
    };
}

/**
 * Standard instruction block appended to an uncommitted review prompt when a
 * worktree other than the current one was selected. Git commands and file
 * reads must target that worktree explicitly: the child cwd for background
 * tasks is the main repo, and in-session tools also run in the launching
 * cwd, so without these instructions the review inspects the wrong tree.
 */
function worktreeInstructionsBlock(worktreePath: string): string {
    return [
        "",
        "",
        `Target worktree: ${worktreePath} (different from your current working directory).`,
        `- Run every git command with \`git -C ${worktreePath}\` (e.g. \`git -C ${worktreePath} status --porcelain\`, \`git -C ${worktreePath} diff\`, \`git -C ${worktreePath} diff --staged\`, \`git -C ${worktreePath} ls-files --others --exclude-standard\`).`,
        `- All file paths you mention in findings must be relative to the worktree root \`${worktreePath}\`.`,
        `- Read files under \`${worktreePath}\` (not your current working directory) when inspecting them.`,
    ].join("\n");
}
/**
 * Parse a PR reference (URL or number) and return the PR number
 */
function parsePrReference(ref: string): number | null {
    const trimmed = ref.trim();

    // Try as a number first
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num > 0) {
        return num;
    }

    // Try to extract from GitHub URL
    // Formats: https://github.com/owner/repo/pull/123
    //          github.com/owner/repo/pull/123
    const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
    if (urlMatch) {
        return parseInt(urlMatch[1], 10);
    }

    return null;
}

/**
 * Get PR information from GitHub CLI
 */
async function getPrInfo(
    pi: ExtensionAPI,
    prNumber: number,
): Promise<{ baseBranch: string; title: string; headBranch: string } | null> {
    const { stdout, code } = await pi.exec("gh", [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "baseRefName,title,headRefName",
    ]);

    if (code !== 0) return null;

    try {
        const data = JSON.parse(stdout);
        return {
            baseBranch: data.baseRefName,
            title: data.title,
            headBranch: data.headRefName,
        };
    } catch {
        return null;
    }
}

/**
 * Checkout a PR using GitHub CLI
 */
async function checkoutPr(
    pi: ExtensionAPI,
    prNumber: number,
): Promise<{
    success: boolean;
    error?: string;
    originalBranch?: string | null;
}> {
    // Capture the pre-checkout branch before gh pr checkout switches it.
    const originalBranch = await getCurrentBranch(pi);
    const { stdout, stderr, code } = await pi.exec("gh", [
        "pr",
        "checkout",
        String(prNumber),
    ]);

    if (code !== 0) {
        return {
            success: false,
            error: stderr || stdout || "Failed to checkout PR",
        };
    }

    return { success: true, originalBranch };
}

/**
 * Get the current branch name
 */
async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
    const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
    if (code === 0 && stdout.trim()) {
        return stdout.trim();
    }
    return null;
}

/**
 * Get the default branch (main or master)
 */
async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
    // Try to get from remote HEAD
    const { stdout, code } = await pi.exec("git", [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "--short",
    ]);
    if (code === 0 && stdout.trim()) {
        return stdout.trim().replace("origin/", "");
    }

    // Fall back to checking if main or master exists
    const branches = await getLocalBranches(pi);
    if (branches.includes("main")) return "main";
    if (branches.includes("master")) return "master";

    return "main"; // Default fallback
}

/**
 * Get user-facing hint for the review target
 */
export function getUserFacingHint(target: ReviewTarget): string {
    switch (target.type) {
        case "uncommitted":
            return target.worktreePath
                ? `current changes in worktree ${target.worktreePath}`
                : "current changes";
        case "baseBranch":
            return `changes against '${target.branch}'`;
        case "commit": {
            const shortSha = target.sha.slice(0, 7);
            return target.title
                ? `commit ${shortSha}: ${target.title}`
                : `commit ${shortSha}`;
        }

        case "pullRequest": {
            const shortTitle =
                target.title.length > 30
                    ? target.title.slice(0, 27) + "..."
                    : target.title;
            return `PR #${target.prNumber}: ${shortTitle}`;
        }

        case "folder": {
            const joined = target.paths.join(", ");
            return joined.length > 40
                ? `folders: ${joined.slice(0, 37)}...`
                : `folders: ${joined}`;
        }
    }
}

/** Short target token used in auto-generated background review aliases. */
export function reviewTargetToken(target: ReviewTarget): string {
    switch (target.type) {
        case "baseBranch":
            return "branch";
        case "pullRequest":
            return "pr";
        default:
            return target.type;
    }
}

/** Local-time HHmmss stamp for auto-generated aliases. */
export function hhmmssStamp(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Per-command prompt templates for {@link buildTargetFocusPrompt}. */
export type TargetPromptTemplates = {
    uncommitted: string;
    baseBranchWithMergeBase: string;
    baseBranchFallback: string;
    commitWithTitle: string;
    commit: string;
    pullRequestWithMergeBase: string;
    pullRequestFallback: string;
    folder: string;
};

/**
 * Build the per-target focus prompt from a command's prompt templates:
 * resolves the merge base for baseBranch/pullRequest targets and fills the
 * matching template's placeholders. The templates themselves (and any
 * command-specific suffixes such as local-changes instructions) stay with
 * each command.
 */
export async function buildTargetFocusPrompt(
    pi: ExtensionAPI,
    target: ReviewTarget,
    templates: TargetPromptTemplates,
): Promise<string> {
    switch (target.type) {
        case "uncommitted":
            return target.worktreePath
                ? templates.uncommitted +
                      worktreeInstructionsBlock(target.worktreePath)
                : templates.uncommitted;

        case "baseBranch": {
            const mergeBase = await getMergeBase(pi, target.branch);
            return mergeBase
                ? templates.baseBranchWithMergeBase
                      .replace(/{baseBranch}/g, target.branch)
                      .replace(/{mergeBaseSha}/g, mergeBase)
                : templates.baseBranchFallback.replace(
                      /{branch}/g,
                      target.branch,
                  );
        }

        case "commit":
            if (target.title) {
                return templates.commitWithTitle
                    .replace("{sha}", target.sha)
                    .replace("{title}", target.title);
            }
            return templates.commit.replace("{sha}", target.sha);

        case "pullRequest": {
            const mergeBase = await getMergeBase(pi, target.baseBranch);
            return mergeBase
                ? templates.pullRequestWithMergeBase
                      .replace(/{prNumber}/g, String(target.prNumber))
                      .replace(/{title}/g, target.title)
                      .replace(/{baseBranch}/g, target.baseBranch)
                      .replace(/{mergeBaseSha}/g, mergeBase)
                : templates.pullRequestFallback
                      .replace(/{prNumber}/g, String(target.prNumber))
                      .replace(/{title}/g, target.title)
                      .replace(/{baseBranch}/g, target.baseBranch);
        }

        case "folder":
            return templates.folder.replace(
                "{paths}",
                target.paths.join(", "),
            );
    }
}

// Review preset options for the selector (keep this order stable)
const REVIEW_PRESETS = [
    {
        value: "uncommitted",
        label: "Review uncommitted changes",
        description: "",
    },
    {
        value: "baseBranch",
        label: "Review against a base branch",
        description: "(local)",
    },
    { value: "commit", label: "Review a commit", description: "" },
    {
        value: "pullRequest",
        label: "Review a pull request",
        description: "(GitHub PR)",
    },
    {
        value: "folder",
        label: "Review a folder (or more)",
        description: "(snapshot, not diff)",
    },
] as const;

/**
 * Determine the smart default review type based on git state
 */
async function getSmartDefault(pi: ExtensionAPI): Promise<
    "uncommitted" | "baseBranch" | "commit"
> {
    // Priority 1: If there are uncommitted changes, default to reviewing them
    if (await hasUncommittedChanges(pi)) {
        return "uncommitted";
    }

    // Priority 2: If on a feature branch (not the default branch), default to PR-style review
    const currentBranch = await getCurrentBranch(pi);
    const defaultBranch = await getDefaultBranch(pi);
    if (currentBranch && currentBranch !== defaultBranch) {
        return "baseBranch";
    }

    // Priority 3: Default to reviewing a specific commit
    return "commit";
}

/**
 * Show branch selector for base branch review
 */
async function showBranchSelector(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
): Promise<ReviewTarget | null> {
    const branches = await getLocalBranches(pi);
    const currentBranch = await getCurrentBranch(pi);
    const defaultBranch = await getDefaultBranch(pi);

    // Never offer the current branch as a base branch (reviewing against itself is meaningless).
    const candidateBranches = currentBranch
        ? branches.filter((b) => b !== currentBranch)
        : branches;

    if (candidateBranches.length === 0) {
        ctx.ui.notify(
            currentBranch
                ? `No other branches found (current branch: ${currentBranch})`
                : "No branches found",
            "error",
        );
        return null;
    }

    // Sort branches with default branch first
    const sortedBranches = candidateBranches.sort((a, b) => {
        if (a === defaultBranch) return -1;
        if (b === defaultBranch) return 1;
        return a.localeCompare(b);
    });

    const items: SelectItem[] = sortedBranches.map((branch) => ({
        value: branch,
        label: branch,
        description: branch === defaultBranch ? "(default)" : "",
    }));

    const result = await ctx.ui.custom<string | null>(
        (tui, theme, keybindings, done) => {
            const container = new Container();
            container.addChild(
                new DynamicBorder((str) => theme.fg("accent", str)),
            );
            container.addChild(
                new Text(
                    theme.fg("accent", theme.bold("Select base branch")),
                ),
            );

            const searchInput = new Input();
            container.addChild(searchInput);
            container.addChild(new Spacer(1));

            const listContainer = new Container();
            container.addChild(listContainer);
            container.addChild(
                new Text(
                    theme.fg(
                        "dim",
                        "Type to filter • enter to select • esc to cancel",
                    ),
                ),
            );
            container.addChild(
                new DynamicBorder((str) => theme.fg("accent", str)),
            );

            let filteredItems = items;
            let selectList: SelectList | null = null;

            const updateList = () => {
                listContainer.clear();
                if (filteredItems.length === 0) {
                    listContainer.addChild(
                        new Text(
                            theme.fg("warning", "  No matching branches"),
                        ),
                    );
                    selectList = null;
                    return;
                }

                selectList = new SelectList(
                    filteredItems,
                    Math.min(filteredItems.length, 10),
                    {
                        selectedPrefix: (text) => theme.fg("accent", text),
                        selectedText: (text) => theme.fg("accent", text),
                        description: (text) => theme.fg("muted", text),
                        scrollInfo: (text) => theme.fg("dim", text),
                        noMatch: (text) => theme.fg("warning", text),
                    },
                );

                selectList.onSelect = (item) => done(item.value);
                selectList.onCancel = () => done(null);
                listContainer.addChild(selectList);
            };

            const applyFilter = () => {
                const query = searchInput.getValue();
                filteredItems = query
                    ? fuzzyFilter(
                          items,
                          query,
                          (item) =>
                              `${item.label} ${item.value} ${item.description ?? ""}`,
                      )
                    : items;
                updateList();
            };

            applyFilter();

            return {
                render(width: number) {
                    return container.render(width);
                },
                invalidate() {
                    container.invalidate();
                },
                handleInput(data: string) {
                    if (
                        keybindings.matches(data, "tui.select.up") ||
                        keybindings.matches(data, "tui.select.down") ||
                        keybindings.matches(data, "tui.select.confirm") ||
                        keybindings.matches(data, "tui.select.cancel")
                    ) {
                        if (selectList) {
                            selectList.handleInput(data);
                        } else if (
                            keybindings.matches(data, "tui.select.cancel")
                        ) {
                            done(null);
                        }
                        tui.requestRender();
                        return;
                    }

                    searchInput.handleInput(data);
                    applyFilter();
                    tui.requestRender();
                },
            };
        },
    );

    if (!result) return null;
    return { type: "baseBranch", branch: result };
}

/**
 * Show commit selector
 */
async function showCommitSelector(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
): Promise<ReviewTarget | null> {
    const commits = await getRecentCommits(pi, 20);

    if (commits.length === 0) {
        ctx.ui.notify("No commits found", "error");
        return null;
    }

    const items: SelectItem[] = commits.map((commit) => ({
        value: commit.sha,
        label: `${commit.sha.slice(0, 7)} ${commit.title}`,
        description: "",
    }));

    const result = await ctx.ui.custom<{
        sha: string;
        title: string;
    } | null>((tui, theme, keybindings, done) => {
        const container = new Container();
        container.addChild(
            new DynamicBorder((str) => theme.fg("accent", str)),
        );
        container.addChild(
            new Text(
                theme.fg("accent", theme.bold("Select commit to review")),
            ),
        );

        const searchInput = new Input();
        container.addChild(searchInput);
        container.addChild(new Spacer(1));

        const listContainer = new Container();
        container.addChild(listContainer);
        container.addChild(
            new Text(
                theme.fg(
                    "dim",
                    "Type to filter • enter to select • esc to cancel",
                ),
            ),
        );
        container.addChild(
            new DynamicBorder((str) => theme.fg("accent", str)),
        );

        let filteredItems = items;
        let selectList: SelectList | null = null;

        const updateList = () => {
            listContainer.clear();
            if (filteredItems.length === 0) {
                listContainer.addChild(
                    new Text(theme.fg("warning", "  No matching commits")),
                );
                selectList = null;
                return;
            }

            selectList = new SelectList(
                filteredItems,
                Math.min(filteredItems.length, 10),
                {
                    selectedPrefix: (text) => theme.fg("accent", text),
                    selectedText: (text) => theme.fg("accent", text),
                    description: (text) => theme.fg("muted", text),
                    scrollInfo: (text) => theme.fg("dim", text),
                    noMatch: (text) => theme.fg("warning", text),
                },
            );

            selectList.onSelect = (item) => {
                const commit = commits.find((c) => c.sha === item.value);
                if (commit) {
                    done(commit);
                } else {
                    done(null);
                }
            };
            selectList.onCancel = () => done(null);
            listContainer.addChild(selectList);
        };

        const applyFilter = () => {
            const query = searchInput.getValue();
            filteredItems = query
                ? fuzzyFilter(
                      items,
                      query,
                      (item) =>
                          `${item.label} ${item.value} ${item.description ?? ""}`,
                  )
                : items;
            updateList();
        };

        applyFilter();

        return {
            render(width: number) {
                return container.render(width);
            },
            invalidate() {
                container.invalidate();
            },
            handleInput(data: string) {
                if (
                    keybindings.matches(data, "tui.select.up") ||
                    keybindings.matches(data, "tui.select.down") ||
                    keybindings.matches(data, "tui.select.confirm") ||
                    keybindings.matches(data, "tui.select.cancel")
                ) {
                    if (selectList) {
                        selectList.handleInput(data);
                    } else if (
                        keybindings.matches(data, "tui.select.cancel")
                    ) {
                        done(null);
                    }
                    tui.requestRender();
                    return;
                }

                searchInput.handleInput(data);
                applyFilter();
                tui.requestRender();
            },
        };
    });

    if (!result) return null;
    return { type: "commit", sha: result.sha, title: result.title };
}

function parseReviewPaths(value: string): string[] {
    return value
        .split(/\s+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

/**
 * Show folder input
 */
async function showFolderInput(
    ctx: ExtensionContext,
): Promise<ReviewTarget | null> {
    const result = await ctx.ui.editor(
        "Enter folders/files to review (space-separated or one per line):",
        ".",
    );

    if (!result?.trim()) return null;
    const paths = parseReviewPaths(result);
    if (paths.length === 0) return null;

    return { type: "folder", paths };
}

/**
 * Show PR input and handle checkout
 */
async function showPrInput(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
): Promise<ReviewTarget | null> {
    // First check for pending changes that would prevent branch switching
    if (await hasPendingChanges(pi)) {
        ctx.ui.notify(
            "Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.",
            "error",
        );
        return null;
    }

    // Get PR reference from user
    const prRef = await ctx.ui.editor(
        "Enter PR number or URL (e.g. 123 or https://github.com/owner/repo/pull/123):",
        "",
    );

    if (!prRef?.trim()) return null;

    const prNumber = parsePrReference(prRef);
    if (!prNumber) {
        ctx.ui.notify(
            "Invalid PR reference. Enter a number or GitHub PR URL.",
            "error",
        );
        return null;
    }

    // Get PR info from GitHub
    ctx.ui.notify(`Fetching PR #${prNumber} info...`, "info");
    const prInfo = await getPrInfo(pi, prNumber);

    if (!prInfo) {
        ctx.ui.notify(
            `Could not find PR #${prNumber}. Make sure gh is authenticated and the PR exists.`,
            "error",
        );
        return null;
    }

    // Check again for pending changes (in case something changed)
    if (await hasPendingChanges(pi)) {
        ctx.ui.notify(
            "Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.",
            "error",
        );
        return null;
    }

    // Checkout the PR
    ctx.ui.notify(`Checking out PR #${prNumber}...`, "info");
    const checkoutResult = await checkoutPr(pi, prNumber);

    if (!checkoutResult.success) {
        ctx.ui.notify(
            `Failed to checkout PR: ${checkoutResult.error}`,
            "error",
        );
        return null;
    }

    ctx.ui.notify(
        `Checked out PR #${prNumber} (${prInfo.headBranch})`,
        "info",
    );

    return {
        type: "pullRequest",
        prNumber,
        baseBranch: prInfo.baseBranch,
        title: prInfo.title,
        originalBranch: checkoutResult.originalBranch,
    };
}

/** Extra selector item appended after the preset items (e.g. a mode toggle). */
export type ExtraSelectItem = SelectItem & {
    /**
     * Handle this item being selected. Return true to reopen the selector,
     * false to cancel it (no caller currently returns false).
     */
    onSelect: () => Promise<boolean>;
};

/**
 * Show the shared review preset selector (target-picking layer for /review
 * and /security-review). Extra items (e.g. command-specific toggles) are
 * appended after the presets and handle their own selection.
 */
export async function showTargetSelector(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    opts: { extraItems?: () => ExtraSelectItem[] } = {},
): Promise<ReviewTarget | null> {
    // Determine smart default (but keep the list order stable)
    const smartDefault = await getSmartDefault(pi);
    const presetItems: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
        value: preset.value,
        label: preset.label,
        description: preset.description,
    }));
    const smartDefaultIndex = presetItems.findIndex(
        (item) => item.value === smartDefault,
    );

    while (true) {
        const extraItems = opts.extraItems?.() ?? [];
        const items: SelectItem[] = [...presetItems, ...extraItems];

        const result = await ctx.ui.custom<string | null>(
            (tui, theme, _kb, done) => {
                const container = new Container();
                container.addChild(
                    new DynamicBorder((str) => theme.fg("accent", str)),
                );
                container.addChild(
                    new Text(
                        theme.fg(
                            "accent",
                            theme.bold("Select a review preset"),
                        ),
                    ),
                );

                const selectList = new SelectList(
                    items,
                    Math.min(items.length, 10),
                    {
                        selectedPrefix: (text) => theme.fg("accent", text),
                        selectedText: (text) => theme.fg("accent", text),
                        description: (text) => theme.fg("muted", text),
                        scrollInfo: (text) => theme.fg("dim", text),
                        noMatch: (text) => theme.fg("warning", text),
                    },
                );

                // Preselect the smart default without reordering the list
                if (smartDefaultIndex >= 0) {
                    selectList.setSelectedIndex(smartDefaultIndex);
                }

                selectList.onSelect = (item) => done(item.value as string);
                selectList.onCancel = () => done(null);

                container.addChild(selectList);
                container.addChild(
                    new Text(
                        theme.fg(
                            "dim",
                            "Press enter to confirm or esc to go back",
                        ),
                    ),
                );
                container.addChild(
                    new DynamicBorder((str) => theme.fg("accent", str)),
                );

                return {
                    render(width: number) {
                        return container.render(width);
                    },
                    invalidate() {
                        container.invalidate();
                    },
                    handleInput(data: string) {
                        selectList.handleInput(data);
                        tui.requestRender();
                    },
                };
            },
        );

        if (!result) return null;

        const extra = extraItems.find((item) => item.value === result);
        if (extra) {
            const keepOpen = await extra.onSelect();
            if (keepOpen) continue;
            return null;
        }

        // Handle each preset type
        switch (result) {
            case "uncommitted":
                return { type: "uncommitted" };

            case "baseBranch": {
                const target = await showBranchSelector(pi, ctx);
                if (target) return target;
                break;
            }

            case "commit": {
                const target = await showCommitSelector(pi, ctx);
                if (target) return target;
                break;
            }

            case "folder": {
                const target = await showFolderInput(ctx);
                if (target) return target;
                break;
            }

            case "pullRequest": {
                const target = await showPrInput(pi, ctx);
                if (target) return target;
                break;
            }

            default:
                return null;
        }
    }
}

/**
 * Build the "Add/Remove custom instructions" selector toggle shared by the
 * review commands. Reading goes through get; storing (or clearing, with
 * undefined) goes through set. The noun appears in the labels and
 * notifications ("review" / "security review"), the scope in the
 * description and editor prompt ("review modes" / "security reviews").
 */
export function makeCustomInstructionsToggle(
    ctx: ExtensionContext,
    options: {
        get: () => string | undefined;
        set: (instructions: string | undefined) => void;
        noun: string;
        scope: string;
    },
): ExtraSelectItem {
    const current = options.get();
    return {
        value: "toggleCustomInstructions",
        label: current
            ? `Remove custom ${options.noun} instructions`
            : `Add custom ${options.noun} instructions`,
        description: current
            ? "(currently set)"
            : `(applies to all ${options.scope})`,
        onSelect: async () => {
            if (current) {
                options.set(undefined);
                ctx.ui.notify(
                    `Custom ${options.noun} instructions removed`,
                    "info",
                );
                return true;
            }

            const customInstructions = await ctx.ui.editor(
                `Enter custom ${options.noun} instructions (applies to all ${options.scope}):`,
                "",
            );

            if (!customInstructions?.trim()) {
                ctx.ui.notify(
                    `Custom ${options.noun} instructions not changed`,
                    "info",
                );
                return true;
            }

            options.set(customInstructions);
            ctx.ui.notify(`Custom ${options.noun} instructions saved`, "info");
            return true;
        },
    };
}

/**
 * Handle PR checkout and return a ReviewTarget (or null on failure)
 */
export async function handlePrCheckout(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    ref: string,
): Promise<ReviewTarget | null> {
    // First check for pending changes
    if (await hasPendingChanges(pi)) {
        ctx.ui.notify(
            "Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.",
            "error",
        );
        return null;
    }

    const prNumber = parsePrReference(ref);
    if (!prNumber) {
        ctx.ui.notify(
            "Invalid PR reference. Enter a number or GitHub PR URL.",
            "error",
        );
        return null;
    }

    // Get PR info
    ctx.ui.notify(`Fetching PR #${prNumber} info...`, "info");
    const prInfo = await getPrInfo(pi, prNumber);

    if (!prInfo) {
        ctx.ui.notify(
            `Could not find PR #${prNumber}. Make sure gh is authenticated and the PR exists.`,
            "error",
        );
        return null;
    }

    // Checkout the PR
    ctx.ui.notify(`Checking out PR #${prNumber}...`, "info");
    const checkoutResult = await checkoutPr(pi, prNumber);

    if (!checkoutResult.success) {
        ctx.ui.notify(
            `Failed to checkout PR: ${checkoutResult.error}`,
            "error",
        );
        return null;
    }

    ctx.ui.notify(
        `Checked out PR #${prNumber} (${prInfo.headBranch})`,
        "info",
    );

    return {
        type: "pullRequest",
        prNumber,
        baseBranch: prInfo.baseBranch,
        title: prInfo.title,
        originalBranch: checkoutResult.originalBranch,
    };
}

/**
 * Parse command arguments for direct invocation
 * Returns the target or a special marker for PR that needs async handling
 */
export type ParsedTargetArgs = {
    target: ReviewTarget | { type: "pr"; ref: string } | null;
    extraInstruction?: string;
    error?: string;
};

function tokenizeArgs(value: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < value.length; i++) {
        const char = value[i];

        if (quote) {
            if (char === "\\" && i + 1 < value.length) {
                current += value[i + 1];
                i += 1;
                continue;
            }
            if (char === quote) {
                quote = null;
                continue;
            }
            current += char;
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = "";
            }
            continue;
        }

        current += char;
    }

    if (current.length > 0) {
        tokens.push(current);
    }

    return tokens;
}

export function parseTargetArgs(args: string | undefined): ParsedTargetArgs {
    if (!args?.trim()) return { target: null };

    const rawParts = tokenizeArgs(args.trim());
    const parts: string[] = [];
    let extraInstruction: string | undefined;

    for (let i = 0; i < rawParts.length; i++) {
        const part = rawParts[i];
        if (part === "--extra") {
            const next = rawParts[i + 1];
            if (!next) {
                return { target: null, error: "Missing value for --extra" };
            }
            extraInstruction = next;
            i += 1;
            continue;
        }

        if (part.startsWith("--extra=")) {
            extraInstruction = part.slice("--extra=".length);
            continue;
        }

        parts.push(part);
    }

    if (parts.length === 0) {
        return { target: null, extraInstruction };
    }

    const subcommand = parts[0]?.toLowerCase();

    switch (subcommand) {
        case "uncommitted":
            return { target: { type: "uncommitted" }, extraInstruction };

        case "branch": {
            const branch = parts[1];
            if (!branch) return { target: null, extraInstruction };
            return {
                target: { type: "baseBranch", branch },
                extraInstruction,
            };
        }

        case "commit": {
            const sha = parts[1];
            if (!sha) return { target: null, extraInstruction };
            const title = parts.slice(2).join(" ") || undefined;
            return {
                target: { type: "commit", sha, title },
                extraInstruction,
            };
        }

        case "folder": {
            const paths = parseReviewPaths(parts.slice(1).join(" "));
            if (paths.length === 0)
                return { target: null, extraInstruction };
            return { target: { type: "folder", paths }, extraInstruction };
        }

        case "pr": {
            const ref = parts[1];
            if (!ref) return { target: null, extraInstruction };
            return { target: { type: "pr", ref }, extraInstruction };
        }

        default:
            return { target: null, extraInstruction };
    }
}

export type ResolveReviewTargetResult =
    | {
          status: "ok";
          target: ReviewTarget;
          extraInstruction?: string;
          fromSelector: boolean;
      }
    /** The user dismissed target selection; the caller notifies cancellation. */
    | { status: "cancelled" }
    /** The failure was already notified; the caller returns silently. */
    | { status: "error" };

/**
 * Shared command-handler prelude for the review commands: git repository
 * check, direct-argument parsing (including PR checkout with fallback to
 * the selector), and the no-args selector path. Callers keep their own
 * interactivity and command-specific guards before this, and own the mode
 * selection loop afterwards. commandLabel is the lowercase command noun
 * used in the PR-checkout fallback warning.
 */
export async function resolveReviewTarget(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    args: string | undefined,
    opts: {
        commandLabel: string;
        selectTarget: (ctx: ExtensionContext) => Promise<ReviewTarget | null>;
    },
): Promise<ResolveReviewTargetResult> {
    // Check if we're in a git repository
    const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
    if (code !== 0) {
        ctx.ui.notify("Not a git repository", "error");
        return { status: "error" };
    }
    // Try to parse direct arguments
    const parsed = parseTargetArgs(args);
    if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return { status: "error" };
    }
    const extraInstruction = parsed.extraInstruction?.trim() || undefined;
    let target: ReviewTarget | null = null;
    let fromSelector = false;
    if (parsed.target) {
        if (parsed.target.type === "pr") {
            // Handle PR checkout (async operation)
            target = await handlePrCheckout(pi, ctx, parsed.target.ref);
            if (!target) {
                ctx.ui.notify(
                    `PR ${opts.commandLabel} review failed. Returning to review menu.`,
                    "warning",
                );
            }
        } else {
            target = parsed.target;
        }
    }
    // If no args or invalid args, show selector
    if (!target) {
        fromSelector = true;
        target = await opts.selectTarget(ctx);
    }
    if (!target) {
        return { status: "cancelled" };
    }

    // Uncommitted targets offer a worktree picker when the repo has other
    // worktrees. Cancelling (or a worktree listing failure, surfaced as an
    // error there) behaves like cancelling target selection: from the
    // selector path it re-opens the selector (so the worktree picker
    // re-appears if "uncommitted" is chosen again), from direct args it
    // cancels the whole command.
    while (true) {
        if (target.type !== "uncommitted") break;
        const applied = await applyUncommittedWorktree(pi, ctx, target);
        if (applied.status === "ok") {
            target = applied.target;
            break;
        }
        if (!fromSelector) {
            return { status: "cancelled" };
        }
        const next = await opts.selectTarget(ctx);
        if (!next) {
            return { status: "cancelled" };
        }
        target = next;
    }

    return { status: "ok", target, extraInstruction, fromSelector };
}
export type PromptTaskOptions = {
    /**
     * Command name used as the alias prefix, e.g. "review" or
     * "security-review"; a "-2" retry handles same-second collisions.
     */
    command: string;
    /** Child session name shown in /background-tasks. */
    description: string;
    /** Fully-built prompt sent to the child. */
    prompt: string;
    /** Lead phrase for the success notification, e.g. "Background review". */
    notifyLead: string;
    /** Review target (used for the PR switch-back hint). */
    target: ReviewTarget;
};

/**
 * Dispatch a fully-built prompt as a background task (no worktree: the child
 * runs directly in the main repo). Fire-and-forget: results are observed
 * via /background-tasks (Status to watch, "Add result to prompt" to act on
 * findings). The child sees the working tree as it exists when it runs, so
 * reviews of uncommitted changes may see later edits.
 */
export async function dispatchPromptTask(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    options: PromptTaskOptions,
): Promise<void> {
    const alias = `${options.command}-${reviewTargetToken(options.target)}-${hhmmssStamp()}`;
    let result: DispatchResult;
    try {
        result = await dispatchBackgroundTask(pi, {
            alias,
            prompt: options.prompt,
            description: options.description,
            worktree: false,
            ctx,
        });
    } catch (error) {
        // Alias collision (two dispatches within the same second): retry
        // once with a "-2" suffix. Other dispatch failures leave a task
        // that is listed and closable via /background-tasks; report and stop.
        if (!(error instanceof TaskAliasConflictError)) {
            ctx.ui.notify(
                error instanceof Error ? error.message : String(error),
                "error",
            );
            return;
        }
        try {
            result = await dispatchBackgroundTask(pi, {
                alias: `${alias}-2`,
                prompt: options.prompt,
                description: options.description,
                worktree: false,
                ctx,
            });
        } catch (retryError) {
            ctx.ui.notify(
                retryError instanceof Error
                    ? retryError.message
                    : String(retryError),
                "error",
            );
            return;
        }
    }

    const lines = [
        `${options.notifyLead} dispatched: ${result.alias}`,
        `  ${result.attachCommand}`,
        `  Results via /background-tasks → select "${result.alias}" → Add result to prompt`,
    ];
    if (
        options.target.type === "pullRequest" &&
        options.target.originalBranch
    ) {
        lines.push(
            `  Original branch: ${options.target.originalBranch} (switch back: git checkout ${options.target.originalBranch})`,
        );
    }
    ctx.ui.notify(lines.join("\n"), "info");
}
