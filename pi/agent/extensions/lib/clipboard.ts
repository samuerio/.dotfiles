import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

/**
 * Minimal structural host for copyToClipboard: any object with a pi.exec
 * compatible method (in practice the pi API object itself). Keeps this lib
 * decoupled from the full ExtensionAPI registration surface while sparing
 * callers an exec wrapper (a detached `pi.exec` binding could lose `this`).
 */
export interface ClipboardHost {
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}

/**
 * Copy text to the system clipboard. Tries `xclip -selection clipboard`
 * then `pbcopy`; returns false when neither tool is available or both fail.
 *
 * The text is fed via bash's `<<<` herestring (JSON.stringify-quoted) so any
 * content (newlines, quotes, control chars) passes through verbatim; keep
 * that mechanism when refactoring.
 */
export async function copyToClipboard(pi: ClipboardHost, text: string): Promise<boolean> {
	for (const cmd of ["xclip -selection clipboard", "pbcopy"]) {
		const bin = cmd.split(" ")[0];
		const check = await pi.exec("which", [bin]);
		if (check.code !== 0) continue;
		const result = await pi.exec("bash", ["-c", `${cmd} <<< ${JSON.stringify(text)}`]);
		if (result.code === 0) return true;
	}
	return false;
}
