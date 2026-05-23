/**
 * project-phases ADR-008 S1 — extractLinkedProjects.
 *
 * Given a JSONL transcript, returns the unique sorted list of vault
 * project slugs the session touched. Detection rules per ADR-008 D3:
 *
 *   - Any `~/vault/projects/<slug>/...` path mentioned in tool_use args
 *     or text blocks
 *   - Any `POST /api/vault/projects/<slug>/...` URL in a Bash tool_use
 *   - Any `projectShipSlice` orchestrator tool invocation with a
 *     `project_slug` argument (visible in transcript even though
 *     server-side)
 *
 * Output is stored as a JSON-array TEXT column on `assumption_audits.linked_projects`
 * (ADR-008 D3 round-3 lock-in: one row per audit, projects in JSON array).
 */

const VAULT_PROJECT_PATH_RE = /(?:~\/vault|\/Users\/[^/]+\/vault|vault)\/projects\/([a-z0-9][a-z0-9-]+)\//g;
const VAULT_PROJECT_API_RE = /\/api\/vault\/projects\/([a-z0-9][a-z0-9-]+)(?:\/|\?|"|'|\b)/g;
const SLICE_TOOL_RE = /"project_slug"\s*:\s*"([a-z0-9][a-z0-9-]+)"/g;

export function extractLinkedProjects(jsonlContent: string): string[] {
	const slugs = new Set<string>();

	// API endpoint path-segments that share the `/api/vault/projects/<x>` shape
	// but are NOT project slugs (verified against soul-hub routes 2026-05-17).
	const NON_SLUG_API_SEGMENTS = new Set(['similar']);
	const NON_SLUG_VAULT_SEGMENTS = new Set(['index', 'inbox', 'archive']);

	const add = (s: string | undefined) => {
		if (!s) return;
		if (NON_SLUG_VAULT_SEGMENTS.has(s) || NON_SLUG_API_SEGMENTS.has(s)) return;
		if (s.startsWith('adr-')) return;
		slugs.add(s);
	};

	for (const re of [VAULT_PROJECT_PATH_RE, VAULT_PROJECT_API_RE, SLICE_TOOL_RE]) {
		re.lastIndex = 0;
		for (;;) {
			const m = re.exec(jsonlContent);
			if (!m) break;
			add(m[1]);
		}
	}

	return [...slugs].sort();
}
