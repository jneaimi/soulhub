/** POST /api/hygiene/agent-fix — dispatch the hygiene-fixer agent for a row.
 *
 *  ADR-007 P1: the "🤖 Agent fix" action in the hygiene dashboard. Fires the
 *  dedicated, read-only `hygiene-fixer` agent against one anomaly row and stores
 *  the resulting HygieneProposal in the proposal-store for the client to poll.
 *
 *  Flow:
 *    1. Client POSTs { rowKey, bucket, context } — identifies the row.
 *    2. This handler marks the row `dispatching` and returns { ok, runId }
 *       immediately (fire-and-forget dispatch in the background).
 *    3. The background task:
 *       a. Calls `dispatchAgent('hygiene-fixer', taskPrompt, { pausableOnCeiling: true })`
 *       b. Captures the final DispatchResult.output
 *       c. Parses it as a HygieneProposal JSON
 *       d. Calls `setReady(rowKey, proposal)` or `setError(rowKey, err)`
 *    4. Client polls GET /api/hygiene/agent-fix/status?rowKey=... for the result.
 *
 *  Dispatch notes:
 *   - Uses PTY backend (hardened, honest completion — ADR-007 revision 2026-05-26 #1).
 *   - `pausableOnCeiling: true` — background dispatches pause instead of aborting
 *     (#2 of the same revision); the budget surface shows the pause.
 *   - The fixer has `tools: Read, Glob, Grep, WebSearch` only — structurally
 *     incapable of writing. ADR-046 Pass 1+2+3 backstops at the vault layer.
 *
 *  P1 scope: `unresolved` (broken-link) + `orphan_note` buckets only. Other
 *  buckets return 400 `bucket-not-supported` until P2 lands the remaining
 *  executors.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { dispatchAgent } from '$lib/agents/dispatch/index.js';
import {
	setDispatching,
	updateRunId,
	setReady,
	setError,
} from '$lib/vault-hygiene/proposal-store.js';
import type { HygieneProposal } from '$lib/vault-hygiene/agent-types.js';

/** P1 supported buckets. Extend as P2 executors land. */
const SUPPORTED_BUCKETS = ['unresolved', 'orphan_note'] as const;
type SupportedBucket = (typeof SUPPORTED_BUCKETS)[number];

const AGENT_ID = 'hygiene-fixer';

function rejectCrossSite(request: Request): Response | null {
	if (request.headers.get('sec-fetch-site') === 'cross-site') {
		return json({ ok: false, error: 'cross-site requests rejected' }, { status: 403 });
	}
	return null;
}

/** Build the task prompt injected into the fixer's context. */
function buildTaskPrompt(bucket: SupportedBucket, context: unknown): string {
	return [
		`Bucket: ${bucket}`,
		`Context:`,
		JSON.stringify(context, null, 2),
		``,
		`Vault path: ~/vault/`,
		``,
		`Analyze the anomaly and output ONLY a valid HygieneProposal JSON (no markdown fencing, no prose before/after).`,
	].join('\n');
}

/** Extract a JSON object from the agent's output. The fixer is instructed to
 *  emit only JSON, but may occasionally emit leading whitespace or a BOM.
 *  This parser finds the first `{` and last `}` as a fallback. */
function extractProposalJson(output: string): HygieneProposal | null {
	const trimmed = output.trim();
	// Fast path: the entire output is valid JSON.
	try {
		return JSON.parse(trimmed) as HygieneProposal;
	} catch {
		/* fall through */
	}
	// Fallback: find the outermost JSON object.
	const start = trimmed.indexOf('{');
	const end = trimmed.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) return null;
	try {
		return JSON.parse(trimmed.slice(start, end + 1)) as HygieneProposal;
	} catch {
		return null;
	}
}

/** Shallow-validate the parsed proposal has required fields. */
function isValidProposal(p: unknown): p is HygieneProposal {
	if (typeof p !== 'object' || p === null) return false;
	const r = p as Record<string, unknown>;
	return (
		typeof r.bucket === 'string' &&
		typeof r.target === 'string' &&
		typeof r.summary === 'string' &&
		(r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low') &&
		Array.isArray(r.edits) &&
		Array.isArray(r.alternatives)
	);
}

/** Fire the agent dispatch and store the result. Runs entirely in the
 *  background — intentionally not awaited by the request handler. */
async function runAgentBackground(rowKey: string, bucket: SupportedBucket, context: unknown): Promise<void> {
	const taskPrompt = buildTaskPrompt(bucket, context);
	let runId = 'pending';

	try {
		const gen = dispatchAgent(AGENT_ID, taskPrompt, {
			mode: 'production',
			// Background dispatches pause at the budget ceiling rather than aborting
			// (ADR-007 revision 2026-05-26 #2 + soul-hub-agents ADR-006).
			pausableOnCeiling: true,
		});

		let result;
		for (;;) {
			const next = await gen.next();
			if (next.done) {
				result = next.value;
				break;
			}
			// Capture the run ID as soon as the 'started' event fires.
			if (next.value.type === 'started') {
				runId = next.value.runId;
				updateRunId(rowKey, runId);
			}
		}

		if (result.status !== 'success' && result.status !== 'goal_achieved') {
			setError(
				rowKey,
				`Dispatch ended with status ${result.status}${result.error ? `: ${result.error}` : ''}`,
				result.output,
			);
			return;
		}

		const proposal = extractProposalJson(result.output ?? '');
		if (!proposal || !isValidProposal(proposal)) {
			setError(
				rowKey,
				'Agent output was not a valid HygieneProposal JSON',
				result.output,
			);
			return;
		}

		setReady(rowKey, proposal, result.output);
	} catch (err) {
		setError(rowKey, (err as Error).message ?? 'dispatch threw unexpectedly');
	}
}

export const POST: RequestHandler = async ({ request }) => {
	const guard = rejectCrossSite(request);
	if (guard) return guard;

	let body: { rowKey?: unknown; bucket?: unknown; context?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
	}

	const { rowKey, bucket, context } = body;

	if (!rowKey || typeof rowKey !== 'string') {
		return json({ ok: false, error: 'rowKey is required (string)' }, { status: 400 });
	}
	if (!bucket || !(SUPPORTED_BUCKETS as readonly string[]).includes(bucket as string)) {
		return json(
			{
				ok: false,
				error: `bucket must be one of: ${SUPPORTED_BUCKETS.join(', ')} (P1 scope — other buckets land in ADR-007 P2)`,
			},
			{ status: 400 },
		);
	}
	if (!context || typeof context !== 'object') {
		return json({ ok: false, error: 'context is required (object)' }, { status: 400 });
	}

	// Mark the row as dispatching and fire the background job.
	setDispatching(rowKey);
	void runAgentBackground(rowKey, bucket as SupportedBucket, context);

	return json({ ok: true, rowKey });
};
