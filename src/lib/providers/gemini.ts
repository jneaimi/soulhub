import type { ProviderTester } from './types.js';
import { mapAuthStatus, withNetworkGuard } from './_shared.js';

const ENV_KEY = 'GEMINI_API_KEY';

export const provider: ProviderTester = {
	id: 'gemini',
	name: 'Gemini',
	field: {
		envKey: ENV_KEY,
		label: 'API Key',
		link: 'https://aistudio.google.com/apikey',
	},
	test: () =>
		withNetworkGuard(ENV_KEY, process.env[ENV_KEY], async () => {
			const key = process.env[ENV_KEY] as string;
			const res = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1`,
			);
			const body = await res.json().catch(() => undefined);
			return mapAuthStatus(res.status, body);
		}),
};
