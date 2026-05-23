/**
 * Summarize a Soul Hub run from its JSONL event log.
 * Sibling to summarize.ts (which targets Claude Code's nested format).
 *
 * Single pass over events; tolerates unknown event types.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { parseEventLine, type RunSurface, type SoulHubEvent } from './events.js';

export interface StepRollup {
	stepId: string;
	stepType?: string;
	parentStepId?: string;
	startedAt?: string;
	endedAt?: string;
	durationMs?: number;
	status?: 'ok' | 'error' | 'skipped' | 'running';
	error?: string;
	outputPath?: string;
	agentSpawns: Array<{
		provider: string;
		model?: string;
		ptySessionId?: string;
		claudeSessionId?: string;
		childRunId?: string;
	}>;
	toolCallCount: number;
}

export interface RunSummary {
	runId: string;
	parentRunId?: string;
	surface?: RunSurface;
	name?: string;
	cwd?: string;
	gitBranch?: string;
	startedAt?: string;
	endedAt?: string;
	durationMs?: number;
	status?: 'ok' | 'error' | 'killed' | 'running';
	eventCount: number;
	steps: StepRollup[];
	toolCallCount: number;
	toolBreakdown: Record<string, number>;
	filesTouched: string[];
	outputs: Array<{
		stepId: string;
		surface: 'vault' | 'project' | 'media' | 'patch';
		path: string;
		bytes: number;
	}>;
	subRunIds: string[];
	cost: {
		totalUsd: number | null;
		byModel: Record<string, number | null>;
		tokens: {
			input: number;
			output: number;
			cacheRead: number;
			cacheCreate5m: number;
			cacheCreate1h: number;
		};
	};
	errors: Array<{ stepId?: string; kind: string; message: string }>;
	firstPrompt?: string;
}

export async function* streamSoulHubEvents(jsonlPath: string): AsyncGenerator<SoulHubEvent> {
	const rl = createInterface({ input: createReadStream(jsonlPath, 'utf8'), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.trim()) continue;
		const ev = parseEventLine(line);
		if (ev) yield ev;
	}
}

export async function loadSoulHubEvents(jsonlPath: string): Promise<SoulHubEvent[]> {
	const out: SoulHubEvent[] = [];
	for await (const ev of streamSoulHubEvents(jsonlPath)) out.push(ev);
	return out;
}

export function summarizeSoulHubRun(events: SoulHubEvent[]): RunSummary {
	const summary: RunSummary = {
		runId: events[0]?.runId ?? '',
		eventCount: events.length,
		steps: [],
		toolCallCount: 0,
		toolBreakdown: {},
		filesTouched: [],
		outputs: [],
		subRunIds: [],
		cost: {
			totalUsd: null,
			byModel: {},
			tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 },
		},
		errors: [],
	};

	const stepIndex = new Map<string, StepRollup>();
	const filesTouchedSet = new Set<string>();
	let unknownPricing = true; // flips false only when we see a `cost.usd`
	let costAccum = 0;
	let firstPromptCaptured = false;

	const ensureStep = (stepId: string): StepRollup => {
		let step = stepIndex.get(stepId);
		if (!step) {
			step = { stepId, agentSpawns: [], toolCallCount: 0 };
			stepIndex.set(stepId, step);
			summary.steps.push(step);
		}
		return step;
	};

	for (const e of events) {
		switch (e.type) {
			case 'run_start': {
				summary.surface = e.surface;
				summary.name = e.name;
				summary.cwd = e.cwd;
				summary.gitBranch = e.gitBranch;
				summary.startedAt = e.timestamp;
				summary.parentRunId = e.parentRunId;
				summary.status = 'running';
				if (!firstPromptCaptured && e.inputs && typeof e.inputs.prompt === 'string') {
					summary.firstPrompt = e.inputs.prompt as string;
					firstPromptCaptured = true;
				}
				break;
			}
			case 'step_start': {
				const step = ensureStep(e.stepId);
				step.stepType = e.stepType;
				step.parentStepId = e.parentStepId;
				step.startedAt = e.timestamp;
				step.status = 'running';
				break;
			}
			case 'step_end': {
				const step = ensureStep(e.stepId);
				step.endedAt = e.timestamp;
				step.durationMs = e.durationMs;
				step.status = e.status;
				step.error = e.error;
				step.outputPath = e.outputPath;
				break;
			}
			case 'agent_spawn': {
				const step = ensureStep(e.stepId);
				step.agentSpawns.push({
					provider: e.provider,
					model: e.model,
					ptySessionId: e.ptySessionId,
					claudeSessionId: e.claudeSessionId,
					childRunId: e.childRunId,
				});
				if (e.childRunId) summary.subRunIds.push(e.childRunId);
				break;
			}
			case 'tool_use': {
				summary.toolCallCount += 1;
				summary.toolBreakdown[e.tool] = (summary.toolBreakdown[e.tool] ?? 0) + 1;
				if (e.stepId) ensureStep(e.stepId).toolCallCount += 1;
				break;
			}
			case 'output_landed': {
				summary.outputs.push({
					stepId: e.stepId,
					surface: e.surface,
					path: e.path,
					bytes: e.bytes,
				});
				filesTouchedSet.add(e.path);
				break;
			}
			case 'cost': {
				summary.cost.tokens.input += e.inputTokens;
				summary.cost.tokens.output += e.outputTokens;
				summary.cost.tokens.cacheRead += e.cacheReadTokens ?? 0;
				summary.cost.tokens.cacheCreate5m += e.cacheCreate5mTokens ?? 0;
				summary.cost.tokens.cacheCreate1h += e.cacheCreate1hTokens ?? 0;
				if (typeof e.usd === 'number') {
					unknownPricing = false;
					costAccum += e.usd;
					const prev = summary.cost.byModel[e.model] ?? 0;
					summary.cost.byModel[e.model] = (prev ?? 0) + e.usd;
				} else if (!(e.model in summary.cost.byModel)) {
					summary.cost.byModel[e.model] = null;
				}
				break;
			}
			case 'error': {
				summary.errors.push({ stepId: e.stepId, kind: e.kind, message: e.message });
				if (e.stepId) {
					const step = ensureStep(e.stepId);
					step.error = step.error ?? e.message;
				}
				break;
			}
			case 'run_end': {
				summary.endedAt = e.timestamp;
				summary.durationMs = e.durationMs;
				summary.status = e.status;
				break;
			}
			// tool_result is currently informational; the summarize pass doesn't need it
			default:
				break;
		}
	}

	summary.filesTouched = Array.from(filesTouchedSet).sort();
	summary.cost.totalUsd = unknownPricing ? null : costAccum;

	// Fall back to first/last event timestamps if run_start/run_end weren't seen.
	if (!summary.startedAt && events.length > 0) summary.startedAt = events[0].timestamp;
	if (!summary.endedAt && events.length > 0) summary.endedAt = events[events.length - 1].timestamp;
	if (!summary.durationMs && summary.startedAt && summary.endedAt) {
		summary.durationMs = new Date(summary.endedAt).getTime() - new Date(summary.startedAt).getTime();
	}

	return summary;
}
