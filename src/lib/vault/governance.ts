import { readdir, readFile } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import type { VaultZone } from './types.js';
import { IGNORED_FOLDERS } from './types.js';

export class GovernanceResolver {
	private zones = new Map<string, VaultZone>();

	async scan(vaultRoot: string): Promise<void> {
		this.zones.clear();
		const claudeFiles = await findClaudeMdFiles(vaultRoot, vaultRoot);
		for (const absPath of claudeFiles) {
			const raw = await readFile(absPath, 'utf-8');
			const zonePath = relative(vaultRoot, dirname(absPath));
			const zone = parseGovernance(zonePath, raw);
			this.zones.set(zonePath, zone);
		}
	}

	resolve(targetPath: string): VaultZone {
		const parts = targetPath.split('/');
		// Walk from most specific to least specific (include full path).
		// The most-specific zone defines `allowedTypes`/`requiredFields`/
		// `namingPattern`/`requireTemplate` (existing behavior — child fully
		// overrides parent). For the canonical-set rules added in Phase 3a
		// enforcement (`allowedStatuses`, `allowedRelationshipFields`), the
		// child INHERITS the parent's rule when it doesn't define its own —
		// so a project-specific CLAUDE.md doesn't silently disable vault-wide
		// canonical-set governance.
		const chain: VaultZone[] = [];
		for (let i = parts.length; i >= 0; i--) {
			const candidate = parts.slice(0, i).join('/');
			const zone = this.zones.get(candidate);
			if (zone) chain.push(zone);
		}

		if (chain.length === 0) {
			return {
				path: '',
				allowedTypes: [],
				requireTemplate: false,
				requiredFields: [],
				allowedStatuses: [],
				allowedStatusesScope: 'decisions-only',
				allowedRelationshipFields: [],
				allowedProjectShapes: [],
				rawGovernance: ''
			};
		}

		const child = chain[0];
		// Walk parent → root for the inheriting fields. First non-empty wins.
		const inheritedStatuses = chain.find((z) => z.allowedStatuses.length > 0)?.allowedStatuses ?? [];
		const inheritedRelationships = chain.find((z) => z.allowedRelationshipFields.length > 0)?.allowedRelationshipFields ?? [];
		const inheritedProjectShapes = chain.find((z) => z.allowedProjectShapes.length > 0)?.allowedProjectShapes ?? [];
		// projects-graph ADR-002 — scope sentinel. First explicit declaration
		// in the chain wins; absent on every level defaults to decisions-only.
		// Parsed from CLAUDE.md `## Allowed Statuses Scope` (single-value
		// section); raw value normalised in parseGovernance.
		const inheritedScope =
			chain.find((z) => z.allowedStatusesScope !== 'decisions-only')?.allowedStatusesScope ?? 'decisions-only';

		return {
			...child,
			allowedStatuses: inheritedStatuses,
			allowedStatusesScope: inheritedScope,
			allowedRelationshipFields: inheritedRelationships,
			allowedProjectShapes: inheritedProjectShapes,
		};
	}

	getZones(): VaultZone[] {
		return Array.from(this.zones.values());
	}
}

async function findClaudeMdFiles(dir: string, vaultRoot: string): Promise<string[]> {
	const results: string[] = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return results;
	}

	for (const entry of entries) {
		if (IGNORED_FOLDERS.includes(entry.name)) continue;

		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...(await findClaudeMdFiles(fullPath, vaultRoot)));
		} else if (entry.name === 'CLAUDE.md') {
			results.push(fullPath);
		}
	}

	return results;
}

function parseGovernance(zonePath: string, raw: string): VaultZone {
	const allowedTypes = extractListSection(raw, 'Allowed Types', zonePath);
	const requiredFields = extractListSection(raw, 'Required Fields', zonePath);
	// Optional sections — empty array means "no rule for this zone".
	// Date fields are NOT enforced (canonical names live in the learning
	// note); we only enforce status + relationship-field format.
	// `extractFieldNames` strips trailing descriptions and backticks so
	// bullets like `- \`supersedes\` — this ADR replaces another` parse
	// correctly to just `supersedes`.
	const allowedStatuses = extractFieldNames(raw, 'Allowed Statuses');
	const allowedRelationshipFields = extractFieldNames(raw, 'Allowed Relationship Fields');
	// projects-graph ADR-001 — `project_shape:` enum for project-root index.md
	// notes. Same parsing rule as Allowed Statuses (each bullet's leading
	// identifier; trailing prose stripped).
	const allowedProjectShapes = extractFieldNames(raw, 'Allowed Project Shapes');
	// projects-graph ADR-002 — scope sentinel; single-value section. Default
	// 'decisions-only' preserves the pre-ADR-002 behaviour (canonical-status
	// check applies only to `type: decision`). 'all-types' broadens to every
	// note in the zone with a `status:` field.
	const allowedStatusesScope = extractScope(raw);
	const namingPattern = extractNamingPattern(raw);
	const requireTemplate =
		/template\s+.*(?:required|MUST\s+use)/i.test(raw) ||
		/(?:required|MUST\s+use)\s+.*template/i.test(raw);

	if (allowedTypes.length === 0 && requiredFields.length === 0 && !namingPattern && !requireTemplate) {
		console.warn(`[vault/governance] Zone "${zonePath}": CLAUDE.md has no recognized governance sections`);
	}

	return {
		path: zonePath,
		allowedTypes,
		requireTemplate,
		requiredFields,
		namingPattern: namingPattern ?? undefined,
		allowedStatuses,
		allowedStatusesScope,
		allowedRelationshipFields,
		allowedProjectShapes,
		rawGovernance: raw
	};
}

/** projects-graph ADR-002 — parse `## Allowed Statuses Scope` from CLAUDE.md.
 *  Single-value section; reads the first non-empty line under the heading
 *  and matches it against the two known values. Unknown / absent → defaults
 *  to 'decisions-only' (pre-ADR-002 behaviour). */
function extractScope(raw: string): 'decisions-only' | 'all-types' {
	const pattern = /^##\s+Allowed\s+Statuses\s+Scope\s*$/im;
	const match = pattern.exec(raw);
	if (!match) return 'decisions-only';
	const after = raw.slice(match.index + match[0].length);
	const next = after.search(/^##\s+/m);
	const block = (next === -1 ? after : after.slice(0, next)).trim();
	const firstLine = block.split('\n').find((l) => l.trim() && !l.trim().startsWith('<!--'));
	if (!firstLine) return 'decisions-only';
	const value = firstLine.replace(/^[-*`\s]+|[`\s]+$/g, '').toLowerCase();
	if (value === 'all-types') return 'all-types';
	return 'decisions-only';
}

function extractListSection(raw: string, heading: string, zonePath?: string): string[] {
	const pattern = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
	const match = pattern.exec(raw);
	if (!match) return [];

	const afterHeading = raw.slice(match.index + match[0].length);
	const nextSection = afterHeading.search(/^##\s+/m);
	const block = nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection);
	const trimmed = block.trim();

	if (trimmed === '') {
		console.warn(`[vault/governance] Zone "${zonePath}": section "${heading}" is empty`);
		return [];
	}

	// Handle bullet lists: - item or * item
	const bullets = trimmed.match(/^[-*]\s+(.+)$/gm);
	if (bullets) {
		return bullets.map((b) => b.replace(/^[-*]\s+/, '').trim()).filter(Boolean);
	}

	// Handle comma-separated on a single line
	return trimmed
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Extract a list of field names from a CLAUDE.md section. Like
 *  `extractListSection` but each bullet's value is reduced to just the
 *  leading identifier — strips backticks, dashes, em-dashes, and any
 *  trailing description prose so bullets like
 *    - `supersedes` — this ADR replaces another
 *  return just `supersedes`. */
function extractFieldNames(raw: string, heading: string): string[] {
	const lines = extractListSection(raw, heading);
	const names: string[] = [];
	for (const line of lines) {
		// Strip leading/trailing backticks; take only the first whitespace-
		// or punctuation-delimited token. Permissive about separators because
		// authors use both `—` and `-` and `:`.
		const m = line.match(/^[`\s]*([A-Za-z][A-Za-z0-9_-]*)/);
		if (m && m[1]) names.push(m[1]);
	}
	return names;
}

function extractNamingPattern(raw: string): string | null {
	const pattern = /^##\s+Naming\s*$/im;
	const match = pattern.exec(raw);
	if (!match) return null;

	const afterHeading = raw.slice(match.index + match[0].length);
	const nextSection = afterHeading.search(/^##\s+/m);
	const block = nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection);
	const trimmed = block.trim();

	// Only extract patterns that look like real regex (start with ^ or contain character classes)
	const backtick = /`([^`]+)`/.exec(trimmed);
	const candidate = backtick?.[1] ?? trimmed.split('\n')[0]?.trim();
	if (!candidate) return null;

	// Only accept actual regex patterns (must start with ^ for anchoring)
	if (candidate.startsWith('^')) {
		try {
			new RegExp(candidate);
			return candidate;
		} catch {
			console.warn(`[vault/governance] Invalid naming pattern regex: ${candidate}`);
			return null;
		}
	}

	return null;
}
