/**
 * JSONL reader dispatcher — picks the right summarizer based on the
 * first event in a JSONL file.
 *
 * Soul Hub run JSONL: first event has type === 'run_start' with a
 * `surface` field (pipeline / playbook / chain / subagent).
 *
 * Claude Code session JSONL: first event has no `surface` and uses
 * Claude's nested `message.content[]` shape.
 */

import { createReadStream, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { parseEventLine } from './events.js';
import {
	loadSoulHubEvents,
	summarizeSoulHubRun,
	type RunSummary,
} from './summarize-soul-hub.js';

export type RunFlavor = 'soul-hub' | 'claude' | 'unknown';

const RUNS_DIR = join(homedir(), '.soul-hub', 'runs');

export function resolveRunJsonl(runId: string, parentRunId?: string): string {
	if (parentRunId) {
		return join(RUNS_DIR, parentRunId, 'subruns', `run-${runId}.jsonl`);
	}
	return join(RUNS_DIR, `${runId}.jsonl`);
}

/** Peek up to 10 lines and decide which reader to use. */
export async function detectFlavor(jsonlPath: string): Promise<RunFlavor> {
	if (!existsSync(jsonlPath)) return 'unknown';
	const rl = createInterface({ input: createReadStream(jsonlPath, 'utf8'), crlfDelay: Infinity });
	let count = 0;
	try {
		for await (const line of rl) {
			if (!line.trim()) continue;
			count += 1;
			if (count > 10) break;
			const ev = parseEventLine(line);
			if (ev) {
				// SoulHubEvent envelope (version: 1, runId, eventId, type) parsed cleanly
				return 'soul-hub';
			}
			// First non-empty line failed envelope check — fall through to claude
			try {
				const raw = JSON.parse(line) as Record<string, unknown>;
				if ('parentUuid' in raw || 'isSidechain' in raw || 'sessionId' in raw) {
					return 'claude';
				}
			} catch {
				/* malformed — keep looking */
			}
		}
	} finally {
		rl.close();
	}
	return 'unknown';
}

/** Convenience helper for /api/runs/[runId] endpoints. */
export async function loadRunSummary(runId: string, parentRunId?: string): Promise<{
	flavor: RunFlavor;
	jsonlPath: string;
	summary: RunSummary | null;
}> {
	const jsonlPath = resolveRunJsonl(runId, parentRunId);
	const flavor = await detectFlavor(jsonlPath);
	if (flavor === 'soul-hub') {
		const events = await loadSoulHubEvents(jsonlPath);
		return { flavor, jsonlPath, summary: summarizeSoulHubRun(events) };
	}
	return { flavor, jsonlPath, summary: null };
}

/** List all top-level Soul Hub run JSONLs (no sub-runs). */
export async function listRuns(): Promise<Array<{ runId: string; jsonlPath: string; mtimeMs: number }>> {
	const { readdirSync, statSync } = await import('node:fs');
	if (!existsSync(RUNS_DIR)) return [];
	const out: Array<{ runId: string; jsonlPath: string; mtimeMs: number }> = [];
	for (const entry of readdirSync(RUNS_DIR, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
		const jsonlPath = join(RUNS_DIR, entry.name);
		const stat = statSync(jsonlPath);
		out.push({ runId: entry.name.replace(/\.jsonl$/, ''), jsonlPath, mtimeMs: stat.mtimeMs });
	}
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out;
}
