/**
 * Cross-surface joiner for Phase 3 unified session timeline.
 *
 * Inputs:
 *   - PTY sessions       (~/.soul-hub/sessions/{id}.meta.json)
 *   - Soul Hub runs      (~/.soul-hub/runs/{runId}.jsonl)
 *   - Claude Code JSONLs (~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl)
 *
 * Outputs:
 *   - TimelineEntry[] — newest first, deduped by collapsing PTY+run pairs
 *
 * Join keys:
 *   - PTY ↔ Claude:   cwd + time-window  (already exists in link.ts)
 *   - Run ↔ PTY:      agent_spawn.ptySessionId
 *   - Run ↔ Claude:   two-hop via PTY, OR future: claudeSessionId field on agent_spawn
 */

import { listSessions, type SessionMeta } from '../pty/store.js';
import { findClaudeSessionsForPty } from './link.js';
import { listRuns } from './dispatch.js';
import { loadSoulHubEvents, summarizeSoulHubRun, type RunSummary } from './summarize-soul-hub.js';
import type { ClaudeSessionRef } from './types.js';
import { parseSession } from './parser.js';
import { summarizeSession } from './summarize.js';

export type TimelineKind = 'pty' | 'run' | 'pty+run';

export interface TimelineClaudeRollup {
	sessionIds: string[];
	totalCostUsd: number | null;
	totalTokens: number;
	toolCallCount: number;
	model?: string;
}

export interface TimelineEntry {
	id: string;
	kind: TimelineKind;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	cwd: string;
	gitBranch?: string;
	label: string;
	pty?: { id: string; status: string; logSize: number };
	run?: {
		runId: string;
		surface: 'pipeline' | 'playbook' | 'chain' | 'subagent';
		status: string;
		stepCount: number;
	};
	claude?: TimelineClaudeRollup;
	filesTouched: string[];
}

export interface TimelineTotals {
	sessionCount: number;
	costUsd: number | null;
	toolCalls: number;
	filesTouched: number;
}

export interface LoadTimelineOpts {
	project?: string;             // absolute path; entries' cwd must startsWith this
	since?: string;               // ISO; default: 7 days ago
	until?: string;               // ISO; default: now
	limit?: number;               // default: 200
	q?: string;                   // case-insensitive substring match against label/prompt/cwd
	includeClaudeStandalone?: boolean; // include PTY-spawned Claude sessions outside any pipeline (default: true)
}

function isWithinProject(absPath: string | undefined, projectRoot?: string): boolean {
	if (!projectRoot) return true;
	if (!absPath) return false;
	return absPath === projectRoot || absPath.startsWith(projectRoot + '/');
}

function inWindow(ts: string | undefined, start: number, end: number): boolean {
	if (!ts) return false;
	const t = new Date(ts).getTime();
	return t >= start && t <= end;
}

function matchesQuery(entry: TimelineEntry, q?: string): boolean {
	if (!q) return true;
	const needle = q.toLowerCase();
	if (entry.label.toLowerCase().includes(needle)) return true;
	if (entry.cwd.toLowerCase().includes(needle)) return true;
	if (entry.run?.runId.toLowerCase().includes(needle)) return true;
	if (entry.pty?.id.toLowerCase().includes(needle)) return true;
	return false;
}

async function summarizeRun(runId: string): Promise<RunSummary | null> {
	try {
		const { homedir } = await import('node:os');
		const { join } = await import('node:path');
		const events = await loadSoulHubEvents(join(homedir(), '.soul-hub', 'runs', `${runId}.jsonl`));
		if (events.length === 0) return null;
		return summarizeSoulHubRun(events);
	} catch {
		return null;
	}
}

async function rollupClaudeFromRefs(refs: ClaudeSessionRef[]): Promise<TimelineClaudeRollup> {
	const sessionIds: string[] = [];
	let cost = 0;
	let unknownPricing = false;
	let tokens = 0;
	let toolCalls = 0;
	let model: string | undefined;
	for (const ref of refs) {
		try {
			const sess = await parseSession(ref.jsonlPath);
			const summary = summarizeSession(sess);
			sessionIds.push(summary.sessionId);
			if (summary.cost.totalUsd === null) unknownPricing = true;
			else cost += summary.cost.totalUsd;
			tokens +=
				summary.cost.tokens.input +
				summary.cost.tokens.output +
				summary.cost.tokens.cacheCreate +
				summary.cost.tokens.cacheRead;
			toolCalls += summary.toolCallCount;
			if (!model && summary.model) model = summary.model;
		} catch {
			/* skip unreadable */
		}
	}
	return {
		sessionIds,
		totalCostUsd: unknownPricing && cost === 0 ? null : cost,
		totalTokens: tokens,
		toolCallCount: toolCalls,
		model,
	};
}

/**
 * Build a unified per-project timeline by:
 *   1. Listing recent PTY sessions inside the time window
 *   2. Listing recent Soul Hub runs inside the time window
 *   3. Pairing them up via agent_spawn.ptySessionId
 *   4. For unpaired PTYs: attaching Claude sessions via cwd+time-window
 *   5. For unpaired runs: attaching Claude sessions via agent_spawn.ptySessionId → PTY → Claude
 */
export async function loadProjectTimeline(opts: LoadTimelineOpts = {}): Promise<{
	entries: TimelineEntry[];
	totals: TimelineTotals;
}> {
	const limit = Math.min(opts.limit ?? 200, 1000);
	const sinceMs = opts.since ? new Date(opts.since).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;
	const untilMs = opts.until ? new Date(opts.until).getTime() : Date.now();

	// 1) PTY sessions
	const allPtys = listSessions(2000);
	const ptys = allPtys.filter(
		(p) => isWithinProject(p.cwd, opts.project) && inWindow(p.startedAt, sinceMs, untilMs),
	);

	// 2) Soul Hub runs — read each run's run_start to get cwd
	const runRefs = await listRuns();
	const runs: Array<{ runId: string; jsonlPath: string; mtimeMs: number; summary: RunSummary }> = [];
	for (const r of runRefs) {
		// mtime as cheap pre-filter
		if (r.mtimeMs < sinceMs - 60_000 || r.mtimeMs > untilMs + 60_000) continue;
		const summary = await summarizeRun(r.runId);
		if (!summary || !summary.startedAt) continue;
		if (!isWithinProject(summary.cwd, opts.project)) continue;
		if (!inWindow(summary.startedAt, sinceMs, untilMs)) continue;
		runs.push({ ...r, summary });
	}

	// 3) Build pty index for collapse + sub-run map
	const ptyById = new Map(ptys.map((p) => [p.id, p]));
	const consumedPtyIds = new Set<string>();
	const entries: TimelineEntry[] = [];

	// 4) Build skeleton entries (no Claude rollup yet — that's the slow part).
	//    For each run, find its linked PTY via agent_spawn.ptySessionId so we
	//    can collapse pty+run pairs.
	type Skeleton = { entry: TimelineEntry; linkedPty?: SessionMeta };
	const skeletons: Skeleton[] = [];

	for (const r of runs) {
		const summary = r.summary;
		const events = await loadSoulHubEvents(r.jsonlPath);
		const spawn = events.find((e) => e.type === 'agent_spawn' && (e as { ptySessionId?: string }).ptySessionId);
		const linkedPtyId = spawn ? (spawn as { ptySessionId?: string }).ptySessionId : undefined;
		const linkedPty = linkedPtyId ? ptyById.get(linkedPtyId) : undefined;
		if (linkedPty) consumedPtyIds.add(linkedPty.id);

		skeletons.push({
			entry: {
				id: r.runId,
				kind: linkedPty ? 'pty+run' : 'run',
				startedAt: summary.startedAt!,
				endedAt: summary.endedAt,
				durationMs: summary.durationMs,
				cwd: summary.cwd ?? '',
				gitBranch: summary.gitBranch,
				label: summary.name ?? r.runId,
				run: {
					runId: r.runId,
					surface: summary.surface ?? 'pipeline',
					status: summary.status ?? 'running',
					stepCount: summary.steps.length,
				},
				pty: linkedPty
					? { id: linkedPty.id, status: linkedPty.status, logSize: linkedPty.logSize ?? 0 }
					: undefined,
				filesTouched: summary.filesTouched,
			},
			linkedPty,
		});
	}

	if (opts.includeClaudeStandalone !== false) {
		for (const pty of ptys) {
			if (consumedPtyIds.has(pty.id)) continue;
			const startedAt = pty.startedAt;
			const endedAt = pty.endedAt;
			const durationMs =
				startedAt && endedAt
					? new Date(endedAt).getTime() - new Date(startedAt).getTime()
					: undefined;
			skeletons.push({
				entry: {
					id: pty.id,
					kind: 'pty',
					startedAt,
					endedAt,
					durationMs,
					cwd: pty.cwd,
					label: pty.prompt?.trim() ? pty.prompt.slice(0, 100) : '(shell)',
					pty: { id: pty.id, status: pty.status, logSize: pty.logSize ?? 0 },
					filesTouched: [],
				},
				linkedPty: pty,
			});
		}
	}

	// 5) Sort newest first, apply ?q filter, slice — BEFORE the expensive Claude rollup
	skeletons.sort((a, b) => (b.entry.startedAt ?? '').localeCompare(a.entry.startedAt ?? ''));
	const filteredSkeletons = skeletons.filter((s) => matchesQuery(s.entry, opts.q)).slice(0, limit);

	// 6) NOW attach Claude rollups — only for entries we'll actually return
	for (const s of filteredSkeletons) {
		if (s.linkedPty) {
			const refs = await findClaudeSessionsForPty(s.linkedPty).catch(() => []);
			if (refs.length > 0) s.entry.claude = await rollupClaudeFromRefs(refs);
		}
		entries.push(s.entry);
	}
	const filtered = entries;

	// 7) Totals
	let totalCost = 0;
	let unknownCost = false;
	let totalToolCalls = 0;
	const filesSet = new Set<string>();
	for (const e of filtered) {
		if (e.claude) {
			if (e.claude.totalCostUsd === null) unknownCost = true;
			else totalCost += e.claude.totalCostUsd;
			totalToolCalls += e.claude.toolCallCount;
		}
		for (const f of e.filesTouched) filesSet.add(f);
	}
	return {
		entries: filtered,
		totals: {
			sessionCount: filtered.length,
			costUsd: unknownCost && totalCost === 0 ? null : totalCost,
			toolCalls: totalToolCalls,
			filesTouched: filesSet.size,
		},
	};
}
