/** soul run — read verbs over `agent_runs`.
 *
 *  Eliminates the recurring `sqlite3 ~/.soul-hub/data/ops/ops.db` escape
 *  hatch surfaced by the 2026-05-28→29 dispatch-architecture session.
 *  Read-only; same chokepoint discipline as the other `soul` reads (ADR-046):
 *  the CLI is a thin pipe to `GET /api/agents/runs`. */

import { apiGet } from '../api.ts';
import { emit, fail, type OutputOpts } from '../output.ts';

interface RunRow {
	runId: string;
	agentId: string;
	status: string;
	mode: string;
	costUsd: number;
	numTurns: number;
	startedAt: number;
	finishedAt: number | null;
	subjectPath: string | null;
	phase: string | null;
}

interface RunsResp {
	filters: Record<string, unknown>;
	runs: RunRow[];
	count: number;
}

function fmtTime(epochMs: number | null | undefined): string {
	if (!epochMs) return '—';
	const d = new Date(epochMs);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	const hh = String(d.getHours()).padStart(2, '0');
	const mi = String(d.getMinutes()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/** soul run list [--status X] [--subject-path Y] [--agent-id Z] [--limit N] [--json] */
export async function list(args: Record<string, string | undefined>, opts: OutputOpts) {
	const params: Record<string, string> = {};
	if (args.status) params.status = args.status;
	if (args['subject-path']) params.subjectPath = args['subject-path'];
	if (args['agent-id']) params.agentId = args['agent-id'];
	if (args.limit) {
		const n = Number(args.limit);
		if (!Number.isFinite(n) || n < 1) fail('run list: --limit must be a positive number');
		params.limit = String(n);
	}

	const data = await apiGet<RunsResp>('/api/agents/runs', params);

	emit(data, opts, (d: RunsResp) => {
		if (d.runs.length === 0) {
			const filterSummary = Object.entries(d.filters)
				.filter(([, v]) => v !== undefined && v !== null && v !== '')
				.map(([k, v]) => `${k}=${v}`)
				.join(', ');
			return filterSummary ? `(no runs match: ${filterSummary})` : '(no runs)';
		}
		const lines = d.runs.map((r) => {
			const runId = r.runId.slice(0, 8).padEnd(8);
			const agent = r.agentId.padEnd(22).slice(0, 22);
			const status = r.status.padEnd(26).slice(0, 26);
			const cost = `$${r.costUsd.toFixed(2)}`.padStart(7);
			const turns = `${r.numTurns}t`.padStart(5);
			const phase = (r.phase ?? '').padEnd(8);
			const started = fmtTime(r.startedAt);
			const subj = r.subjectPath
				? r.subjectPath.split('/').slice(-2).join('/')
				: '(no subject)';
			return `${runId}  ${agent}  ${status}  ${cost}  ${turns}  ${phase}  ${started}  ${subj}`;
		});
		const header = `${'run'.padEnd(8)}  ${'agent'.padEnd(22)}  ${'status'.padEnd(26)}  ${'cost'.padStart(7)}  ${'turns'.padStart(5)}  ${'phase'.padEnd(8)}  ${'started'.padEnd(16)}  subject`;
		return [header, '─'.repeat(header.length), ...lines, '', `(${d.count} run${d.count === 1 ? '' : 's'})`].join('\n');
	});
}
