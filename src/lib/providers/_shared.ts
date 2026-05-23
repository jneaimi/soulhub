/** Shared helpers for provider testers — kept tiny on purpose. */

import type { TestResult } from '../channels/types.js';

/** Wrap a provider test so network errors surface as `network` rather than
 *  throwing. Each provider implements only the success/failure mapping. */
export async function withNetworkGuard(
	envKey: string,
	value: string | undefined,
	run: () => Promise<TestResult>,
): Promise<TestResult> {
	if (!value) {
		return { ok: false, status: 'unconfigured', message: `${envKey} is not set.` };
	}
	try {
		return await run();
	} catch (err) {
		return { ok: false, status: 'network', message: (err as Error).message };
	}
}

/** Map a generic HTTP outcome to a TestStatus when the provider's auth
 *  semantics are the standard 401-unauthorized / 200-ok pattern. */
export function mapAuthStatus(httpStatus: number, body?: unknown): TestResult {
	if (httpStatus >= 200 && httpStatus < 300) {
		return { ok: true, status: 'ok' };
	}
	if (httpStatus === 401 || httpStatus === 403) {
		return { ok: false, status: 'unauthorized', message: 'Credential rejected.' };
	}
	if (httpStatus === 429) {
		return { ok: false, status: 'ratelimit', message: 'Rate limited — try again shortly.' };
	}
	const description =
		body && typeof body === 'object'
			? extractErrorMessage(body as Record<string, unknown>)
			: undefined;
	return { ok: false, status: 'invalid', message: description ?? `HTTP ${httpStatus}` };
}

/** Pull a human-readable error string out of common JSON error shapes. */
function extractErrorMessage(body: Record<string, unknown>): string | undefined {
	const err = body.error;
	if (typeof err === 'string') return err;
	if (err && typeof err === 'object' && 'message' in err) {
		const msg = (err as { message: unknown }).message;
		if (typeof msg === 'string') return msg;
	}
	if (typeof body.message === 'string') return body.message;
	return undefined;
}
