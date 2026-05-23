import type { ProviderTester } from './types.js';
import { mapAuthStatus, withNetworkGuard } from './_shared.js';

const ENV_KEY = 'RESEND_API_KEY';

export const provider: ProviderTester = {
	id: 'resend',
	name: 'Resend',
	field: {
		envKey: ENV_KEY,
		label: 'API Key',
		link: 'https://resend.com/api-keys',
	},
	test: () =>
		withNetworkGuard(ENV_KEY, process.env[ENV_KEY], async () => {
			const key = process.env[ENV_KEY] as string;
			const res = await fetch('https://api.resend.com/api-keys', {
				headers: { Authorization: `Bearer ${key}` },
			});
			const body = await res.json().catch(() => undefined);
			return mapAuthStatus(res.status, body);
		}),
};
