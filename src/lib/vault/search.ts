import MiniSearch from 'minisearch';
import type { VaultNote, SearchQuery, SearchResult } from './types.js';

export class VaultSearch {
	private index: MiniSearch;
	private noteMap = new Map<string, VaultNote>();

	constructor() {
		this.index = new MiniSearch({
			fields: ['title', 'content', 'tags', 'type', 'project'],
			storeFields: ['title', 'type', 'tags', 'project'],
			searchOptions: {
				boost: { title: 3, tags: 2 },
				fuzzy: 0.2,
				prefix: true,
			},
		});
	}

	rebuild(notes: VaultNote[]): void {
		this.index.removeAll();
		this.noteMap.clear();

		const docs = notes.map((note) => ({
			id: note.path,
			title: note.title,
			content: note.content.slice(0, 5000),
			tags: (note.meta.tags ?? []).join(' '),
			type: note.meta.type ?? '',
			project: note.meta.project ?? '',
		}));

		this.index.addAll(docs);
		for (const note of notes) {
			this.noteMap.set(note.path, note);
		}
	}

	upsert(note: VaultNote): void {
		try {
			this.index.discard(note.path);
		} catch {
			// not in index yet
		}
		this.index.add({
			id: note.path,
			title: note.title,
			content: note.content.slice(0, 5000),
			tags: (note.meta.tags ?? []).join(' '),
			type: note.meta.type ?? '',
			project: note.meta.project ?? '',
		});
		this.noteMap.set(note.path, note);
	}

	remove(path: string): void {
		try {
			this.index.discard(path);
		} catch {
			// not in index
		}
		this.noteMap.delete(path);
	}

	search(query: SearchQuery): SearchResult[] {
		const limit = query.limit ?? 20;
		const offset = query.offset ?? 0;

		if (query.q) {
			const filterFn = (result: Record<string, unknown>) => {
				if (query.type) {
					const types = Array.isArray(query.type) ? query.type : [query.type];
					if (!types.includes(result['type'] as string)) return false;
				}
				if (query.project && result['project'] !== query.project) return false;
				if (query.tags && query.tags.length > 0) {
					const resultTags = (result['tags'] as string).split(' ');
					if (!query.tags.every((t) => resultTags.includes(t))) return false;
				}
				if (query.zone) {
					const id = result['id'] as string;
					const zone = id.split('/').length > 1 ? id.split('/')[0] : 'inbox';
					if (zone !== query.zone) return false;
				}
				return true;
			};

			const raw = this.index.search(query.q, { filter: filterFn as (result: { id: unknown; terms: string[]; queryTerms: string[]; score: number }) => boolean });

			return raw.slice(offset, offset + limit).map((r) => {
				const note = this.noteMap.get(r.id as string);
				return {
					path: r.id as string,
					title: (r.title as string) ?? '',
					type: (r.type as string) || undefined,
					tags: r.tags ? (r.tags as string).split(' ').filter(Boolean) : undefined,
					project: (r.project as string) || undefined,
					status: note?.meta.status as string | undefined,
					score: r.score,
					snippet: note ? note.content.slice(0, 200) : undefined,
				};
			});
		}

		// No text query — filter-only mode
		let notes = Array.from(this.noteMap.values());

		if (query.type) {
			const types = Array.isArray(query.type) ? query.type : [query.type];
			notes = notes.filter((n) => n.meta.type && types.includes(n.meta.type));
		}
		if (query.project) {
			notes = notes.filter((n) => n.meta.project === query.project);
		}
		if (query.tags && query.tags.length > 0) {
			notes = notes.filter((n) => {
				const noteTags = n.meta.tags ?? [];
				return query.tags!.every((t) => noteTags.includes(t));
			});
		}
		if (query.zone) {
			notes = notes.filter((n) => {
				const zone = n.path.split('/').length > 1 ? n.path.split('/')[0] : 'inbox';
				return zone === query.zone;
			});
		}

		// Sort by mtime descending
		notes.sort((a, b) => b.mtime - a.mtime);

		return notes.slice(offset, offset + limit).map((n) => ({
			path: n.path,
			title: n.title,
			type: n.meta.type,
			tags: n.meta.tags,
			project: n.meta.project,
			status: n.meta.status as string | undefined,
			score: 0,
			snippet: n.content.slice(0, 200),
		}));
	}
}
