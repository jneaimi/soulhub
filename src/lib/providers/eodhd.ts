import type { ProviderTester, TestResult } from './types.js';
import { withNetworkGuard } from './_shared.js';

const ENV_KEY = 'EODHD_API_KEY';

export const provider: ProviderTester = {
	id: 'eodhd',
	name: 'EODHD',
	field: {
		envKey: ENV_KEY,
		label: 'API Key',
		link: 'https://eodhd.com/cp/dashboard',
	},
	test: () =>
		withNetworkGuard(ENV_KEY, process.env[ENV_KEY], async (): Promise<TestResult> => {
			const key = process.env[ENV_KEY] as string;
			// `user` endpoint exists on every plan and returns the account row
			// without burning a fundamental-data call. fmt=json keeps parsing simple.
			const res = await fetch(
				`https://eodhd.com/api/user?api_token=${encodeURIComponent(key)}&fmt=json`,
			);
			if (res.status === 401 || res.status === 403) {
				return { ok: false, status: 'unauthorized', message: 'Token rejected.' };
			}
			if (res.status === 429) {
				return { ok: false, status: 'ratelimit', message: 'Rate limited — try again shortly.' };
			}
			if (res.ok) {
				return { ok: true, status: 'ok' };
			}
			const text = await res.text().catch(() => '');
			return {
				ok: false,
				status: 'invalid',
				message: text.slice(0, 200) || `HTTP ${res.status}`,
			};
		}),
};
