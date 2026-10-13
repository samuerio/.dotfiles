import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	SelectList,
	Text,
	type AutocompleteItem,
	type SelectItem,
} from "@earendil-works/pi-tui";

// ─── Action definitions (prompts migrated verbatim from agents/skills/explain/SKILL.md) ───

interface ExplainAction {
	value: string; // command argument, e.g. "what"
	label: string; // list title, e.g. "What it is"
	description: string; // one-line description
	prompt: string; // full rule text
}

const ACTIONS: ExplainAction[] = [
	{
		value: "what",
		label: "What it is",
		description: "What it is and what problem it solves",
		prompt: "Explain what it is and what problem it solves.",
	},
	{
		value: "13y",
		label: "For a 13-year-old",
		description: "Explain so a 13-year-old can understand",
		prompt: "Explain this in a way a 13-year-old can understand.",
	},
	{
		value: "ascii",
		label: "ASCII art",
		description: "Explain using ASCII art diagrams",
		prompt: "Explain this using ASCII art diagrams.",
	},
	{
		value: "hist",
		label: "History",
		description: "Development history as a motivation chain",
		prompt:
			"Explain the development history as a motivation chain — walk through each generation along its evolution path and describe what problem each step was created to solve.",
	},
	{
		value: "impl",
		label: "Implementation",
		description: "How it is implemented",
		prompt: "Explain how it is implemented.",
	},
	{
		value: "shape",
		label: "Input/output shape",
		description: "The input/output shape",
		prompt: "Explain the input/output shape.",
	},
	{
		value: "learn",
		label: "Learning path",
		description: "Steps to learn it, principles up to abstraction",
		prompt: `Explain the learning path — lay out the steps for learning this target from the underlying principles up to the high-level abstraction.

Examples:

Git: hand-written commands -> object model (commit/tree/blob) -> branch mechanics -> GUI.
Database: SQL -> indexes -> execution plans -> ORM.`,
	},
	{
		value: "cmp",
		label: "Comparison",
		description: "Horizontal comparison with 2-4 peers",
		prompt: `Explain by horizontal comparison.

1. Pick 2–4 representative peers. Prefer peers that expose different design choices rather than several nearly identical alternatives.
2. Establish a small set of shared comparison dimensions first, such as core abstraction, consistency, persistence, concurrency model, latency/throughput, scaling, and typical use cases. Choose only dimensions relevant to the target.
3. For each peer, open with its **design philosophy**: a one-line summary followed by 3–5 concrete supporting characteristics (e.g. "extreme minimalism = extreme speed" → multi-threaded, slab allocation, no replication, single data type). This is a summary framing, not the full comparison — then compare the peer against the target from the perspective of **design choice → consequence**. Do not merely enumerate features.
4. Frame each pairwise comparison as the question a reader would actually ask (e.g. "both do X, so where's the real difference?"), not a flat "A vs B" label.
5. For important differences, give a concrete code snippet, command, or operation — not just a described scenario — that makes the distinction tangible. If a wrong choice between the target and a peer is common in practice, this is a good place to show the incorrect usage and the corrected one side by side, instead of a plain example.
6. State the central tradeoff explicitly: what capability or guarantee is gained, and what cost or constraint is accepted in exchange.
7. End with 2–5 transferable rules that generalize beyond the named products. Phrase them as decision principles the reader can reuse in another system, and illustrate at least the non-obvious ones with a short code/pseudocode block.

Keep the target as the center of the comparison. The goal is to explain **why these systems differ and when those differences matter**, not to rank them globally.

When a claim depends strongly on version, configuration, workload, or deployment topology, qualify it instead of presenting a benchmark number or implementation detail as universal.

Suggested output shape:

- comparison dimensions / compact table
- target vs each peer, one subsection per pair, framed as a question (include a misuse/anti-pattern example here if a wrong choice is common)
- overall tradeoff map or decision axes (an ASCII diagram works well when the axes are spatial, e.g. latency vs durability)
- transferable rules, code-illustrated where non-obvious

Examples:

Go Mutex: Go Mutex vs Java synchronized vs Rust Mutex vs C++ mutex
  → tradeoff: richer safety semantics (ownership / poisoning / monitors) vs minimal overhead
  → rule: same memory-model problem; pick the primitive by safety guarantees you need, not by language habit.
Redis: Redis vs MySQL vs Memcached vs etcd
  → tradeoff: speed vs durability vs simplicity vs strong consensus
  → rule: place the workload on the speed / consistency / durability axes first, then pick the system at that coordinate.`,
	},
];

const ACTION_VALUES = ACTIONS.map((a) => a.value).join(", ");

// ─── Prompt construction ─────────────────────────────────────────

function buildPrompt(action: ExplainAction, targetArgs: string): string {
	const target = targetArgs.trim();
	const targetRule = target
		? `**Target parsing**\n- Target: ${target}`
		: "**Target parsing**\n- Infer the target from the conversation context. If unclear, ask the user one concise clarifying question.";

	return `${targetRule}\n\n**Output rules**\n- Respond in Chinese.\n\n${action.prompt}`;
}

// ─── Argument parsing ────────────────────────────────────────────

/**
 * Grammar: /explain [action] [-t <target>...]. -t/--target is greedy: it
 * consumes the rest of the line as the target, so multi-word targets need no
 * quoting and targets conflicting with action values stay expressible.
 */
export function parseExplainArgs(
	args: string,
): { actionValue: string; target: string; error: string | null } {
	const tokens = args.trim().split(/\s+/);
	let actionValue = "";
	let inTarget = false;
	const targetWords: string[] = [];
	for (const token of tokens) {
		const targetFlag = token === "-t" || token === "--target";
		const eqForm = token.startsWith("--target=");
		if (targetFlag || eqForm) {
			inTarget = true;
			if (eqForm && token.length > "--target=".length) {
				targetWords.push(token.slice("--target=".length));
			}
		} else if (inTarget) {
			targetWords.push(token);
		} else if (token && !actionValue) {
			actionValue = token;
		} else if (token) {
			return {
				actionValue: "",
				target: "",
				error: `Missing -t/--target before "${token}". Usage: /explain [action] [-t <target>...]`,
			};
		}
	}
	const target = targetWords.join(" ");
	if (inTarget && !target) {
		return {
			actionValue: "",
			target: "",
			error:
				"Missing value after -t/--target. Usage: /explain [action] [-t <target>...]",
		};
	}
	return { actionValue, target, error: null };
}

// ─── Action selector (files.ts-style bordered SelectList) ────────

/**
 * Generic bordered SelectList. SelectList keeps the caller's item objects by
 * reference and hands the selected one back, so `done(item as T)` restores the
 * original typed item (same cast background-task.ts does with item.value).
 */
function showActionMenu<T extends SelectItem>(
	ctx: ExtensionCommandContext,
	title: string,
	items: T[],
): Promise<T | null> {
	return ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title))));

		const selectList = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item as T);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(
			new Text(
				theme.fg("dim", "Press enter to confirm or esc to cancel"),
			),
		);
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

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
	});
}

// ─── Extension registration ──────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("explain", {
		description: `Explain [action] [-t <target>...]: ${ACTIONS.map(
			(a) => a.value,
		).join("/")}`,
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const toCompletion = (a: ExplainAction) => ({
				value: a.value,
				label: a.label,
				description: a.description,
			});
			if (!prefix) {
				return ACTIONS.map(toCompletion);
			}
			const matches = fuzzyFilter(ACTIONS, prefix, (a) => `${a.value} ${a.label}`);
			return matches.length ? matches.map(toCompletion) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// Parse and validate first so invalid input fails fast instead of
			// waiting for an in-flight turn. Deliver last: pi executes extension
			// commands immediately even while streaming, but sendUserMessage
			// without deliverAs throws then (prompt silently dropped); compaction
			// throws even earlier. waitForIdle covers both.
			const parsed = parseExplainArgs(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const target = parsed.target;
			const deliver = async (prompt: string) => {
				await ctx.waitForIdle();
				pi.sendUserMessage(prompt);
			};

			if (parsed.actionValue) {
				const action = ACTIONS.find((a) => a.value === parsed.actionValue);
				if (!action) {
					ctx.ui.notify(
						`Unknown action "${parsed.actionValue}". Available: ${ACTION_VALUES}`,
						"error",
					);
					return;
				}
				await deliver(buildPrompt(action, target));
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(
					"Choose an action explicitly in print/JSON mode: /explain [action] [-t <target>...]",
					"error",
				);
				return;
			}
			const action = await showActionMenu(ctx, "Explain what?", ACTIONS);
			if (!action) {
				ctx.ui.notify("Explain cancelled.", "info");
				return;
			}
			await deliver(buildPrompt(action, target));
		},
	});
}
