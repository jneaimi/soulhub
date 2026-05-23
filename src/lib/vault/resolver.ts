/** Wikilink resolver — maps the raw text inside `[[…]]` to a vault-root-
 *  relative `.md` path. Mirrors Obsidian's resolution rules so links
 *  written in either editor work consistently here.
 *
 *  Resolution order, in priority:
 *    1. URL or non-`.md` asset extension → `'external'` (not a note ref)
 *    2. Frontmatter `aliases:` index — exact (case + NFC) match
 *    3. Path with `./` or `../` → posix-resolve against source dir,
 *       try literal hit, fall back to suffix match if it misses
 *    4. Path with `/` → "shortest unique suffix" match across all paths
 *       (Obsidian's "shortest path that uniquely identifies the file"),
 *       with closest-source disambiguation on ties
 *    5. Trailing-`/` ref → look for `<raw>/index.md`
 *    6. Bare basename → filename map (existing behaviour)
 *    7. Folder ref with no basename match → `<raw>/index.md` fallback
 *
 *  All comparisons are NFC-normalized + lowercased so macOS NFD-on-disk
 *  filenames match the NFC users typically type in.
 *
 *  The `'external'` sentinel lets the indexer skip URLs and asset embeds
 *  when computing the broken-links count without losing the link record. */

import { posix } from 'node:path';

const EXTERNAL = 'external' as const;

const NON_NOTE_EXT = /\.(png|jpe?g|gif|svg|webp|ico|bmp|pdf|mp3|mp4|wav|ogg|webm|mov|json|csv|xlsx?|docx?|pptx?|zip|html?)$/i;
const URL_PREFIX = /^(?:https?:|mailto:|ftp:|file:)/i;

export interface ResolverEntry {
	path: string;
	aliases?: string[];
}

const norm = (s: string): string => s.normalize('NFC').toLowerCase();

export class WikilinkResolver {
	private filenameMap = new Map<string, string[]>(); // basename(stem) → [paths]
	private aliasMap = new Map<string, string[]>(); // alias → [paths]
	private allPaths: string[] = []; // for suffix matching
	private allPathsLower: string[] = []; // memoised lowercased mirror

	build(entries: ResolverEntry[]): void {
		this.filenameMap.clear();
		this.aliasMap.clear();
		this.allPaths = [];
		this.allPathsLower = [];
		for (const entry of entries) {
			this.addEntry(entry);
		}
	}

	add(entry: ResolverEntry): void {
		this.addEntry(entry);
	}

	remove(path: string): void {
		// Remove from filenameMap
		const basenameKey = this.basenameKey(path);
		const filenames = this.filenameMap.get(basenameKey);
		if (filenames) {
			const filtered = filenames.filter((p) => p !== path);
			if (filtered.length === 0) this.filenameMap.delete(basenameKey);
			else this.filenameMap.set(basenameKey, filtered);
		}
		// Remove from aliasMap (every alias entry that pointed at this path)
		for (const [key, paths] of this.aliasMap) {
			const filtered = paths.filter((p) => p !== path);
			if (filtered.length === 0) this.aliasMap.delete(key);
			else this.aliasMap.set(key, filtered);
		}
		// Remove from allPaths
		const idx = this.allPaths.indexOf(path);
		if (idx >= 0) {
			this.allPaths.splice(idx, 1);
			this.allPathsLower.splice(idx, 1);
		}
	}

	resolve(raw: string, sourcePath?: string): string | null {
		const trimmed = raw.trim();
		if (!trimmed) return null;

		// 1. URLs and non-note assets — return sentinel so callers know it's
		//    intentionally not a note ref, not "broken".
		if (URL_PREFIX.test(trimmed) || NON_NOTE_EXT.test(trimmed)) {
			return EXTERNAL;
		}

		// Strip a trailing `/` and remember it — we use this hint later to
		// short-circuit straight to the index.md fallback.
		const hadTrailingSlash = trimmed.endsWith('/');
		const cleaned = hadTrailingSlash ? trimmed.slice(0, -1) : trimmed;

		const stripped = cleaned.replace(/\.md$/i, '');
		if (!stripped) return null;
		const lookup = norm(stripped);

		// 2. Alias map (exact match) — supports `aliases: [Old Name]` rewrites.
		const aliasHit = this.aliasMap.get(lookup);
		if (aliasHit && aliasHit.length > 0) {
			return this.disambiguate(aliasHit, sourcePath);
		}

		// 3. Relative path — resolve against source directory.
		if (sourcePath && (lookup.startsWith('./') || lookup.startsWith('../'))) {
			const sourceDir = sourcePath.includes('/')
				? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
				: '';
			const joined = posix.normalize(posix.join(sourceDir, lookup));
			if (!joined.startsWith('../') && joined !== '..' && !joined.startsWith('/')) {
				const literal = this.matchLiteralPath(joined);
				if (literal) return literal;
				if (hadTrailingSlash) {
					const indexHit = this.matchLiteralPath(joined + '/index');
					if (indexHit) return indexHit;
				}
				// Fall through to suffix match on the basename portion of the
				// joined path — Obsidian forgives wrong `..` counts when the
				// trailing segment is unambiguous.
				const suffixCandidates = this.suffixMatch(joined);
				if (suffixCandidates.length > 0) {
					return this.disambiguate(suffixCandidates, sourcePath);
				}
			}
			// Even when posix-resolution escaped or missed, try suffix match on
			// the original lookup minus its leading `../`s — this catches
			// "../knowledge/..." from a deeply-nested source where the user
			// got the dot count wrong.
			const stripped = lookup.replace(/^(?:\.\.?\/)+/, '');
			if (stripped && stripped !== lookup) {
				const candidates = this.suffixMatch(stripped);
				if (candidates.length > 0) return this.disambiguate(candidates, sourcePath);
				if (hadTrailingSlash) {
					const idx = this.suffixMatch(stripped + '/index');
					if (idx.length > 0) return this.disambiguate(idx, sourcePath);
				}
			}
			return null;
		}

		// 4. Path with `/` — Obsidian's "shortest unique suffix" rule.
		if (lookup.includes('/')) {
			const literal = this.matchLiteralPath(lookup);
			if (literal) return literal;
			const candidates = this.suffixMatch(lookup);
			if (candidates.length > 0) {
				return this.disambiguate(candidates, sourcePath);
			}
			if (hadTrailingSlash) {
				const idxLiteral = this.matchLiteralPath(lookup + '/index');
				if (idxLiteral) return idxLiteral;
				const idxSuffix = this.suffixMatch(lookup + '/index');
				if (idxSuffix.length > 0) return this.disambiguate(idxSuffix, sourcePath);
			}
			// Folder fallback even without explicit trailing slash — `[[projects/foo]]`
			// where `projects/foo/` exists as a folder with an index.
			const idxLiteral2 = this.matchLiteralPath(lookup + '/index');
			if (idxLiteral2) return idxLiteral2;
			return null;
		}

		// 5. Bare basename — filename map.
		const matches = this.filenameMap.get(lookup);
		if (matches && matches.length > 0) {
			return this.disambiguate(matches, sourcePath);
		}

		// 6. Trailing-slash bare ref → folder/index lookup
		if (hadTrailingSlash) {
			const idx = this.filenameMap.get('index');
			if (idx) {
				const wanted = `${lookup}/index.md`;
				const hit = idx.find((p) => norm(p) === wanted);
				if (hit) return hit;
			}
		}

		return null;
	}

	/** True when `raw` is a URL or non-note asset. Useful for callers that
	 *  want to filter "broken wikilinks" without flagging asset embeds. */
	static isExternal(raw: string): boolean {
		const t = raw.trim();
		return URL_PREFIX.test(t) || NON_NOTE_EXT.test(t);
	}

	/** True when a resolver result represents an external/asset ref rather
	 *  than a missing note. */
	static isExternalResult(resolved: string | null): boolean {
		return resolved === EXTERNAL;
	}

	// ── private ──

	private addEntry(entry: ResolverEntry): void {
		const path = entry.path;
		if (!this.allPaths.includes(path)) {
			this.allPaths.push(path);
			this.allPathsLower.push(norm(path));
		}

		const basenameKey = this.basenameKey(path);
		const existing = this.filenameMap.get(basenameKey) ?? [];
		if (!existing.includes(path)) existing.push(path);
		this.filenameMap.set(basenameKey, existing);

		if (entry.aliases) {
			for (const alias of entry.aliases) {
				if (typeof alias !== 'string' || !alias.trim()) continue;
				const key = norm(alias.trim().replace(/\.md$/i, ''));
				const aliasPaths = this.aliasMap.get(key) ?? [];
				if (!aliasPaths.includes(path)) aliasPaths.push(path);
				this.aliasMap.set(key, aliasPaths);
			}
		}
	}

	private basenameKey(path: string): string {
		const basename = path.split('/').pop() ?? path;
		return norm(basename.replace(/\.md$/i, ''));
	}

	/** Exact full-path lookup — `lookup` is already lowercased + NFC. */
	private matchLiteralPath(lookup: string): string | null {
		const wantedMd = lookup + '.md';
		for (let i = 0; i < this.allPathsLower.length; i++) {
			const lp = this.allPathsLower[i];
			if (lp === wantedMd || lp === lookup) return this.allPaths[i];
		}
		return null;
	}

	/** "Shortest unique suffix" matcher — returns every path that ends with
	 *  `/<lookup>.md` (or equals `<lookup>.md`). Disambiguation is the
	 *  caller's job. */
	private suffixMatch(lookup: string): string[] {
		const tail = '/' + lookup + '.md';
		const tailNoExt = '/' + lookup;
		const exact = lookup + '.md';
		const out: string[] = [];
		for (let i = 0; i < this.allPathsLower.length; i++) {
			const lp = this.allPathsLower[i];
			if (lp === exact || lp.endsWith(tail) || lp.endsWith(tailNoExt)) {
				out.push(this.allPaths[i]);
			}
		}
		return out;
	}

	/** Closest-to-source picker for ambiguous matches. "Closest" =
	 *  longest shared directory prefix; ties broken by shallower path. */
	private disambiguate(candidates: string[], sourcePath?: string): string | null {
		if (candidates.length === 0) return null;
		if (candidates.length === 1) return candidates[0];
		if (!sourcePath) return candidates[0];
		const sourceDir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
		const sourceParts = sourceDir.split('/').filter(Boolean);
		let best: { path: string; shared: number; depth: number } | null = null;
		for (const candidate of candidates) {
			if (candidate === sourcePath) continue; // never self-link
			const candDir = candidate.includes('/') ? candidate.slice(0, candidate.lastIndexOf('/')) : '';
			const candParts = candDir.split('/').filter(Boolean);
			let shared = 0;
			while (shared < sourceParts.length && shared < candParts.length && sourceParts[shared] === candParts[shared]) {
				shared++;
			}
			const depth = candParts.length;
			if (!best || shared > best.shared || (shared === best.shared && depth < best.depth)) {
				best = { path: candidate, shared, depth };
			}
		}
		return best ? best.path : null;
	}
}
