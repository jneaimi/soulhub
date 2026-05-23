import type { ProviderTester } from './types.js';
import { mapAuthStatus, withNetworkGuard } from './_shared.js';

const ENV_KEY = 'OPENROUTER_API_KEY';

export const provider: ProviderTester = {
	id: 'openrouter',
	name: 'OpenRouter',
	field: {
		envKey: ENV_KEY,
		label: 'API Key',
		link: 'https://openrouter.ai/keys',
	},
	test: () =>
		withNetworkGuard(ENV_KEY, process.env[ENV_KEY], async () => {
			const key = process.env[ENV_KEY] as string;
			const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
				headers: { Authorization: `Bearer ${key}` },
			});
			const body = await res.json().catch(() => undefined);
			return mapAuthStatus(res.status, body);
		}),
};
