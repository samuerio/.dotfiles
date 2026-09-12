import {
	type Api,
	type AssistantMessage,
	calculateCost,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const TREND_SAMPLE_COUNT = 8;
const MAX_LABEL_LENGTH = 60;

export interface CacheUsageRecord {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	promptTokens: number;
	hitRatePercent: number | null;
	uncachedRatePercent: number | null;
	promptCost: number | null;
	estimatedSavings: number | null;
}

export interface CacheSample extends CacheUsageRecord {
	hitRatePercent: number;
	uncachedRatePercent: number;
	epoch: number;
	timestamp: number;
	provider: string;
	model: string;
	inputUnitCost: number | null;
	cacheReadUnitCost: number | null;
	paidPromptUnitCost: number | null;
}

export interface CacheComparison {
	previousRequestNumber: number;
	hitRateDeltaPercent: number;
	hitRateLossPercent: number;
	promptTokenDelta: number;
	cacheReadDelta: number;
	reusablePrefixTokens: number;
	rebilledTokens: number;
	rebilledPercent: number | null;
	estimatedMissPremium: number | null;
	modelChanged: boolean;
	requestStartGapMs: number;
}

export interface CacheAggregate {
	requestCount: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	promptTokens: number;
	hitRatePercent: number | null;
	promptCost: number | null;
	estimatedSavings: number | null;
	rebilledTokens: number;
	estimatedMissPremium: number | null;
	bestHitRatePercent: number | null;
	worstHitRatePercent: number | null;
}

export interface CacheMonitorView {
	streaming: boolean;
	requestNumber: number;
	latest: CacheSample | null;
	comparison: CacheComparison | null;
	session: CacheAggregate;
	trend: number[];
}

export interface MonitorLine {
	role: "title" | "good" | "warning" | "bad" | "muted" | "dim";
	text: string;
	/**
	 * Optional TUI-only graphic. Rendered at paint time in TUI mode so it rescales
	 * on resize via invalidate/render; plain (non-TUI) mode falls back to text.
	 * JSON.stringify drops function properties, so publishedSignature stays
	 * text-only and this field never affects it.
	 */
	renderGraphic?: (theme: Theme, width: number) => string;
}

export interface CollectedCacheSamples {
	samples: CacheSample[];
	summaryRecords: CacheUsageRecord[];
	currentEpoch: number;
}

export interface CacheMonitorViewOptions {
	activeEpoch?: number;
	summaryRecords?: readonly CacheUsageRecord[];
}

type CostModelResolver = (provider: string, model: string) => Model<Api> | undefined;

export function collectCacheSamples(
	entries: readonly SessionEntry[],
	resolveCostModel: CostModelResolver = () => undefined,
): CollectedCacheSamples {
	const samples: CacheSample[] = [];
	const summaryRecords: CacheUsageRecord[] = [];
	const cacheReportingProviders = new Set<string>();
	let currentEpoch = 0;
	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			const summaryCalculation = entry.usage
				? calculateCacheUsage(entry.usage, { retainUnknownCacheAccounting: true })
				: null;
			if (summaryCalculation) summaryRecords.push(summaryCalculation.record);
			currentEpoch += 1;
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const sample = createCacheSample(
			entry.message,
			currentEpoch,
			resolveCostModel(entry.message.provider, entry.message.model),
			cacheReportingProviders.has(entry.message.provider),
		);
		if (sample) {
			if (sample.cacheRead > 0 || sample.cacheWrite > 0) {
				cacheReportingProviders.add(sample.provider);
			}
			samples.push(sample);
		}
	}
	return { samples, summaryRecords, currentEpoch };
}

export function createCacheSample(
	message: AssistantMessage,
	epoch: number,
	costModel?: Model<Api>,
	cacheAccountingKnown = false,
): CacheSample | null {
	const calculation = calculateCacheUsage(message.usage, {
		costModel,
		cacheAccountingKnown,
	});
	if (
		!calculation ||
		calculation.record.hitRatePercent === null ||
		calculation.record.uncachedRatePercent === null
	) {
		return null;
	}

	return {
		...calculation.record,
		hitRatePercent: calculation.record.hitRatePercent,
		uncachedRatePercent: calculation.record.uncachedRatePercent,
		epoch,
		timestamp: finiteNumber(message.timestamp),
		provider: message.provider,
		model: message.model,
		inputUnitCost: calculation.inputUnitCost,
		cacheReadUnitCost: calculation.cacheReadUnitCost,
		paidPromptUnitCost: calculation.paidPromptUnitCost,
	};
}

export function cacheSamplesEqual(left: CacheSample, right: CacheSample): boolean {
	return (
		left.epoch === right.epoch &&
		left.timestamp === right.timestamp &&
		left.provider === right.provider &&
		left.model === right.model &&
		left.input === right.input &&
		left.cacheRead === right.cacheRead &&
		left.cacheWrite === right.cacheWrite &&
		left.promptCost === right.promptCost &&
		left.estimatedSavings === right.estimatedSavings &&
		left.inputUnitCost === right.inputUnitCost &&
		left.cacheReadUnitCost === right.cacheReadUnitCost &&
		left.paidPromptUnitCost === right.paidPromptUnitCost
	);
}

export function createCacheMonitorView(
	finalizedSamples: readonly CacheSample[],
	streamingSample?: CacheSample,
	options: CacheMonitorViewOptions = {},
): CacheMonitorView {
	const samples = streamingSample ? [...finalizedSamples, streamingSample] : [...finalizedSamples];
	const latest = samples.at(-1) ?? null;
	const activeEpoch = options.activeEpoch ?? latest?.epoch;
	const previousIndex =
		latest && latest.epoch === activeEpoch
			? findPreviousComparableIndex(samples, samples.length - 1, latest.epoch)
			: -1;
	const previous = previousIndex >= 0 ? samples[previousIndex] : undefined;

	return {
		streaming: streamingSample !== undefined,
		requestNumber: samples.length,
		latest,
		comparison:
			latest && previous ? compareCacheSamples(previous, latest, previousIndex + 1) : null,
		session: aggregateCacheSamples(samples, options.summaryRecords),
		trend: samples.slice(-TREND_SAMPLE_COUNT).map((sample) => sample.hitRatePercent),
	};
}

export function compareCacheSamples(
	previous: CacheSample,
	current: CacheSample,
	previousRequestNumber: number,
): CacheComparison | null {
	if (previous.epoch !== current.epoch) return null;
	const reusablePrefixTokens = Math.min(previous.promptTokens, current.promptTokens);
	const reusedTokens = Math.min(current.cacheRead, reusablePrefixTokens);
	const rebilledTokens = Math.max(0, reusablePrefixTokens - reusedTokens);
	const hitRateDeltaPercent = current.hitRatePercent - previous.hitRatePercent;
	const unitPremium =
		current.paidPromptUnitCost !== null && current.cacheReadUnitCost !== null
			? Math.max(0, current.paidPromptUnitCost - current.cacheReadUnitCost)
			: null;

	return {
		previousRequestNumber,
		hitRateDeltaPercent,
		hitRateLossPercent: Math.max(0, -hitRateDeltaPercent),
		promptTokenDelta: current.promptTokens - previous.promptTokens,
		cacheReadDelta: current.cacheRead - previous.cacheRead,
		reusablePrefixTokens,
		rebilledTokens,
		rebilledPercent:
			reusablePrefixTokens > 0 ? (rebilledTokens / reusablePrefixTokens) * 100 : null,
		estimatedMissPremium: unitPremium === null ? null : rebilledTokens * unitPremium,
		modelChanged: previous.provider !== current.provider || previous.model !== current.model,
		requestStartGapMs: Math.max(0, current.timestamp - previous.timestamp),
	};
}

export function aggregateCacheSamples(
	samples: readonly CacheSample[],
	additionalRecords: readonly CacheUsageRecord[] = [],
): CacheAggregate {
	let input = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let promptCost = 0;
	let promptCostKnown = true;
	let estimatedSavings = 0;
	let savingsKnown = true;
	let rebilledTokens = 0;
	let estimatedMissPremium = 0;
	let hasRebilledTokens = false;
	let missPremiumComplete = true;
	let cacheAccountingComplete = true;
	let bestHitRatePercent: number | null = null;
	let worstHitRatePercent: number | null = null;

	const addUsage = (record: CacheUsageRecord): void => {
		input += record.input;
		cacheRead += record.cacheRead;
		cacheWrite += record.cacheWrite;
		if (record.promptCost === null) promptCostKnown = false;
		else promptCost += record.promptCost;
		if (record.estimatedSavings === null) savingsKnown = false;
		else estimatedSavings += record.estimatedSavings;
		if (record.hitRatePercent === null) {
			cacheAccountingComplete = false;
		} else {
			bestHitRatePercent = Math.max(
				bestHitRatePercent ?? record.hitRatePercent,
				record.hitRatePercent,
			);
			worstHitRatePercent = Math.min(
				worstHitRatePercent ?? record.hitRatePercent,
				record.hitRatePercent,
			);
		}
	};

	for (const sample of samples) addUsage(sample);
	for (const record of additionalRecords) addUsage(record);

	for (let index = 0; index < samples.length; index += 1) {
		const sample = samples[index];
		if (!sample) continue;
		const previousIndex = findPreviousComparableIndex(samples, index, sample.epoch);
		if (previousIndex < 0) continue;
		const previous = samples[previousIndex];
		if (!previous) continue;
		const comparison = compareCacheSamples(previous, sample, previousIndex + 1);
		if (!comparison) continue;
		rebilledTokens += comparison.rebilledTokens;
		if (comparison.rebilledTokens <= 0) continue;
		hasRebilledTokens = true;
		if (comparison.estimatedMissPremium === null) missPremiumComplete = false;
		else estimatedMissPremium += comparison.estimatedMissPremium;
	}

	const requestCount = samples.length + additionalRecords.length;
	const promptTokens = input + cacheRead + cacheWrite;
	return {
		requestCount,
		input,
		cacheRead,
		cacheWrite,
		promptTokens,
		hitRatePercent:
			promptTokens > 0 && cacheAccountingComplete ? (cacheRead / promptTokens) * 100 : null,
		promptCost: promptCostKnown ? promptCost : null,
		estimatedSavings: requestCount > 0 && savingsKnown ? estimatedSavings : null,
		rebilledTokens,
		estimatedMissPremium: hasRebilledTokens && missPremiumComplete ? estimatedMissPremium : null,
		bestHitRatePercent,
		worstHitRatePercent,
	};
}

export function formatMonitorLines(view: CacheMonitorView): MonitorLine[] {
	if (!view.latest) {
		if (view.session.requestCount > 0) {
			return [
				{ role: "title", text: "Prompt cache · summary usage only" },
				...formatSessionLines(view.session),
				{
					role: "dim",
					text: "Latest request metrics are unavailable on this branch.",
				},
			];
		}
		return [
			{ role: "title", text: "Prompt cache · waiting for provider cache usage" },
			{
				role: "dim",
				text: "Hit = cacheRead / (input + cacheRead + cacheWrite). All-zero cache fields remain unknown until this provider reports cache activity.",
			},
		];
	}

	const latest = view.latest;
	const comparison = view.comparison;
	const session = view.session;
	const live = view.streaming ? " · LIVE" : "";
	const lines: MonitorLine[] = [
		{
			role: "title",
			text: `Prompt cache${live} · request #${view.requestNumber} · ${sanitizeDisplayLabel(latest.provider)}/${sanitizeDisplayLabel(latest.model)}`,
		},
		{
			role: hitRateSeverity(latest.hitRatePercent).role,
			text: [
				`Latest  hit ${formatPercent(latest.hitRatePercent)}`,
				comparison ? `Δ ${formatSignedPercent(comparison.hitRateDeltaPercent)}` : "Δ n/a",
				comparison ? `loss ${formatPercentagePoints(comparison.hitRateLossPercent)}` : "loss n/a",
				`uncached ${formatPercent(latest.uncachedRatePercent)}`,
			].join("  ·  "),
		},
		{
			role: "muted",
			text: [
				`Tokens  prompt ${formatTokens(latest.promptTokens)}`,
				`read ${formatTokens(latest.cacheRead)}`,
				`write ${formatTokens(latest.cacheWrite)}`,
				`uncached ${formatTokens(latest.input)}`,
				comparison ? `prompt Δ ${formatSignedTokens(comparison.promptTokenDelta)}` : "prompt Δ n/a",
			].join("  ·  "),
		},
	];

	if (latest.promptTokens > 0) {
		lines.push({
			role: "muted",
			text: `Tokens split  ${compositionSummary(latest)}`,
			renderGraphic: (theme, width) => renderCompositionGraphic(latest, theme, width),
		});
	}

	if (comparison) {
		lines.push({
			role: comparison.rebilledTokens > 0 ? "warning" : "good",
			text: [
				`Reuse vs #${comparison.previousRequestNumber}`,
				`eligible ${formatTokens(comparison.reusablePrefixTokens)}`,
				`re-billed ${formatTokens(comparison.rebilledTokens)} (${formatNullablePercent(comparison.rebilledPercent)})`,
				`read Δ ${formatSignedTokens(comparison.cacheReadDelta)}`,
				comparison.modelChanged ? "model changed" : "same model",
				`start gap ${formatDuration(comparison.requestStartGapMs)}`,
			].join("  ·  "),
		});
	} else {
		lines.push({
			role: "dim",
			text: "Reuse  no comparable request in the current cache epoch (session start or compaction boundary).",
		});
	}

	lines.push(
		{
			role: "muted",
			text: [
				`Cost  prompt ${formatNullableMoney(latest.promptCost)}`,
				`cache saved ~${formatNullableMoney(latest.estimatedSavings)}`,
				`miss premium ~${formatNullableMoney(comparison?.estimatedMissPremium ?? null)}`,
			].join("  ·  "),
		},
		...formatSessionLines(session),
	);
	const severity = hitRateSeverity(latest.hitRatePercent);
	const sparkline = renderSparkline(view.trend, view.trend.length);
	if (sparkline) {
		lines.push({
			role: severity.role,
			text: sparkline,
			renderGraphic: (theme, width) => theme.fg(severity.colorKey, renderSparkline(view.trend, width)),
		});
	}
	lines.push(
		{
			role: "dim",
			text: `Trend old→new  ${view.trend.map(formatPercent).join(" → ")}`,
		},
		{
			role: "dim",
			text: "Formula  hit=read/prompt · re-billed=max(0, min(previous prompt, current prompt) - current read); costs are estimates from reported/model rates.",
		},
	);
	return lines;
}

function formatSessionLine(session: CacheAggregate): MonitorLine {
	return {
		role: "muted",
		text: [
			`Session  ${session.requestCount} req`,
			`hit ${formatNullablePercent(session.hitRatePercent)}`,
			`read ${formatTokens(session.cacheRead)}`,
			`uncached ${formatTokens(session.input)}`,
			`write ${formatTokens(session.cacheWrite)}`,
			`cost ${formatNullableMoney(session.promptCost)}`,
			`saved ~${formatNullableMoney(session.estimatedSavings)}`,
			`re-billed ${formatTokens(session.rebilledTokens)} (~${formatNullableMoney(session.estimatedMissPremium)})`,
		].join("  ·  "),
	};
}

function hitRateSeverity(percent: number): { role: MonitorLine["role"]; colorKey: ThemeColor } {
	if (percent >= 80) return { role: "good", colorKey: "success" };
	if (percent >= 50) return { role: "warning", colorKey: "warning" };
	return { role: "bad", colorKey: "error" };
}

function formatSessionLines(session: CacheAggregate): MonitorLine[] {
	const lines: MonitorLine[] = [formatSessionLine(session)];
	if (session.requestCount > 0 && session.promptTokens > 0) {
		lines.push({
			role: "muted",
			text: `Session split  ${compositionSummary(session)}`,
			renderGraphic: (theme, width) => renderCompositionGraphic(session, theme, width),
		});
	}
	return lines;
}

// 8 samples keeps the text trend line within ~80 columns; larger counts wrap.
const SPARKLINE_BLOCKS = "▁▂▃▄▅▆▇█";
const COMPOSITION_BAR_MAX_CELLS = 48;

export function renderSparkline(values: readonly number[], width: number): string {
	const renderWidth = Math.max(0, Math.floor(width));
	if (renderWidth === 0 || values.length === 0) return "";
	const series = values.slice(-renderWidth).filter((value) => Number.isFinite(value));
	if (series.length === 0) return "";
	const min = Math.min(...series);
	const max = Math.max(...series);
	const span = max - min;
	const levels = SPARKLINE_BLOCKS.length;
	return series
		.map((value) => {
			const level = span === 0 ? levels - 1 : Math.floor(((value - min) / span) * (levels - 1));
			return SPARKLINE_BLOCKS.charAt(Math.min(levels - 1, Math.max(0, level)));
		})
		.join("");
}

export interface CompositionSegment {
	label: string;
	value: number;
	colorKey: ThemeColor;
}

export function renderStackedBar(
	segments: readonly CompositionSegment[],
	theme: Theme,
	width: number,
): string {
	const renderWidth = Math.max(0, Math.floor(width));
	if (renderWidth === 0 || segments.length === 0) return "";
	const cells = distributeBarCells(
		segments.map((segment) => Math.max(0, segment.value)),
		renderWidth,
	);
	return segments
		.map((segment, index) => ({ segment, cells: cells[index] ?? 0 }))
		.filter((entry) => entry.cells > 0)
		.map((entry) => theme.fg(entry.segment.colorKey, "█".repeat(entry.cells)))
		.join("");
}

// Largest-remainder distribution: floors first, leftover cells to the biggest
// fractional shares so segment cells sum exactly to the bar width.
function distributeBarCells(values: readonly number[], width: number): number[] {
	const cells = values.map(() => 0);
	const total = values.reduce((sum, value) => sum + value, 0);
	if (total <= 0 || width <= 0) return cells;
	const fractional: { index: number; fraction: number }[] = [];
	let assigned = 0;
	values.forEach((value, index) => {
		const exact = (value / total) * width;
		const floored = Math.floor(exact);
		cells[index] = floored;
		assigned += floored;
		fractional.push({ index, fraction: exact - floored });
	});
	fractional.sort((left, right) => right.fraction - left.fraction);
	let remaining = width - assigned;
	for (const entry of fractional) {
		if (remaining <= 0) break;
		cells[entry.index] += 1;
		remaining -= 1;
	}
	const assignedTotal = cells.reduce((sum, cell) => sum + cell, 0);
	if (assignedTotal !== width) {
		const widest = cells.reduce((best, cell, index) => (cell > cells[best] ? index : best), 0);
		cells[widest] += width - assignedTotal;
	}
	return cells;
}

function compositionSegments(
	record: Pick<CacheUsageRecord, "input" | "cacheRead" | "cacheWrite">,
): CompositionSegment[] {
	return [
		{ label: "read", value: record.cacheRead, colorKey: "success" },
		{ label: "write", value: record.cacheWrite, colorKey: "warning" },
		{ label: "uncached", value: record.input, colorKey: "error" },
	];
}

function compositionSummary(
	record: Pick<CacheUsageRecord, "input" | "cacheRead" | "cacheWrite" | "promptTokens">,
): string {
	if (record.promptTokens <= 0) return "";
	return compositionSegments(record)
		.map((segment) => `${segment.label} ${formatPercent((segment.value / record.promptTokens) * 100)}`)
		.join(" · ");
}

export function renderCompositionGraphic(
	record: Pick<CacheUsageRecord, "input" | "cacheRead" | "cacheWrite" | "promptTokens">,
	theme: Theme,
	width: number,
): string {
	if (record.promptTokens <= 0) return "";
	const segments = compositionSegments(record);
	const legend = segments
		.map((segment) => `${segment.label}${theme.fg(segment.colorKey, "█")}`)
		.join(" ");
	const barCells = Math.max(
		0,
		Math.min(COMPOSITION_BAR_MAX_CELLS, width - visibleWidth(legend) - 2),
	);
	const bar = renderStackedBar(segments, theme, barCells);
	return bar ? `${bar}  ${legend}` : legend;
}

export function sanitizeDisplayLabel(value: string): string {
	const stripped = stripTerminalSequences(value)
		.replace(/[^\p{L}\p{N}_.:/@+\- ]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!stripped) return "unknown";
	const characters = [...stripped];
	return characters.length > MAX_LABEL_LENGTH
		? `${characters.slice(0, MAX_LABEL_LENGTH).join("")}…`
		: stripped;
}

interface CacheUsageCalculation {
	record: CacheUsageRecord;
	inputUnitCost: number | null;
	cacheReadUnitCost: number | null;
	paidPromptUnitCost: number | null;
}

interface CacheUsageCalculationOptions {
	costModel?: Model<Api>;
	cacheAccountingKnown?: boolean;
	retainUnknownCacheAccounting?: boolean;
}

function calculateCacheUsage(
	usage: Usage,
	options: CacheUsageCalculationOptions = {},
): CacheUsageCalculation | null {
	const input = finiteNumber(usage.input);
	const cacheRead = finiteNumber(usage.cacheRead);
	const cacheWrite = finiteNumber(usage.cacheWrite);
	const promptTokens = input + cacheRead + cacheWrite;
	const cacheAccountingKnown =
		cacheRead > 0 || cacheWrite > 0 || options.cacheAccountingKnown === true;
	if (
		promptTokens <= 0 ||
		(!cacheAccountingKnown && options.retainUnknownCacheAccounting !== true)
	) {
		return null;
	}

	const fallbackCosts = options.costModel
		? calculateCost(options.costModel, normalizedUsageCopy(usage, input, cacheRead, cacheWrite))
		: undefined;
	const inputCost = componentCost(input, finiteNumber(usage.cost?.input), fallbackCosts?.input);
	const cacheReadCost = componentCost(
		cacheRead,
		finiteNumber(usage.cost?.cacheRead),
		fallbackCosts?.cacheRead,
	);
	const cacheWriteCost = componentCost(
		cacheWrite,
		finiteNumber(usage.cost?.cacheWrite),
		fallbackCosts?.cacheWrite,
	);
	const inputUnitCost =
		input > 0
			? unitCost(input, inputCost)
			: effectiveInputUnitCost(options.costModel, usage, cacheRead, cacheWrite);
	const cacheReadUnitCost =
		cacheRead > 0
			? unitCost(cacheRead, cacheReadCost)
			: effectiveCacheReadUnitCost(options.costModel, usage, input, cacheWrite);
	const paidPromptUnitCost = unitCost(
		input + cacheWrite,
		sumKnownCosts([inputCost, cacheWriteCost]),
	);

	return {
		record: {
			input,
			cacheRead,
			cacheWrite,
			promptTokens,
			hitRatePercent: cacheAccountingKnown ? (cacheRead / promptTokens) * 100 : null,
			uncachedRatePercent: cacheAccountingKnown ? (input / promptTokens) * 100 : null,
			promptCost: sumKnownCosts([inputCost, cacheReadCost, cacheWriteCost]),
			estimatedSavings: cacheAccountingKnown
				? cacheRead === 0
					? 0
					: inputUnitCost !== null && cacheReadUnitCost !== null
						? cacheRead * Math.max(0, inputUnitCost - cacheReadUnitCost)
						: null
				: null,
		},
		inputUnitCost,
		cacheReadUnitCost,
		paidPromptUnitCost,
	};
}

function effectiveInputUnitCost(
	costModel: Model<Api> | undefined,
	usage: Usage,
	cacheRead: number,
	cacheWrite: number,
): number | null {
	if (!costModel || cacheRead <= 0) return null;
	const probeTokens = Math.min(1, cacheRead);
	const probeUsage = normalizedUsageCopy(usage, probeTokens, cacheRead - probeTokens, cacheWrite);
	return calculateCost(costModel, probeUsage).input / probeTokens;
}

function effectiveCacheReadUnitCost(
	costModel: Model<Api> | undefined,
	usage: Usage,
	input: number,
	cacheWrite: number,
): number | null {
	if (!costModel) return null;
	const probeTokens = Math.min(1, input + cacheWrite);
	if (probeTokens <= 0) return null;
	const probeInput = Math.max(0, input - probeTokens);
	const shiftedFromInput = input - probeInput;
	const probeCacheWrite = Math.max(0, cacheWrite - (probeTokens - shiftedFromInput));
	const probeUsage = normalizedUsageCopy(usage, probeInput, probeTokens, probeCacheWrite);
	return calculateCost(costModel, probeUsage).cacheRead / probeTokens;
}

function normalizedUsageCopy(
	usage: Usage,
	input: number,
	cacheRead: number,
	cacheWrite: number,
): Usage {
	return {
		...usage,
		input,
		output: finiteNumber(usage.output),
		cacheRead,
		cacheWrite,
		cacheWrite1h:
			usage.cacheWrite1h === undefined
				? undefined
				: Math.min(cacheWrite, finiteNumber(usage.cacheWrite1h)),
		totalTokens: finiteNumber(usage.totalTokens),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function findPreviousComparableIndex(
	samples: readonly CacheSample[],
	currentIndex: number,
	epoch: number,
): number {
	for (let index = currentIndex - 1; index >= 0; index -= 1) {
		const candidate = samples[index];
		if (!candidate) continue;
		if (candidate.epoch === epoch) return index;
		if (candidate.epoch < epoch) return -1;
	}
	return -1;
}

function componentCost(tokens: number, reportedCost: number, fallbackCost?: number): number | null {
	if (tokens <= 0) return 0;
	if (reportedCost > 0) return reportedCost;
	return fallbackCost === undefined ? null : fallbackCost;
}

function sumKnownCosts(costs: readonly (number | null)[]): number | null {
	return costs.every((cost) => cost !== null)
		? costs.reduce<number>((total, cost) => total + (cost ?? 0), 0)
		: null;
}

function unitCost(tokens: number, cost: number | null): number | null {
	return tokens > 0 && cost !== null ? cost / tokens : null;
}

function formatPercent(value: number): string {
	return `${value.toFixed(1)}%`;
}

function formatNullablePercent(value: number | null): string {
	return value === null ? "n/a" : formatPercent(value);
}

function formatSignedPercent(value: number): string {
	const sign = value > 0 ? "+" : "";
	return `${sign}${formatPercentagePoints(value)}`;
}

function formatPercentagePoints(value: number): string {
	return `${value.toFixed(1)} pp`;
}

function formatTokens(value: number): string {
	const absolute = Math.abs(value);
	if (absolute < 1_000) return Math.round(value).toLocaleString("en-US");
	if (absolute < 1_000_000) return `${trimFixed(value / 1_000)}k`;
	return `${trimFixed(value / 1_000_000)}m`;
}

function formatSignedTokens(value: number): string {
	return `${value > 0 ? "+" : ""}${formatTokens(value)}`;
}

function trimFixed(value: number): string {
	return value.toFixed(Math.abs(value) >= 100 ? 0 : 1).replace(/\.0$/, "");
}

function formatMoney(value: number): string {
	if (value === 0) return "$0.0000";
	if (value < 0.0001) return "<$0.0001";
	return `$${value.toFixed(value < 0.01 ? 4 : 3)}`;
}

function formatNullableMoney(value: number | null): string {
	return value === null ? "n/a" : formatMoney(value);
}

function formatDuration(milliseconds: number): string {
	if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
	if (milliseconds < 60_000) return `${trimFixed(milliseconds / 1_000)}s`;
	return `${trimFixed(milliseconds / 60_000)}m`;
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export const COMMAND_NAME = "cache-hit-monitor";
export const WIDGET_KEY = "cache-hit-monitor";

export default function cacheHitMonitor(pi: ExtensionAPI): void {
	let activeSession: ExtensionContext["sessionManager"] | undefined;
	let finalizedSamples: CacheSample[] = [];
	let summaryRecords: CacheUsageRecord[] = [];
	const cacheReportingProviders = new Set<string>();
	let currentEpoch = 0;
	let streamingSample: CacheSample | undefined;
	let publishedSignature: string | undefined;
	let visible = false;

	const ownsSession = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession;

	const resolveCostModel = (ctx: ExtensionContext, provider: string, model: string) =>
		ctx.modelRegistry.find(provider, model);

	const restore = (ctx: ExtensionContext): void => {
		const restored = collectCacheSamples(ctx.sessionManager.getBranch(), (provider, model) =>
			resolveCostModel(ctx, provider, model),
		);
		finalizedSamples = restored.samples;
		summaryRecords = restored.summaryRecords;
		cacheReportingProviders.clear();
		for (const sample of finalizedSamples) {
			if (sample.cacheRead > 0 || sample.cacheWrite > 0) {
				cacheReportingProviders.add(sample.provider);
			}
		}
		currentEpoch = restored.currentEpoch;
		streamingSample = undefined;
	};

	const sampleMessage = (message: AssistantMessage, ctx: ExtensionContext): CacheSample | null =>
		createCacheSample(
			message,
			currentEpoch,
			resolveCostModel(ctx, message.provider, message.model),
			cacheReportingProviders.has(message.provider),
		);

	const clearWidget = (ctx: ExtensionContext): void => {
		if (ctx.hasUI && ownsSession(ctx)) ctx.ui.setWidget(WIDGET_KEY, undefined);
		publishedSignature = undefined;
	};

	const publish = (ctx: ExtensionContext): void => {
		if (!visible || !ctx.hasUI || !ownsSession(ctx)) return;
		const view = createCacheMonitorView(finalizedSamples, streamingSample, {
			activeEpoch: currentEpoch,
			summaryRecords,
		});
		const lines = formatMonitorLines(view);
		const signature = JSON.stringify(lines);
		if (signature === publishedSignature) return;
		if (ctx.mode === "tui") {
			ctx.ui.setWidget(
				WIDGET_KEY,
				(_tui, theme) => ({
					render: (width: number) => renderCacheMonitor(view, theme, width),
					invalidate: () => {},
				}),
				{ placement: "aboveEditor" },
			);
		} else {
			ctx.ui.setWidget(
				WIDGET_KEY,
				lines.map(({ text }) => text),
				{ placement: "aboveEditor" },
			);
		}
		publishedSignature = signature;
	};

	pi.registerCommand(COMMAND_NAME, {
		description: "Show or hide live prompt-cache diagnostics",
		handler: async (args, ctx) => {
			if (args.trim()) {
				throw new Error(`Usage: /${COMMAND_NAME}`);
			}
			if (!ctx.hasUI) {
				throw new Error(`/${COMMAND_NAME} requires TUI or RPC mode.`);
			}
			if (!ownsSession(ctx)) {
				throw new Error(`/${COMMAND_NAME} is unavailable for a stale session.`);
			}

			visible = !visible;
			if (visible) publish(ctx);
			else clearWidget(ctx);
			ctx.ui.notify(`Cache hit monitor ${visible ? "shown" : "hidden"}.`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (visible && activeSession !== ctx.sessionManager && ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
		activeSession = ctx.sessionManager;
		visible = false;
		publishedSignature = undefined;
		restore(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		if (!ownsSession(ctx) || event.message.role !== "assistant") return;
		streamingSample = undefined;
		publish(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		if (!ownsSession(ctx) || event.message.role !== "assistant") return;
		const sample = sampleMessage(event.message, ctx);
		if (!sample || (streamingSample && cacheSamplesEqual(streamingSample, sample))) return;
		if (sample.cacheRead > 0 || sample.cacheWrite > 0) {
			cacheReportingProviders.add(sample.provider);
		}
		streamingSample = sample;
		publish(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		if (!ownsSession(ctx) || event.message.role !== "assistant") return;
		const sample = sampleMessage(event.message, ctx);
		streamingSample = undefined;
		if (sample) {
			if (sample.cacheRead > 0 || sample.cacheWrite > 0) {
				cacheReportingProviders.add(sample.provider);
			}
			finalizedSamples.push(sample);
		}
		publish(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ownsSession(ctx) || !streamingSample) return;
		streamingSample = undefined;
		publish(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		restore(ctx);
		publish(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		restore(ctx);
		publish(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		clearWidget(ctx);
		activeSession = undefined;
		finalizedSamples = [];
		summaryRecords = [];
		cacheReportingProviders.clear();
		streamingSample = undefined;
		visible = false;
	});
}

export function renderCacheMonitor(view: CacheMonitorView, theme: Theme, width: number): string[] {
	const renderWidth = Math.max(0, width);
	if (renderWidth === 0) return formatMonitorLines(view).map(() => "");
	const divider = theme.fg("borderMuted", "─".repeat(renderWidth));
	const rendered = formatMonitorLines(view).flatMap((line) => {
		const styled = line.renderGraphic?.(theme, renderWidth) ?? styleLine(line, theme);
		return wrapTextWithAnsi(styled, renderWidth);
	});
	return [divider, ...rendered].map((line) =>
		visibleWidth(line) <= renderWidth ? line : truncateToWidth(line, renderWidth, ""),
	);
}

function styleLine(line: MonitorLine, theme: Theme): string {
	switch (line.role) {
		case "title":
			return theme.fg("accent", theme.bold(line.text));
		case "good":
			return theme.fg("success", line.text);
		case "warning":
			return theme.fg("warning", line.text);
		case "bad":
			return theme.fg("error", line.text);
		case "muted":
			return theme.fg("muted", line.text);
		case "dim":
			return theme.fg("dim", line.text);
	}
}
