import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return [process.execPath, currentScript];
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return [process.execPath];
	}

	return ["pi"];
}

function buildPiStartupCommand(sessionFile: string | undefined, prompt: string): string[] {
	const commandParts = [...getPiInvocationParts()];

	if (sessionFile) {
		commandParts.push("--session", sessionFile);
	}

	if (prompt.length > 0) {
		// pi does not accept `--` as an argument separator; append the prompt directly.
		commandParts.push(prompt);
	}

	return commandParts;
}

async function createForkedSession(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		return undefined;
	}

	const sessionDir = path.dirname(sessionFile);
	const branchEntries = ctx.sessionManager.getBranch();
	const currentHeader = ctx.sessionManager.getHeader();

	const timestamp = new Date().toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const newSessionId = randomUUID();
	const newSessionFile = path.join(sessionDir, `${fileTimestamp}_${newSessionId}.jsonl`);

	const newHeader = {
		type: "session" as const,
		version: currentHeader?.version ?? 3,
		id: newSessionId,
		timestamp,
		cwd: currentHeader?.cwd ?? ctx.cwd,
		parentSession: sessionFile,
	};

	const lines = [JSON.stringify(newHeader), ...branchEntries.map((entry) => JSON.stringify(entry))].join("\n") + "\n";

	await fs.mkdir(sessionDir, { recursive: true });
	await fs.writeFile(newSessionFile, lines, "utf8");

	return newSessionFile;
}

function inTmux(): boolean {
	return Boolean(process.env.TMUX) && Boolean(process.env.TMUX_PANE);
}

function getTmuxPaneId(): string | undefined {
	return process.env.TMUX_PANE?.trim();
}

async function getWindowId(pi: ExtensionAPI, paneId: string): Promise<string | null> {
	const { stdout, code } = await pi.exec("tmux", [
		"display-message",
		"-p",
		"-t",
		paneId,
		"#{window_id}",
	]);
	if (code !== 0) return null;
	return stdout.trim() || null;
}

async function splitTmuxRight(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const paneId = getTmuxPaneId();
	if (!paneId) return null;

	const windowId = await getWindowId(pi, paneId);
	if (!windowId) return null;

	// Collect existing pane IDs before split so we can detect the new one by diff.
	const beforeResult = await pi.exec("tmux", [
		"list-panes",
		"-t",
		windowId,
		"-F",
		"#{pane_id}",
	]);
	const before = new Set(
		beforeResult.stdout
			.trim()
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s.length > 0),
	);

	// split-window -h splits the target pane horizontally; -d keeps focus on original.
	const splitResult = await pi.exec("tmux", [
		"split-window",
		"-h",
		"-d",
		"-c",
		cwd,
		"-t",
		paneId,
	]);
	if (splitResult.code !== 0) {
		return null;
	}

	// Locate the newly created pane by diffing before/after pane IDs.
	const afterResult = await pi.exec("tmux", [
		"list-panes",
		"-t",
		windowId,
		"-F",
		"#{pane_id}",
	]);
	if (afterResult.code !== 0) {
		return null;
	}

	const newPaneId = afterResult.stdout
		.trim()
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.find((id) => !before.has(id));

	return newPaneId ?? null;
}

async function sendCommandToTmuxPane(pi: ExtensionAPI, paneId: string, commandParts: string[]): Promise<boolean> {
	// tmux send-keys sends each positional argument as literal keystrokes.
	// We join the command into a single shell-quoted line and send it as one argument,
	// followed by Enter, so the shell in the new pane parses it as one command.
	const commandLine = commandParts.map(shellQuote).join(" ");
	const args = ["send-keys", "-t", paneId, "--", commandLine];
	const sendResult = await pi.exec("tmux", args);
	if (sendResult.code !== 0) return false;

	const enterResult = await pi.exec("tmux", ["send-keys", "-t", paneId, "Enter"]);
	return enterResult.code === 0;
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("split-fork", {
		description:
			"Fork this session into a new pi process in a right-hand tmux split. Usage: /split-fork [optional prompt]",
		handler: async (args, ctx) => {
			if (!inTmux()) {
				ctx.ui.notify("/split-fork requires running inside tmux.", "warning");
				return;
			}

			const wasBusy = !ctx.isIdle();
			const prompt = args.trim();
			const forkedSessionFile = await createForkedSession(ctx);
			const startupCommand = buildPiStartupCommand(forkedSessionFile, prompt);

			const newPaneId = await splitTmuxRight(pi, ctx.cwd);
			if (!newPaneId) {
				ctx.ui.notify("Failed to create tmux split.", "error");
				if (forkedSessionFile) {
					ctx.ui.notify(`Forked session was created: ${forkedSessionFile}`, "info");
				}
				return;
			}

			const sent = await sendCommandToTmuxPane(pi, newPaneId, startupCommand);
			if (!sent) {
				ctx.ui.notify("Failed to send startup command to the new tmux pane.", "error");
				if (forkedSessionFile) {
					ctx.ui.notify(`Forked session was created: ${forkedSessionFile}`, "info");
				}
				return;
			}

			if (forkedSessionFile) {
				const fileName = path.basename(forkedSessionFile);
				const suffix = prompt ? " and sent prompt" : "";
				ctx.ui.notify(`Forked to ${fileName} in a new tmux split${suffix}.`, "info");
				if (wasBusy) {
					ctx.ui.notify("Forked from current committed state (in-flight turn continues in original session).", "info");
				}
			} else {
				ctx.ui.notify("Opened a new tmux split (no persisted session to fork).", "warning");
			}
		},
	});
}
