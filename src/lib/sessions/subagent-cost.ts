/**
 * ADR-005 gap #1 closure — sub-agent (sidechain) cost rollup.
 *
 * When an orchestrator agent (ADR-005 `allow_subagents`) fans out via the Task
 * tool, each sub-agent's work lands in a SEPARATE transcript:
 *
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl
 *
 * The parent's `<sessionId>.jsonl` contains NO `isSidechain` assistant events
 * for that work (verified 2026-05-25 against a live maestro fan-out) — only a
 * `tool_result` whose `toolUseResult.usage` echoes the sub-agent's token counts
 * but carries NO model field. So `summarizeSession`, which prices only
 * parent-thread assistant `usage`, undercounts a fan-out; and the existing
 * `summary.subagents[].cost` (priced with the PARENT's model) overcounts when a
 * sub-agent ran on a cheaper model — e.g. sonnet parent, haiku sub-agents, ~3×
 * the real cache-creation rate.
 *
 * This helper reads the sub-agent transcripts directly and prices each with its
 * OWN model — the authoritative source for both usage and model. It is the
 * honest total ADR-006's dynamic budget enforces against.
 *
 * Pure read; tolerant of a missing subagents dir (returns a zero rollup).
 */

import { readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

import { streamEvents } from './parser.js';
import { priceUsage } from './pricing.js';
import type { ClaudeEvent, CostBreakdown } from './types.js';

export interface SubagentCostEntry {
	agentId: string;
	model?: string;
	/** Priced cost for this sub-agent, or null if its model pricing is unknown. */
	costUsd: number | null;
	/** Distinct assistant API turns in the sub-agent transcript. */
	turns: number;
}

export interface SubagentCostRollup {
	/** Summed sub-agent cost. `null` if ANY sub-agent had unknown pricing
	 *  (mirrors `summarize.ts`/`run-tail.ts` — a null total beats a wrong one). */
	totalUsd: number | null;
	/** Summed distinct assistant turns across all sub-agents. */
	turns: number;
	/** Number of sub-agent transcript files found. */
	fileCount: number;
	/** Per-sub-agent breakdown, keyed by agentId. */
	byAgent: SubagentCostEntry[];
}

/** An empty rollup — no sub-agents (the common, non-orchestrator case). */
function emptyRollup(): SubagentCostRollup {
	return { totalUsd: 0, turns: 0, fileCount: 0, byAgent: [] };
}

/** Resolve the `subagents/` directory for a parent session transcript path. */
export function subagentsDir(parentJsonlPath: string): string {
	const dir = dirname(parentJsonlPath);
	const sessionId = basename(parentJsonlPath, '.jsonl');
	return join(dir, sessionId, 'subagents');
}

/**
 * Roll up the cost + turns of every `agent-*.jsonl` sub-agent transcript under a
 * parent session. Prices each sub-agent with its own model. Returns a zero
 * rollup if the parent had no sub-agents (no subagents dir).
 */
export async function rollupSubagentCost(parentJsonlPath: string): Promise<SubagentCostRollup> {
	const saDir = subagentsDir(parentJsonlPath);

	let files: string[];
	try {
		files = readdirSync(saDir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'));
	} catch {
		return emptyRollup(); // no subagents dir — not a fan-out run
	}
	if (files.length === 0) return emptyRollup();

	const byAgent: SubagentCostEntry[] = [];
	let total = 0;
	let anyUnknown = false;
	let turnsTotal = 0;

	for (const file of files) {
		const agentId = basename(file, '.jsonl').replace(/^agent-/, '');
		const path = join(saDir, file);
		const requestIds = new Set<string>();
		let model: string | undefined;
		let cost = 0;
		let unknown = false;

		try {
			for await (const e of streamEvents(path)) {
				if ((e as ClaudeEvent).type !== 'assistant') continue;
				const msg = e.message;
				if (e.requestId) requestIds.add(e.requestId);
				if (!model && msg?.model) model = msg.model;
				if (msg?.usage) {
					const usd = priceUsage(msg.model, msg.usage);
					if (usd === null) unknown = true;
					else cost += usd;
				}
			}
		} catch {
			// Unreadable sub-agent transcript — count it as unknown pricing rather
			// than silently dropping its (real) spend from the honest total.
			unknown = true;
		}

		if (unknown) anyUnknown = true;
		else total += cost;
		turnsTotal += requestIds.size;
		byAgent.push({ agentId, model, costUsd: unknown ? null : cost, turns: requestIds.size });
	}

	return {
		totalUsd: anyUnknown ? null : total,
		turns: turnsTotal,
		fileCount: files.length,
		byAgent,
	};
}

/**
 * Fold a sub-agent rollup into a parent `CostBreakdown` in place: records the
 * fan-out portion in `subagentUsd` and makes `totalUsd` the grand total
 * (parent + sub-agents). Null-safe — if either part is unknown the grand total
 * is `null` (an honest "—" beats a wrong dollar value; `max_turns` still bounds
 * the run, per ADR-004 D4). A zero rollup is a no-op beyond setting `subagentUsd`.
 */
export function foldSubagentCost(cost: CostBreakdown, rollup: SubagentCostRollup): void {
	cost.subagentUsd = rollup.totalUsd;
	if (cost.totalUsd === null || rollup.totalUsd === null) {
		cost.totalUsd = null;
	} else {
		cost.totalUsd = cost.totalUsd + rollup.totalUsd;
	}
}

/** Convenience: roll up a parent transcript's sub-agents and fold the result
 *  into its summary cost in one call. Returns the rollup for callers that want
 *  the breakdown. */
export async function applySubagentRollup(
	cost: CostBreakdown,
	parentJsonlPath: string,
): Promise<SubagentCostRollup> {
	const rollup = await rollupSubagentCost(parentJsonlPath);
	foldSubagentCost(cost, rollup);
	return rollup;
}
