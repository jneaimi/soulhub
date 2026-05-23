/**
 * OpenRouter account-balance fetcher.
 *
 * Hits `GET https://openrouter.ai/api/v1/key` with the user's regular API key
 * (no management key required) and returns usage + limit info for the chip
 * in the /agents header. Cached in-process for 60s — OR doesn't expose
 * rate-limit headers on this endpoint, but it's an admin call that we don't
 * want to hammer once per page render.
 *
 * Failure modes (all return cached or null, never throw):
 *   - missing OPENROUTER_API_KEY  → null  (UI hides chip)
 *   - non-200 from OR             → cached if any, else null
 *   - network unreachable / 5s timeout → cached if any, else null
 *
 * The fetcher must NEVER block dispatch or other code paths. It's surfaced
 * via /api/openrouter/balance and read on the client.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/key';
const TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

export interface OpenRouterBalance {
	label: string;
	usage_total: number;
	usage_daily: number;
	usage_weekly: number;
	usage_monthly: number;
	limit: number | null;
	limit_remaining: number | null;
	is_free_tier: boolean;
	fetched_at: number;
	source: 'live' | 'cache';
}

interface KeyResponse {
	data?: {
		label?: string;
		usage?: number;
		usage_daily?: number;
		usage_weekly?: number;
		usage_monthly?: number;
		limit?: number | null;
		limit_remaining?: number | null;
		is_free_tier?: boolean;
	};
}

let cached: OpenRouterBalance | null = null;

export async function getOpenRouterBalance(force = false): Promise<OpenRouterBalance | null> {
	if (!force && cached && Date.now() - cached.fetched_at < TTL_MS) {
		return { ...cached, source: 'cache' };
	}

	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) return null;

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(ENDPOINT, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: ac.signal,
		});
		if (!res.ok) {
			return cached ? { ...cached, source: 'cache' } : null;
		}
		const json = (await res.json()) as KeyResponse;
		const d = json.data ?? {};
		cached = {
			label: typeof d.label === 'string' ? d.label : '',
			usage_total: Number(d.usage ?? 0),
			usage_daily: Number(d.usage_daily ?? 0),
			usage_weekly: Number(d.usage_weekly ?? 0),
			usage_monthly: Number(d.usage_monthly ?? 0),
			limit: d.limit == null ? null : Number(d.limit),
			limit_remaining: d.limit_remaining == null ? null : Number(d.limit_remaining),
			is_free_tier: !!d.is_free_tier,
			fetched_at: Date.now(),
			source: 'live',
		};
		return cached;
	} catch {
		return cached ? { ...cached, source: 'cache' } : null;
	} finally {
		clearTimeout(timer);
	}
}
