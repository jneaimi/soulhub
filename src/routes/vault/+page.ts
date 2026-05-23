import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = async ({ url, fetch }) => {
	const notePath = url.searchParams.get('note');
	const view = url.searchParams.get('view') as 'list' | 'graph' | 'note' | 'edit' | null;
	const zone = url.searchParams.get('zone');
	const type = url.searchParams.get('type');
	const tags = url.searchParams.get('tags');

	let initialNote = null;
	let initialNoteError = null;

	if (notePath) {
		try {
			const encodedPath = notePath.split('/').map(encodeURIComponent).join('/');
			const res = await fetch(`/api/vault/notes/${encodedPath}`);
			if (res.ok) {
				initialNote = await res.json();
			} else {
				const body = await res.json().catch(() => ({}));
				initialNoteError = body.error ?? `Failed to load note (${res.status})`;
			}
		} catch (e) {
			initialNoteError = (e as Error).message || 'Network error';
		}
	}

	return {
		initialNote,
		initialNoteError,
		initialView: view || (notePath ? 'note' : 'list'),
		initialNotePath: notePath ? decodeURIComponent(notePath) : null,
		initialZone: zone,
		initialTypes: type ? type.split(',').filter(Boolean) : undefined,
		initialTags: tags ? tags.split(',').filter(Boolean) : undefined,
	};
};
