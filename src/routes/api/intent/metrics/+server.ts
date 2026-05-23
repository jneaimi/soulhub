/** GET /api/intent/metrics — ROI dashboard data for `/orchestration/intent`.
 *
 *  Returns everything the page needs in one round-trip so the dashboard
 *  loads with one request:
 *    - `period`: window bounds + days
 *    - `gates`: current state of `intent.patternEngine.enabled` +
 *      `historyFallback` from the live config
 *    - `sourceCounts`: regex/llm/pattern/fallback distribution in window
 *    - `routeCounts`: array of {route, n} sorted desc
 *    - `patterns`: active intent_patterns rows
 *    - `proposalsPending`: count of pending proposals (un-dismissed)
 *    - `recent`: last 20 intent_log rows in window
 *
 *  ?days=N — clamped to [1, 90]; default 7.
 *
 *  Read-only. Same-origin guard via Sec-Fetch-Site, consistent with the
 *  other `/api/intent/*` endpoints. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getInboxDb } from '$lib/inbox/db.js';
import { listProposed, listActivePatterns } from '$lib/intent/patterns.js';
import { config as soulHubConfig } from '$lib/config.js';
import type { IntentSource } from '$lib/intent/log.js';

interface SourceCounts {
	regex: number;
	llm: number;
	pattern: number;
	fallback: number;
}

interface RecentRow {
	ts: number;
	conversationKey: string;
	rawMessage: string;
	pickedRoute: string;
	source: IntentSource;
	confidence: number | null;
	latencyMs: number | null;
}

export const GET: RequestHandler = async ({ url, request }) => {
	if (request.headers.get('sec-fetch-site') === 'cross-site') {
		return json({ ok: false, error: 'cross-site requests rejected' }, { status: 403 });
	}

	const daysRaw = Number(url.searchParams.get('days') ?? 7);
	const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(90, Math.floor(daysRaw))) : 7;
	const toMs = Date.now();
	const fromMs = toMs - days * 24 * 60 * 60 * 1000;

	const db = getInboxDb();

	const sourceRows = db
		.prepare<[number]>(
			`SELECT source, COUNT(*) AS n FROM intent_log WHERE ts >= ? GROUP BY source`,
		)
		.all(fromMs) as Array<{ source: IntentSource; n: number }>;
	const sourceCounts: SourceCounts = { regex: 0, llm: 0, pattern: 0, fallback: 0 };
	for (const row of sourceRows) sourceCounts[row.source] = row.n;

	const routeRows = db
		.prepare<[number]>(
			`SELECT picked_route AS route, COUNT(*) AS n FROM intent_log
			 WHERE ts >= ?
			 GROUP BY picked_route
			 ORDER BY n DESC, route ASC`,
		)
		.all(fromMs) as Array<{ route: string; n: number }>;

	const recentRowsRaw = db
		.prepare<[number]>(
			`SELECT ts, conversation_key, raw_message, picked_route, source, confidence, latency_ms
			 FROM intent_log
			 WHERE ts >= ?
			 ORDER BY ts DESC
			 LIMIT 20`,
		)
		.all(fromMs) as Array<{
		ts: number;
		conversation_key: string;
		raw_message: string;
		picked_route: string;
		source: IntentSource;
		confidence: number | null;
		latency_ms: number | null;
	}>;
	const recent: RecentRow[] = recentRowsRaw.map((r) => ({
		ts: r.ts,
		conversationKey: r.conversation_key,
		rawMessage: r.raw_message,
		pickedRoute: r.picked_route,
		source: r.source,
		confidence: r.confidence,
		latencyMs: r.latency_ms,
	}));

	const patterns = listActivePatterns();
	const proposalsPending = listProposed().length;

	const gateCfg = soulHubConfig.intent?.patternEngine;
	const gates = {
		enabled: gateCfg?.enabled === true,
		historyFallback: gateCfg?.historyFallback === true,
	};

	return json({
		ok: true,
		period: { fromMs, toMs, days },
		gates,
		sourceCounts,
		routeCounts: routeRows,
		patterns,
		proposalsPending,
		recent,
	});
};
