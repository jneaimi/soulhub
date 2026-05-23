import type { ProviderTester } from './types.js';
import { mapAuthStatus, withNetworkGuard } from './_shared.js';

const ENV_KEY = 'ANTHROPIC_API_KEY';

export const provider: ProviderTester = {
	id: 'anthropic',
	name: 'Anthropic',
	field: {
		envKey: ENV_KEY,
		label: 'API Key',
		link: 'https://console.anthropic.com/settings/keys',
	},
	test: () =>
		withNetworkGuard(ENV_KEY, process.env[ENV_KEY], async () => {
			const key = process.env[ENV_KEY] as string;
			const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
				headers: {
					'x-api-key': key,
					'anthropic-version': '2023-06-01',
				},
			});
			const body = await res.json().catch(() => undefined);
			return mapAuthStatus(res.status, body);
		}),
};
