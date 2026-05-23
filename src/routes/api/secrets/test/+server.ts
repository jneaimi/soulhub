import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { testSecret } from '$lib/secret-testers.js';

/** POST /api/secrets/test — body: { key } — exercises the credential against
 *  the upstream API via the adapter that declares it. Always 200 with a
 *  structured TestResult; non-OK outcomes are signalled by `result.ok`. */
export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, status: 'invalid', message: 'Invalid JSON body.' }, { status: 400 });
	}

	const key = (body as { key?: unknown })?.key;
	if (typeof key !== 'string' || !key) {
		return json({ ok: false, status: 'invalid', message: 'Missing `key`.' }, { status: 400 });
	}

	const result = await testSecret(key);
	return json(result);
};
