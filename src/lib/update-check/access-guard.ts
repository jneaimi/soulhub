/**
 * Access guard for the RCE-class POST /api/system/update endpoint (ADR-011 §2a).
 *
 * A STRICTER variant of `checkFileApiAccess` (hooks.server.ts). That guard
 * admits any request whose `Sec-Fetch-Site` is not `cross-site` — including
 * header-less `curl` (which sends no `Sec-Fetch-Site` at all) and `same-site`
 * subdomains. Fine for file *reads*; an unacceptable backdoor for an endpoint
 * that runs `git pull → build → pm2 reload`.
 *
 * This guard fails CLOSED. It admits exactly two callers:
 *   1. A same-origin browser fetch — `Sec-Fetch-Site: same-origin`, which the
 *      browser sets and page JS cannot forge. CSRF pages send `cross-site`; a
 *      direct navigation / SSR sends `none`; both are rejected here.
 *   2. A request bearing `Authorization: Bearer ${SOUL_HUB_SECRET}` — but ONLY
 *      when that secret is configured. The secret is OPTIONAL (inbox-only), so
 *      the guard NEVER falls back to a permissive allowance when it is unset.
 *
 * Everything else → 403. (The endpoint returns 404 when the feature flag is
 * off, before this guard is even consulted, so a disabled install reveals
 * nothing.)
 */
export interface UpdateAccessResult {
	ok: boolean;
	/** Suggested HTTP status when `ok` is false. */
	status?: number;
	reason?: string;
}

export function checkUpdateAccess(request: Request): UpdateAccessResult {
	// 1. Optional bearer — only honored when the secret is actually configured.
	const secret = process.env.SOUL_HUB_SECRET;
	if (secret) {
		const auth = request.headers.get('authorization') || '';
		if (auth === `Bearer ${secret}`) return { ok: true };
	}

	// 2. Same-origin browser fetch only. Strict equality — NOT "anything that
	//    isn't cross-site". `null` (header-less curl), `none`, and `same-site`
	//    all fail here.
	const fetchSite = request.headers.get('sec-fetch-site');
	if (fetchSite === 'same-origin') return { ok: true };

	return {
		ok: false,
		status: 403,
		reason:
			'update requires a same-origin browser request (Sec-Fetch-Site: same-origin)' +
			(secret ? ' or Authorization: Bearer <SOUL_HUB_SECRET>' : ''),
	};
}
