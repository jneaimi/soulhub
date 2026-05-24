// ADR-004 (soul-hub-cli) — pure helpers for link-safe note relocation.
//
// When a note moves from `srcPath` to `dstPath`, every inbound wikilink across
// the vault must be rewritten so it still resolves. Two surfaces carry links:
//   1. Body  — `[[target#heading^block|alias]]` (and `![[embed]]`).
//   2. Frontmatter relationship fields — `relates_to: "[[slug]]"`, arrays, and
//      rich `{ target: "[[slug]]" }` objects. These are NOT in the backlink
//      index (parseNote only extracts body links), so a relocation MUST scan
//      every note's frontmatter directly — getBacklinks() alone misses them.
//
// These functions are pure (no I/O, no engine state); the engine supplies the
// resolver + uniqueness oracle. Kept separate so the rewrite logic is unit-
// testable without booting the vault.

import type { VaultMeta } from './types.js';

/** One requested relocation. `targetZone` defaults to the source's current
 *  zone (pure rename); `newFilename` defaults to the source filename. */
export interface MoveSpec {
	src: string;
	targetZone?: string;
	newFilename?: string;
}

/** A note whose inbound links were (or, in dry-run, would be) rewritten. */
export interface RewritePlanItem {
	path: string;
	bodyCount: number;
	metaCount: number;
}

export interface RelocateResult {
	success: boolean;
	error?: string;
	dryRun?: boolean;
	moves: { src: string; dst: string }[];
	rewrites: RewritePlanItem[];
}

// Mirror of parser.ts WIKILINK_RE (kept in sync by eye; same capture groups:
// 1=embed `!`, 2=target, 3=#heading, 4=^block, 5=|alias).
export const WIKILINK_RE =
	/(!?)\[\[([^\]\n|#^]+?)(?:#([^\]\n|]+?))?(?:\^([^\]\n|]+?))?(?:\|([^\]\n]+?))?\]\]/g;

export function stripMd(p: string): string {
	return p.replace(/\.md$/, '');
}

/** Compute the replacement raw-target for a link whose old target resolved to a
 *  note now living at `dstPath`. Preserves the author's style: a bare target
 *  (no `/`) stays bare when the new slug is still unique; otherwise the full
 *  vault-relative path is used (always resolvable). */
export function newTargetFor(
	oldTarget: string,
	dstPath: string,
	bareSlugIsUnique: (slug: string) => boolean,
): string {
	const dstNoExt = stripMd(dstPath);
	const dstSlug = dstNoExt.split('/').pop()!;
	const oldWasBare = !oldTarget.includes('/');
	if (oldWasBare && bareSlugIsUnique(dstSlug)) return dstSlug;
	return dstNoExt;
}

/** Rebuild a wikilink string from its parts, preserving heading/block/alias/embed. */
function buildLink(
	bang: string,
	target: string,
	heading: string | undefined,
	block: string | undefined,
	alias: string | undefined,
): string {
	return `${bang || ''}[[${target}${heading ? '#' + heading : ''}${block ? '^' + block : ''}${
		alias ? '|' + alias : ''
	}]]`;
}

/** Rewrite body wikilinks. For each `[[…]]` whose target resolves (from this
 *  note's perspective) to a path in `moveMap`, swap only the target portion to
 *  point at the destination, preserving every other part of the link. */
export function rewriteBody(
	content: string,
	resolveTarget: (rawTarget: string) => string | null,
	moveMap: Map<string, string>,
	bareSlugIsUnique: (slug: string) => boolean,
): { content: string; count: number } {
	let count = 0;
	const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);
	const out = content.replace(re, (full, bang, target, heading, block, alias) => {
		const t = String(target).trim();
		const resolved = resolveTarget(t);
		if (!resolved || !moveMap.has(resolved)) return full;
		count++;
		return buildLink(bang, newTargetFor(t, moveMap.get(resolved)!, bareSlugIsUnique), heading, block, alias);
	});
	return { content: out, count };
}

/** Extract the target slug from a single frontmatter wikilink value like
 *  `"[[zone/slug|alias]]"`. Returns null when the value isn't a wikilink. */
function parseSingleLink(
	value: string,
): { bang: string; target: string; heading?: string; block?: string; alias?: string } | null {
	const re = new RegExp('^' + WIKILINK_RE.source + '$', '');
	const m = re.exec(value.trim());
	if (!m) return null;
	return { bang: m[1], target: m[2].trim(), heading: m[3], block: m[4], alias: m[5] };
}

/** Rewrite a single frontmatter value if it is a wikilink resolving into the
 *  move map. Non-wikilink strings pass through unchanged. */
function rewriteValue(
	value: unknown,
	resolveTarget: (rawTarget: string) => string | null,
	moveMap: Map<string, string>,
	bareSlugIsUnique: (slug: string) => boolean,
): { value: unknown; changed: boolean } {
	// Plain string wikilink: "[[slug]]"
	if (typeof value === 'string') {
		const parsed = parseSingleLink(value);
		if (!parsed) return { value, changed: false };
		const resolved = resolveTarget(parsed.target);
		if (!resolved || !moveMap.has(resolved)) return { value, changed: false };
		const newT = newTargetFor(parsed.target, moveMap.get(resolved)!, bareSlugIsUnique);
		return {
			value: buildLink(parsed.bang, newT, parsed.heading, parsed.block, parsed.alias),
			changed: true,
		};
	}
	// Rich object form: { target: "[[slug]]", ... } — rewrite the target key only.
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;
		if (typeof obj.target === 'string') {
			const r = rewriteValue(obj.target, resolveTarget, moveMap, bareSlugIsUnique);
			if (r.changed) return { value: { ...obj, target: r.value }, changed: true };
		}
		return { value, changed: false };
	}
	return { value, changed: false };
}

/** Rewrite all frontmatter relationship-field wikilinks that resolve into the
 *  move map. Handles string, array-of-string, and array-of-object forms.
 *  Returns a new meta object (shallow-cloned) + the number of values changed. */
export function rewriteMeta(
	meta: VaultMeta,
	relFields: string[],
	resolveTarget: (rawTarget: string) => string | null,
	moveMap: Map<string, string>,
	bareSlugIsUnique: (slug: string) => boolean,
): { meta: VaultMeta; count: number } {
	let count = 0;
	const out: VaultMeta = { ...meta };
	for (const field of relFields) {
		const v = out[field];
		if (v === undefined || v === null) continue;
		if (Array.isArray(v)) {
			let touched = false;
			const arr = v.map((item) => {
				const r = rewriteValue(item, resolveTarget, moveMap, bareSlugIsUnique);
				if (r.changed) {
					count++;
					touched = true;
				}
				return r.value;
			});
			if (touched) out[field] = arr;
		} else {
			const r = rewriteValue(v, resolveTarget, moveMap, bareSlugIsUnique);
			if (r.changed) {
				out[field] = r.value;
				count++;
			}
		}
	}
	return { meta: out, count };
}
