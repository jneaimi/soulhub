import type { ProviderTester } from './types.js';
import { mapAuthStatus, withNetworkGuard } from './_shared.js';

const ENV_KEY = 'YOUTUBE_API_KEY';

export const provider: ProviderTester = {
	id: 'youtube',
	name: 'YouTube Data API',
	field: {
		envKey: ENV_KEY,
		label: 'API Key',
		link: 'https://console.cloud.google.com/apis/credentials',
	},
	test: () =>
		withNetworkGuard(ENV_KEY, process.env[ENV_KEY], async () => {
			const key = process.env[ENV_KEY] as string;
			// videos.list with chart=mostPopular is the cheapest validated read —
			// it doesn't burn a search quota unit and returns 400/403 fast on bad keys.
			const res = await fetch(
				`https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&maxResults=1&key=${encodeURIComponent(key)}`,
			);
			const body = await res.json().catch(() => undefined);
			return mapAuthStatus(res.status, body);
		}),
};
