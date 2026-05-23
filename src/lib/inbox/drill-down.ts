/** Layer 3 — `inbox-drill-down` composite read.
 *
 *  Closes the digest/anomaly-push loop: when the operator replies
 *  "tell me about msg 33602", the orchestrator calls this and gets a
 *  single text blob with everything cheap-to-fetch about the row:
 *    1. Envelope (subject / from / when / category)
 *    2. Cached `extracted_data` if present
 *    3. agent_actions history (anomaly-pushed? extract attempts?)
 *    4. 200-char body_preview snippet
 *
 *  Does NOT fetch the full body — that's `inbox-read-body`'s job. The
 *  preview-only stance keeps drill-down fast and matches ADR §Privacy.
 *  Server-formatted, no LLM, idempotent. */

import {
	getMessage,
	getExtractedData,
	listAgentActions,
	type AgentActionRow,
	type InboxMessage,
	type TransactionalExtract,
} from './index.js';

const ACTION_HISTORY_LIMIT = 8;

/** Returns a server-formatted text blob, or null if the message id is
 *  unknown. Callers (orchestrator tool, future settings UI) compose this
 *  into their own reply shape. */
export function composeDrillDown(messageId: number): string | null {
	const msg = getMessage(messageId);
	if (!msg) return null;

	const lines: string[] = [];
	lines.push(buildHeader(msg));
	lines.push(buildEnvelope(msg));

	const extract = getExtractedData<TransactionalExtract>(messageId);
	if (extract) {
		lines.push('', 'Extracted:', formatExtract(extract));
	}

	if (msg.bodyPreview) {
		lines.push('', 'Preview:', `  ${truncate(stripWhitespace(msg.bodyPreview), 200)}`);
	}

	const history = listAgentActions(messageId, ACTION_HISTORY_LIMIT);
	if (history.length > 0) {
		lines.push('', 'Agent history:');
		for (const a of history) {
			lines.push(`  · ${formatAction(a)}`);
		}
	}

	lines.push('', '(say "read body" for full text, "mark processed" to clear)');
	return lines.join('\n');
}

function buildHeader(msg: InboxMessage): string {
	const cat = msg.category ?? 'unclassified';
	const when = formatTimestamp(msg.dateReceived);
	return `📩 Msg ${msg.id} — ${cat} — ${when}`;
}

function buildEnvelope(msg: InboxMessage): string {
	const from = msg.fromName
		? `${msg.fromName} <${msg.fromAddress}>`
		: msg.fromAddress || 'unknown';
	return `From: ${from}\nSubject: ${truncate(msg.subject, 120)}`;
}

function formatExtract(e: TransactionalExtract): string {
	const parts: string[] = [];
	parts.push(`kind=${e.kind}`);
	if (e.amount !== undefined && e.currency) {
		parts.push(`${e.currency} ${formatAmount(e.amount)}`);
	} else if (e.amount !== undefined) {
		parts.push(formatAmount(e.amount));
	}
	if (e.merchant) parts.push(`@ ${e.merchant}`);
	if (e.cardLast4) parts.push(`••${e.cardLast4}`);
	if (e.date) parts.push(e.date);
	if (e.referenceNumber) parts.push(`ref ${e.referenceNumber}`);
	if (e.anomalyHint) parts.push('anomaly=true');
	if (e.note) parts.push(`(${truncate(e.note, 60)})`);
	return `  ${parts.join(' · ')}`;
}

function formatAction(a: AgentActionRow): string {
	const when = formatTimestamp(a.timestamp);
	const args = a.args && typeof a.args === 'object' ? (a.args as Record<string, unknown>) : null;
	const result =
		a.result && typeof a.result === 'object' ? (a.result as Record<string, unknown>) : null;

	const flags: string[] = [];
	if (args?.mode) flags.push(String(args.mode));
	if (args?.reason) flags.push(String(args.reason));
	if (result?.kind) flags.push(`kind=${result.kind}`);
	if (result?.pushed === true) flags.push('pushed');
	if (result?.pushed === false && a.tool === 'inbox-anomaly-push') flags.push('deferred');
	if (result?.usedBodyFallback) flags.push('body-fallback');
	if (result?.ok === false) flags.push('failed');

	const tail = flags.length > 0 ? ` (${flags.join(', ')})` : '';
	return `${when} ${a.tool} [${a.actor}]${tail}`;
}

function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	return d.toLocaleString('en-GB', {
		day: '2-digit',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	});
}

function formatAmount(n: number): string {
	if (Math.round(n) === n) return n.toLocaleString('en-US');
	return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function stripWhitespace(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, n: number): string {
	if (!s) return '';
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
