import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const REPORT_PATH = path.join(".pi", "iterate-report.md");

type CriticResult = {
	score: number;
	summary: string;
	suggestions: string[];
};

type RoleName = "actor" | "critic" | "commit";

type IterationReport = {
	iteration: number;
	actorStatus: string;
	critic?: CriticResult;
	accepted: boolean;
	commit?: string;
	rollback?: string;
	error?: string;
};

type RunRoleResult = {
	output: string;
	stopReason?: string;
	errorMessage?: string;
};

const ACTOR_SYSTEM_PROMPT = `You are the actor agent in an iterative coding workflow.
Your job is to modify the working tree to implement or improve the user's self-contained task.
Follow project instructions. Use tools to inspect and edit files. Be concrete and finish the implementation in this single session.
Do not commit changes. The commit agent handles commits.
Return a concise summary of what you changed.`;

const CRITIC_SYSTEM_PROMPT = `You are the critic agent in an iterative coding workflow.
Your job is to inspect the current working tree and score how well it satisfies the user's self-contained task.
You must be strict, technical, and actionable.
Do not modify files.
Your final response must end with a parseable JSON object or fenced json block with exactly this shape:
{
  "score": 82,
  "summary": "short summary",
  "suggestions": ["specific improvement 1", "specific improvement 2"]
}
score must be an integer from 0 to 100.`;

const COMMIT_SYSTEM_PROMPT = `You are the commit agent in an iterative coding workflow.
Your job is to stage all current changes and create exactly one git commit with a meaningful Conventional Commit message.
Inspect the diff/status first. If there are no changes, clearly report that no commit was created.
Do not make non-git file edits.`;

function usage(): string {
	return "Usage: /iterate <maxIter> <task...> or /iterate <maxIter> @file.md";
}

function shortSha(sha: string | undefined): string {
	return sha ? sha.slice(0, 7) : "none";
}

function markdownList(items: string[]): string {
	if (items.length === 0) return "(none)";
	return items.map((item) => `- ${item}`).join("\n");
}

function extractTextFromAssistantMessage(message: any): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

function getLastAssistantMessage(messages: readonly any[]): any | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") return messages[i];
	}
	return undefined;
}

function normalizeSuggestions(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((item) => String(item).trim()).filter(Boolean);
	}
	if (typeof value === "string" && value.trim()) return [value.trim()];
	return [];
}

function extractJsonCandidates(text: string): string[] {
	const candidates: string[] = [];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
	let match: RegExpExecArray | null;
	while ((match = fenced.exec(text)) !== null) {
		if (match[1]?.trim()) candidates.push(match[1].trim());
	}

	const lastOpen = text.lastIndexOf("{");
	const lastClose = text.lastIndexOf("}");
	if (lastOpen >= 0 && lastClose > lastOpen) {
		candidates.push(text.slice(lastOpen, lastClose + 1).trim());
	}

	return candidates.reverse();
}

function parseCriticResult(text: string): CriticResult {
	for (const candidate of extractJsonCandidates(text)) {
		try {
			const parsed = JSON.parse(candidate);
			const score = Number(parsed.score);
			if (!Number.isFinite(score) || score < 0 || score > 100) continue;
			const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
			return {
				score: Math.round(score),
				summary: summary || "(no summary)",
				suggestions: normalizeSuggestions(parsed.suggestions),
			};
		} catch {
			// Try next candidate.
		}
	}
	throw new Error(`Failed to parse critic JSON. Critic output:\n${text}`);
}

async function readTask(cwd: string, rawTask: string): Promise<string> {
	const trimmed = rawTask.trim();
	if (!trimmed) throw new Error(usage());
	if (!trimmed.startsWith("@")) return trimmed;

	const fileRef = trimmed.slice(1).trim();
	if (!fileRef) throw new Error("@file path is empty");
	const filePath = path.isAbsolute(fileRef) ? fileRef : path.join(cwd, fileRef);
	return (await fs.readFile(filePath, "utf8")).trim();
}

function parseIterateArgs(args: string | undefined): { maxIter: number; rawTask: string } {
	const text = args?.trim() ?? "";
	const match = text.match(/^(\d+)\s+([\s\S]+)$/);
	if (!match) throw new Error(usage());
	const maxIter = Number(match[1]);
	if (!Number.isInteger(maxIter) || maxIter <= 0) throw new Error(usage());
	return { maxIter, rawTask: match[2].trim() };
}

async function git(pi: ExtensionAPI, args: string[]): Promise<string> {
	const result = await pi.exec("git", args);
	if (result.code !== 0) {
		const message = result.stderr || result.stdout || `git ${args.join(" ")} failed`;
		throw new Error(message.trim());
	}
	return result.stdout.trim();
}

async function gitStatus(pi: ExtensionAPI): Promise<string> {
	const result = await pi.exec("git", ["status", "--porcelain"]);
	if (result.code !== 0) throw new Error(result.stderr || result.stdout || "git status failed");
	return result.stdout.trim();
}

async function ensureGitClean(pi: ExtensionAPI): Promise<string> {
	await git(pi, ["rev-parse", "--git-dir"]);
	const status = await gitStatus(pi);
	if (status) {
		throw new Error(`Working tree is not clean. Please commit or stash changes first.\n${status}`);
	}
	return git(pi, ["rev-parse", "HEAD"]);
}

async function hasDiff(pi: ExtensionAPI): Promise<boolean> {
	return (await gitStatus(pi)).length > 0;
}

async function rollback(pi: ExtensionAPI, commit: string): Promise<void> {
	await git(pi, ["reset", "--hard", commit]);
	await git(pi, ["clean", "-fd"]);
}

async function ensureReport(cwd: string): Promise<string> {
	const reportPath = path.join(cwd, REPORT_PATH);
	await fs.mkdir(path.dirname(reportPath), { recursive: true });
	await fs.writeFile(
		reportPath,
		`# Iterate Report\n\nStarted: ${new Date().toISOString()}\n\n`,
		"utf8",
	);
	return reportPath;
}

async function appendReport(reportPath: string, entry: IterationReport): Promise<void> {
	const critic = entry.critic;
	const body = [
		`## Iteration ${entry.iteration}`,
		``,
		`- Actor: ${entry.actorStatus}`,
		critic ? `- Critic score: ${critic.score}` : undefined,
		critic ? `- Critic summary: ${critic.summary}` : undefined,
		`- Result: ${entry.accepted ? "accepted" : "rejected"}`,
		entry.commit ? `- Commit: ${entry.commit}` : undefined,
		entry.rollback ? `- Rollback: ${entry.rollback}` : undefined,
		entry.error ? `- Error: ${entry.error}` : undefined,
		critic ? `\nSuggestions:\n${markdownList(critic.suggestions)}` : undefined,
		``,
	]
		.filter((line) => line !== undefined)
		.join("\n");
	await fs.appendFile(reportPath, body, "utf8");
}

function updateWidget(
	ctx: ExtensionCommandContext,
	state: {
		phase: string;
		iteration?: number;
		maxIter?: number;
		acceptedScore?: number;
		currentScore?: number;
		commit?: string;
	},
): void {
	if (!ctx.hasUI) return;
	const iter = state.iteration && state.maxIter ? `iter ${state.iteration}/${state.maxIter}` : "idle";
	const score = state.currentScore === undefined ? "" : ` current ${state.currentScore}`;
	const accepted = state.acceptedScore === undefined ? "accepted n/a" : `accepted ${state.acceptedScore}`;
	ctx.ui.setWidget("iterate", [
		ctx.ui.theme.fg(
			"accent",
			`Iterate: ${state.phase} | ${iter} | ${accepted}${score} | ${shortSha(state.commit)}`,
		),
	]);
}

async function runRole(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	role: RoleName,
	systemPrompt: string,
	tools: string[],
	prompt: string,
): Promise<RunRoleResult> {
	const agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		noExtensions: true,
		systemPrompt,
	});
	await loader.reload();

	const result = await createAgentSession({
		cwd: ctx.cwd,
		agentDir,
		model: ctx.model,
		thinkingLevel: pi.getThinkingLevel(),
		modelRegistry: ctx.modelRegistry,
		tools,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(ctx.cwd),
	});

	const { session } = result;
	try {
		await session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
		const lastAssistant = getLastAssistantMessage(session.messages);
		return {
			output: extractTextFromAssistantMessage(lastAssistant),
			stopReason: lastAssistant?.stopReason,
			errorMessage: lastAssistant?.errorMessage,
		};
	} finally {
		session.dispose();
	}
}

function assertRoleSuccess(role: RoleName, result: RunRoleResult): void {
	if (result.stopReason === "error" || result.stopReason === "aborted" || result.errorMessage) {
		throw new Error(`${role} failed: ${result.errorMessage || result.stopReason || "unknown error"}`);
	}
}

function buildActorPrompt(input: {
	iteration: number;
	maxIter: number;
	task: string;
	acceptedScore?: number;
	acceptedSuggestions: string[];
	avoidNotes: string[];
}): string {
	return `# Actor Iteration ${input.iteration}/${input.maxIter}

## Original Task
${input.task}

## Accepted State
Accepted score: ${input.acceptedScore === undefined ? "none yet" : input.acceptedScore}

Accepted suggestions to address:
${markdownList(input.acceptedSuggestions)}

Avoid notes from rejected attempts:
${markdownList(input.avoidNotes)}

## Instructions
Modify the current working tree to implement or improve the task.
If accepted suggestions exist, focus on addressing them.
If avoid notes exist, avoid repeating those failed directions.
Do not commit changes.
Finish in this session and summarize the changes.`;
}

function buildCriticPrompt(input: { iteration: number; task: string; acceptedScore?: number }): string {
	return `# Critic Iteration ${input.iteration}

## Original Task
${input.task}

## Accepted Score Before This Iteration
${input.acceptedScore === undefined ? "none yet" : input.acceptedScore}

## Instructions
Inspect the current working tree after the actor's changes.
Score the implementation against the original task from 0 to 100.
Be strict. Include concrete suggestions for the next actor iteration.
Your final response must end with only a parseable JSON object or fenced json block with keys score, summary, suggestions.`;
}

function buildCommitPrompt(input: { iteration: number; task: string; score: number; summary: string }): string {
	return `# Commit Iteration ${input.iteration}

## Original Task
${input.task}

## Critic Score
${input.score}

## Critic Summary
${input.summary}

## Instructions
Run git status and inspect the diff briefly.
Stage all changes and create exactly one git commit.
Use a concise Conventional Commit message that reflects the implemented task.
If there are no changes, report that no commit was created.`;
}

async function runIterate(pi: ExtensionAPI, args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	const { maxIter, rawTask } = parseIterateArgs(args);
	const task = await readTask(ctx.cwd, rawTask);
	if (!task.trim()) throw new Error("Task is empty");

	const initialHead = await ensureGitClean(pi);
	const reportPath = await ensureReport(ctx.cwd);

	let acceptedCommit = initialHead;
	let acceptedScore: number | undefined;
	let acceptedSuggestions: string[] = [];
	let avoidNotes: string[] = [];

	ctx.ui.notify(`Iterate started (${maxIter} iterations max)`, "info");

	for (let iteration = 1; iteration <= maxIter; iteration++) {
		updateWidget(ctx, { phase: "actor", iteration, maxIter, acceptedScore, commit: acceptedCommit });
		const actor = await runRole(
			pi,
			ctx,
			"actor",
			ACTOR_SYSTEM_PROMPT,
			["read", "bash", "edit", "write", "grep", "find", "ls"],
			buildActorPrompt({ iteration, maxIter, task, acceptedScore, acceptedSuggestions, avoidNotes }),
		);
		assertRoleSuccess("actor", actor);

		updateWidget(ctx, { phase: "critic", iteration, maxIter, acceptedScore, commit: acceptedCommit });
		const criticRun = await runRole(
			pi,
			ctx,
			"critic",
			CRITIC_SYSTEM_PROMPT,
			["read", "grep", "find", "ls"],
			buildCriticPrompt({ iteration, task, acceptedScore }),
		);
		assertRoleSuccess("critic", criticRun);
		const critic = parseCriticResult(criticRun.output);

		const isBaseline = acceptedScore === undefined;
		const shouldAccept = isBaseline || critic.score > acceptedScore;

		updateWidget(ctx, {
			phase: shouldAccept ? "commit" : "rollback",
			iteration,
			maxIter,
			acceptedScore,
			currentScore: critic.score,
			commit: acceptedCommit,
		});

		if (shouldAccept) {
			if (!(await hasDiff(pi))) {
				if (isBaseline) throw new Error("First iteration produced no diff, cannot create baseline commit");
				await appendReport(reportPath, {
					iteration,
					actorStatus: actor.output || "completed",
					critic,
					accepted: false,
					error: "No diff to commit",
				});
				continue;
			}

			const commitRun = await runRole(
				pi,
				ctx,
				"commit",
				COMMIT_SYSTEM_PROMPT,
				["bash"],
				buildCommitPrompt({ iteration, task, score: critic.score, summary: critic.summary }),
			);
			assertRoleSuccess("commit", commitRun);

			const newHead = await git(pi, ["rev-parse", "HEAD"]);
			if (newHead === acceptedCommit) throw new Error("Commit agent completed but HEAD did not change");

			acceptedCommit = newHead;
			acceptedScore = critic.score;
			acceptedSuggestions = critic.suggestions;
			avoidNotes = [];

			await appendReport(reportPath, {
				iteration,
				actorStatus: actor.output || "completed",
				critic,
				accepted: true,
				commit: acceptedCommit,
			});
		} else {
			avoidNotes = [
				`Rejected iteration ${iteration} with score ${critic.score} <= accepted score ${acceptedScore}. Summary: ${critic.summary}`,
				...critic.suggestions,
			].filter(Boolean);
			const reportBeforeRollback = await fs.readFile(reportPath, "utf8").catch(() => undefined);
			await rollback(pi, acceptedCommit);
			if (reportBeforeRollback !== undefined) {
				await fs.writeFile(reportPath, reportBeforeRollback, "utf8");
			}
			await appendReport(reportPath, {
				iteration,
				actorStatus: actor.output || "completed",
				critic,
				accepted: false,
				rollback: `reset to ${acceptedCommit}`,
			});
		}
	}

	updateWidget(ctx, { phase: "done", maxIter, acceptedScore, commit: acceptedCommit });
	ctx.ui.notify(`Iterate done. Best score: ${acceptedScore ?? "n/a"}. Report: ${REPORT_PATH}`, "info");
}

export default function iterateExtension(pi: ExtensionAPI): void {
	pi.registerCommand("iterate", {
		description: "Run iterative actor/critic/commit agents for a self-contained task",
		handler: async (args, ctx) => {
			let reportPath: string | undefined;
			try {
				reportPath = path.join(ctx.cwd, REPORT_PATH);
				await runIterate(pi, args, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (reportPath) {
					await fs.mkdir(path.dirname(reportPath), { recursive: true }).catch(() => undefined);
					await fs.appendFile(reportPath, `\n## Failure\n\n${message}\n`, "utf8").catch(() => undefined);
				}
				ctx.ui.notify(`Iterate failed: ${message}`, "error");
			} finally {
				if (ctx.hasUI) ctx.ui.setWidget("iterate", undefined);
			}
		},
	});
}
