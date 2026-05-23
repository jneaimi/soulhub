import type { ProviderTester } from './types.js';
import { mapAuthStatus, withNetworkGuard } from './_shared.js';

const ENV_KEY = 'ELEVENLABS_API_KEY';

export const provider: ProviderTester = {
	id: 'elevenlabs',
	name: 'ElevenLabs',
	field: {
		envKey: ENV_KEY,
		label: 'API Key',
		link: 'https://elevenlabs.io/app/settings/api-keys',
	},
	test: () =>
		withNetworkGuard(ENV_KEY, process.env[ENV_KEY], async () => {
			const key = process.env[ENV_KEY] as string;
			const res = await fetch('https://api.elevenlabs.io/v1/user', {
				headers: { 'xi-api-key': key },
			});
			const body = await res.json().catch(() => undefined);
			return mapAuthStatus(res.status, body);
		}),
};
