import type { ProviderTester } from './types.js';
import { mapAuthStatus, withNetworkGuard } from './_shared.js';

const ENV_KEY = 'HF_API_TOKEN';

export const provider: ProviderTester = {
	id: 'huggingface',
	name: 'Hugging Face',
	field: {
		envKey: ENV_KEY,
		label: 'Access Token',
		link: 'https://huggingface.co/settings/tokens',
	},
	test: () =>
		withNetworkGuard(ENV_KEY, process.env[ENV_KEY], async () => {
			const key = process.env[ENV_KEY] as string;
			const res = await fetch('https://huggingface.co/api/whoami-v2', {
				headers: { Authorization: `Bearer ${key}` },
			});
			const body = await res.json().catch(() => undefined);
			return mapAuthStatus(res.status, body);
		}),
};
