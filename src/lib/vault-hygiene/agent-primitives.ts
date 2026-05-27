/** ADR-007 P1 — Agent-executor primitives.
 *
 *  `retargetWikilink` — Re-point a broken wikilink to a correct target in a
 *    source note. Preserves `[[raw|alias]]` display text. Replaces ALL
 *    occurrences. Validates the new target exists before writing. Writes
 *    through `engine.updateNote` with `actor = 'hygiene-remediate'` so the
 *    audit log attributes the write to the executor, never to the fixer agent
 *    (load-bearing for the propose-only falsifier — ADR-007 §Decision, item
 *    "executor-actor discipline").
 *
 *  `addWikilink` — Add wikilinks from an orphan note to related notes. Validates
 *    every proposed target resolves before writing (ADR-007 edge case 9).
 *    Appends a "See also" section to the note body if one doesn't exist.
 *    Writes through `engine.updateNote` with the same approval actor.
 *
 *  Both return `{ ok, detail?, error? }` — the approve endpoint surfaces the
 *  detail to the UI and re-enters the row on error.
 */

import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { getVaultEngine } from '$lib/vault/index.js';

export interface PrimitiveResult {
	ok: boolean;
	detail?: string;
	error?: string;
}

/** The actor name stamped on every executor write (ADR-007 §Decision).
 *  Must NEVER match the fixer agent's id — the propose-only falsifier
 *  queries `soul vault writes --agent hygiene-fixer` and asserts zero rows;
 *  using a distinct actor keeps those counts forever-zero. */
const APPROVAL_ACTOR = 'hygiene-remediate';

/** Escape a string for use as a RegExp literal. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Path safety guard: vault-relative, no absolute prefix, no traversal, .md. */
function isSafePath(p: string): boolean {
	if (!p || p.startsWith('/') || !p.endsWith('.md')) return false;
	return !p.split('/').some((seg) => seg === '..' || seg === '.');
}

/** Re-point a broken wikilink to `newTarget` in `source`.
 *
 *  Handles all four forms:
 *    [[raw]]          → [[newTarget]]
 *    [[raw|alias]]    → [[newTarget|alias]]  (alias preserved — edge case 10)
 *
 *  Pre-write validation:
 *   - newTarget must exist on disk (ADR-007 edge case 9 analogue for retarget)
 *   - source must exist and contain the expected wikilink
 *
 *  Write path: engine.updateNote with actor='hygiene-remediate'.
 */
export async function retargetWikilink(
	source: string,
	raw: string,
	newTarget: string,
): Promise<PrimitiveResult> {
	if (!isSafePath(source)) return { ok: false, error: 'invalid-source' };
	if (!newTarget || newTarget.includes('..')) return { ok: false, error: 'invalid-new-target' };
	if (raw.includes('[[') || raw.includes(']]')) {
		return { ok: false, error: 'invalid-raw', detail: 'raw must be inner text, not bracketed' };
	}

	const engine = getVaultEngine();
	if (!engine) return { ok: false, error: 'engine-unavailable' };

	// Pre-write: validate the new target exists in the vault index.
	if (!engine.getNote(newTarget)) {
		// Try resolving by slug (the fixer might use a short slug, not the full path)
		const resolved = engine.resolveLink(newTarget, source);
		if (!resolved) {
			return {
				ok: false,
				error: 'new-target-not-found',
				detail: `${newTarget} does not exist in the vault`,
			};
		}
		// Use the resolved path
		newTarget = resolved;
	}

	// Read the source note body.
	const vaultDir = engine.vaultDir;
	const fullPath = join(vaultDir, source);
	try {
		await access(fullPath);
	} catch {
		return { ok: false, error: 'source-not-found', detail: `${source} missing` };
	}

	const original = await readFile(fullPath, 'utf-8');

	// Replace [[raw]] → [[newTarget]] and [[raw|alias]] → [[newTarget|alias]].
	// The regex matches both forms in a single pass.
	const wikiRegex = new RegExp(
		`\\[\\[${escapeRegex(raw)}(\\|[^\\]]+)?\\]\\]`,
		'g',
	);
	let count = 0;
	const rewritten = original.replace(wikiRegex, (_match, aliasPart) => {
		count++;
		return aliasPart ? `[[${newTarget}${aliasPart}]]` : `[[${newTarget}]]`;
	});

	if (count === 0) {
		return { ok: false, error: 'link-not-found', detail: `[[${raw}]] not found in ${source}` };
	}

	// Write through the engine (ADR-046 chokepoint) with the approval actor.
	const result = await engine.updateNote(
		source,
		{ content: rewritten },
		{ actor: APPROVAL_ACTOR, actorContext: `retarget-link raw=${raw} newTarget=${newTarget}` },
	);

	if (!result.success) {
		return { ok: false, error: 'engine-write-failed', detail: result.error };
	}

	return {
		ok: true,
		detail: `retargeted ${count} × [[${raw}]] → [[${newTarget}]] in ${source}`,
	};
}

/** Add wikilinks from `notePath` to each of `targets`.
 *
 *  Pre-write validation:
 *   - Each target must exist in the vault (ADR-007 edge case 9)
 *   - notePath must exist
 *
 *  Appends a "See also" paragraph at the end of the note body.
 *  If a "See also" section already exists the new links are appended inside it.
 *
 *  Write path: engine.updateNote with actor='hygiene-remediate'.
 */
export async function addWikilinks(
	notePath: string,
	targets: string[],
): Promise<PrimitiveResult> {
	if (!isSafePath(notePath)) return { ok: false, error: 'invalid-path' };
	if (!targets || targets.length === 0) return { ok: false, error: 'empty-targets' };

	const engine = getVaultEngine();
	if (!engine) return { ok: false, error: 'engine-unavailable' };

	// Pre-write: validate every target resolves (edge case 9).
	const resolvedTargets: string[] = [];
	const unresolvable: string[] = [];
	for (const t of targets) {
		if (engine.getNote(t)) {
			resolvedTargets.push(t);
		} else {
			const resolved = engine.resolveLink(t, notePath);
			if (resolved) {
				resolvedTargets.push(resolved);
			} else {
				unresolvable.push(t);
			}
		}
	}

	if (unresolvable.length > 0) {
		return {
			ok: false,
			error: 'unresolvable-targets',
			detail: `These targets do not exist: ${unresolvable.join(', ')} — refusing to mint new broken links`,
		};
	}

	if (resolvedTargets.length === 0) {
		return { ok: false, error: 'no-valid-targets' };
	}

	// Read the current note body.
	const vaultDir = engine.vaultDir;
	const fullPath = join(vaultDir, notePath);
	try {
		await access(fullPath);
	} catch {
		return { ok: false, error: 'note-not-found', detail: `${notePath} missing` };
	}

	const original = await readFile(fullPath, 'utf-8');

	// Build the wikilink strings.
	const linkLine = resolvedTargets.map((t) => `[[${t}]]`).join(', ');

	// Append a "See also" section or extend the existing one.
	let newContent: string;
	const seeAlsoRx = /^## See also\s*$/m;
	if (seeAlsoRx.test(original)) {
		// Insert before the next `## ` heading or at EOF.
		const afterSeeAlso = original.replace(seeAlsoRx, `## See also\n\n${linkLine}`);
		newContent = afterSeeAlso;
	} else {
		// Append at the end.
		const body = original.trimEnd();
		newContent = `${body}\n\n## See also\n\n${linkLine}\n`;
	}

	// Write through the engine with the approval actor.
	const result = await engine.updateNote(
		notePath,
		{ content: newContent },
		{
			actor: APPROVAL_ACTOR,
			actorContext: `add-links targets=${resolvedTargets.join(',')}`,
		},
	);

	if (!result.success) {
		return { ok: false, error: 'engine-write-failed', detail: result.error };
	}

	return {
		ok: true,
		detail: `added ${resolvedTargets.length} link(s) to ${notePath}: ${linkLine}`,
	};
}
