/**
 * Reduce a parsed Claude session into a UI-friendly summary.
 * Single pass over events; stays synchronous-fast.
 */

import type { ClaudeSession, ClaudeEvent, SessionSummary, SubagentRollup, FileSnapshot } from './types.js';
import { priceUsage } from './pricing.js';

const FILE_WRITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

function extractTextFromMessage(e: ClaudeEvent): string | undefined {
	const c = e.message?.content;
	if (typeof c === 'string') return c;
	if (Array.isArray(c)) {
		for (const block of c) {
			if (block?.type === 'text' && typeof block.text === 'string') return block.text;
		}
	}
	return undefined;
}

export function summarizeSession(s: ClaudeSession): SessionSummary {
	const summary: SessionSummary = {
		sessionId: s.sessionId,
		cwd: s.cwd,
		gitBranch: s.gitBranch,
		model: s.model,
		firstTimestamp: s.firstTimestamp,
		lastTimestamp: s.lastTimestamp,
		eventCount: s.events.length,
		cost: { totalUsd: 0, byModel: {}, tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 } },
		toolCallCount: 0,
		toolBreakdown: {},
		filesTouched: [],
		fileSnapshots: [],
		subagents: [],
		errorCount: 0,
	};

	if (s.firstTimestamp && s.lastTimestamp) {
		summary.durationMs = new Date(s.lastTimestamp).getTime() - new Date(s.firstTimestamp).getTime();
	}

	const filesTouchedSet = new Set<string>();
	let unknownPricing = false;
	let firstPromptCaptured = false;

	for (const e of s.events) {
		// User prompts (first + last)
		if (e.type === 'user' && !e.toolUseResult) {
			const text = extractTextFromMessage(e);
			if (text) {
				if (!firstPromptCaptured) {
					summary.firstPrompt = text.slice(0, 500);
					firstPromptCaptured = true;
				}
				summary.lastPrompt = text.slice(0, 500);
			}
		}

		if (e.type === 'assistant') {
			const usage = e.message?.usage;
			const model = e.message?.model;
			if (usage) {
				summary.cost.tokens.input += usage.input_tokens ?? 0;
				summary.cost.tokens.output += usage.output_tokens ?? 0;
				summary.cost.tokens.cacheCreate += usage.cache_creation_input_tokens ?? 0;
				summary.cost.tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
				const usd = priceUsage(model, usage);
				if (usd === null) {
					unknownPricing = true;
				} else {
					summary.cost.totalUsd = (summary.cost.totalUsd ?? 0) + usd;
					if (model) {
						summary.cost.byModel[model] = (summary.cost.byModel[model] ?? 0) + usd;
					}
				}
			}
			// Tool uses + file-writing tools
			const content = e.message?.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block?.type === 'tool_use' && typeof block.name === 'string') {
						summary.toolCallCount++;
						summary.toolBreakdown[block.name] = (summary.toolBreakdown[block.name] ?? 0) + 1;
						if (FILE_WRITING_TOOLS.has(block.name)) {
							const path = (block.input as Record<string, unknown> | undefined)?.['file_path'];
							if (typeof path === 'string') filesTouchedSet.add(path);
						}
					}
				}
			}
			if (e.isApiErrorMessage || e.error) summary.errorCount++;
		}

		if (e.type === 'user' && e.toolUseResult) {
			const tur = e.toolUseResult;
			// Sub-agent invocation summary lives on the parent's tool_result event
			if (tur.agentId) {
				let descPrompt: string | undefined;
				if (typeof tur.prompt === 'string') descPrompt = tur.prompt.slice(0, 200);
				const cost = priceUsage(s.model ?? summary.model, tur.usage);
				summary.subagents.push({
					agentId: tur.agentId,
					agentType: tur.agentType ?? 'unknown',
					status: tur.status ?? 'unknown',
					descriptionPrompt: descPrompt,
					totalDurationMs: tur.totalDurationMs,
					totalTokens: tur.totalTokens,
					totalToolUseCount: tur.totalToolUseCount,
					usage: tur.usage,
					toolStats: tur.toolStats,
					cost,
				});
			}
			if (tur.status === 'error') summary.errorCount++;
		}

		if (e.type === 'file-history-snapshot') {
			const snap = e.snapshot;
			const tracked = snap?.trackedFileBackups;
			const paths: string[] = tracked && typeof tracked === 'object' ? Object.keys(tracked) : [];
			summary.fileSnapshots.push({
				messageId: e.messageId ?? '',
				timestamp: snap?.timestamp,
				paths,
			});
			for (const p of paths) filesTouchedSet.add(p);
		}
	}

	if (unknownPricing && summary.cost.totalUsd === 0) summary.cost.totalUsd = null;
	summary.filesTouched = [...filesTouchedSet].sort();
	return summary;
}

/**
 * Convenience: parse + summarize in one call. Used by the API list endpoint.
 */
export async function summarizeFromPath(jsonlPath: string): Promise<SessionSummary> {
	const { parseSession } = await import('./parser.js');
	const session = await parseSession(jsonlPath);
	return summarizeSession(session);
}
