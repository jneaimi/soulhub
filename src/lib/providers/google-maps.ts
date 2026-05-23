import type { ProviderTester, TestResult } from './types.js';
import { withNetworkGuard } from './_shared.js';

const ENV_KEY = 'GOOGLE_API_KEY';

export const provider: ProviderTester = {
	id: 'google-maps',
	name: 'Google Maps Platform',
	field: {
		envKey: ENV_KEY,
		label: 'API Key',
		link: 'https://console.cloud.google.com/google/maps-apis/credentials',
	},
	test: () =>
		withNetworkGuard(ENV_KEY, process.env[ENV_KEY], async (): Promise<TestResult> => {
			const key = process.env[ENV_KEY] as string;
			// Geocoding API is the lightest validation — a single result for a
			// known landmark is enough to exercise auth without burning quota.
			const res = await fetch(
				`https://maps.googleapis.com/maps/api/geocode/json?address=Dubai&key=${encodeURIComponent(key)}`,
			);
			const body = (await res.json().catch(() => undefined)) as
				| { status?: string; error_message?: string }
				| undefined;
			if (!body) {
				return { ok: false, status: 'invalid', message: `HTTP ${res.status}` };
			}
			switch (body.status) {
				case 'OK':
				case 'ZERO_RESULTS':
					return { ok: true, status: 'ok' };
				case 'REQUEST_DENIED':
					return {
						ok: false,
						status: 'unauthorized',
						message: body.error_message ?? 'Key denied — enable Geocoding API or check restrictions.',
					};
				case 'OVER_QUERY_LIMIT':
					return { ok: false, status: 'ratelimit', message: 'Quota exceeded.' };
				default:
					return {
						ok: false,
						status: 'invalid',
						message: body.error_message ?? body.status ?? `HTTP ${res.status}`,
					};
			}
		}),
};
