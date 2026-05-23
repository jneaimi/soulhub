import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSecretValue } from '$lib/secrets.js';

/** GET /api/secrets/cf-access — returns CF Access credentials for trigger curl.
 *  Safe: Soul Hub is behind Cloudflare Access, so only authenticated users see this. */
export const GET: RequestHandler = async () => {
	return json({
		clientId: getSecretValue('CF_ACCESS_CLIENT_ID') || '',
		clientSecret: getSecretValue('CF_ACCESS_CLIENT_SECRET') || '',
	});
};
