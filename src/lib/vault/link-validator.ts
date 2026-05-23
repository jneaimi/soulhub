/** ADR-047 — Wikilink validation at the vault API.
 *
 *  Runs at write time inside `createNote`/`updateNote`, before the
 *  atomic write. Classifies every `[[…]]` in the body into one of:
 *
 *    - `auto-memory-wikilink` — basename matches `(feedback|project|user|reference)_*`.
 *      These reference per-machine auto-memory files outside the vault and will
 *      never resolve. REFUSE — use inline backticks for the slug instead.
 *    - `bare-project-slug` — single-segment slug where `projects/<slug>/index.md`
 *      exists. The resolver does fall back to the index, but the form is brittle.
 *      REFUSE with the corrected `[[slug/index]]` form. Operators can escape via
 *      the alias syntax `[[naseej/index|naseej]]` when they want the bare display.
 *    - `unresolved-target` — resolver returns null AND the link is not external.
 *      Default: WARN (forward refs are legitimate — operator writes index.md
 *      before children). REFUSE only when `opts.strict` is set.
 *
 *  The validator is a pure function — takes the body + a resolver + a
 *  `hasNote` probe and returns `{ errors, warnings }`. The engine
 *  pushes `has-link-warnings` onto the frontmatter tags when warnings
 *  fire (so the hygiene tick gets a precise bucket).
 *
 *  Externals (URLs, asset embeds) are skipped — same posture as the
 *  indexer's unresolved counter.
 */

import { extractLinks } from './parser.js';
import { WikilinkResolver } from './resolver.js';
import type { LinkIssue } from './types.js';

export type LinkRule = LinkIssue['rule'];
export type { LinkIssue };

export interface LinkValidationResult {
	errors: LinkIssue[];
	warnings: LinkIssue[];
}

export interface ValidateLinksOptions {
	/** The vault-relative path the content will live at. Needed for the
	 *  resolver's relative-path + closest-source disambiguation. */
	sourcePath: string;
	/** When set, `unresolved-target` is escalated from warning to error. */
	strict?: boolean;
	/** Probe for whether a vault path exists in the index. Bare-project-slug
	 *  detection calls `hasNote('projects/<slug>/index.md')`. */
	hasNote: (path: string) => boolean;
	/** Resolver used to classify `unresolved-target`. Also used to detect
	 *  externals so URL/asset embeds aren't false-flagged. */
	resolver: Pick<InstanceType<typeof WikilinkResolver>, 'resolve'>;
}

/** Auto-memory filenames live at `~/.claude/projects/.../memory/` and never resolve
 *  in the vault. Match conservatively: `<prefix>_<snake_or_kebab>` where prefix is
 *  one of feedback / project / user / reference (the four categories from CLAUDE.md
 *  auto-memory rules). Allow `_` and `-` in the tail so both naming conventions
 *  hit the rule. */
const AUTO_MEMORY_RE = /^(?:feedback|project|user|reference)_[a-z][a-z0-9_-]*$/;

/** Bare project slug = single segment, lowercase + digits + hyphen, no path
 *  separator, no extension. Conservative shape avoids false positives on
 *  multi-segment links and on ad-hoc identifiers with weird characters. */
const BARE_SLUG_RE = /^[a-z][a-z0-9-]+$/;

export function validateLinks(
	content: string,
	opts: ValidateLinksOptions,
): LinkValidationResult {
	const errors: LinkIssue[] = [];
	const warnings: LinkIssue[] = [];
	const seenError = new Set<string>();
	const seenWarning = new Set<string>();

	const links = extractLinks(content);
	for (const link of links) {
		if (link.embed) continue; // image/asset embeds are out of scope
		const raw = link.raw.trim();
		if (!raw) continue;

		// 1. Auto-memory wikilink — unconditional refuse. Checked first because
		//    auto-memory slugs would also trip "unresolved" (they don't exist
		//    in the vault) and we want the more specific rule name.
		if (AUTO_MEMORY_RE.test(raw)) {
			if (!seenError.has(`am:${raw}`)) {
				seenError.add(`am:${raw}`);
				errors.push({
					rule: 'auto-memory-wikilink',
					link: raw,
					suggestion:
						`Wikilinks to auto-memory filenames are forbidden (CLAUDE.md). Use inline backticks: \`${raw}\``,
				});
			}
			continue;
		}

		// 2. Bare project slug — only fires when the literal slug matches a
		//    project directory's index.md. Single-segment + lowercase shape
		//    keeps false positives low; the operator-curated alias escape
		//    handles the rare prose-quoting case.
		if (BARE_SLUG_RE.test(raw) && opts.hasNote(`projects/${raw}/index.md`)) {
			if (!seenError.has(`bps:${raw}`)) {
				seenError.add(`bps:${raw}`);
				errors.push({
					rule: 'bare-project-slug',
					link: raw,
					suggestion:
						`Project references must use \`[[${raw}/index]]\` (or \`[[${raw}/index|${raw}]]\` to preserve the bare display).`,
				});
			}
			continue;
		}

		// 3. Unresolved target — last resort, lowest specificity. Default warn,
		//    refuse only when caller passes strict.
		const resolved = opts.resolver.resolve(raw, opts.sourcePath);
		if (resolved === null) {
			const issue: LinkIssue = {
				rule: 'unresolved-target',
				link: raw,
				suggestion:
					`No vault note matches \`[[${raw}]]\`. Fix the slug, create the target, or remove the link.`,
			};
			if (opts.strict) {
				if (!seenError.has(`ur:${raw}`)) {
					seenError.add(`ur:${raw}`);
					errors.push(issue);
				}
			} else {
				if (!seenWarning.has(`ur:${raw}`)) {
					seenWarning.add(`ur:${raw}`);
					warnings.push(issue);
				}
			}
		}
		// resolved === 'external' or a real path → ok
	}

	return { errors, warnings };
}
