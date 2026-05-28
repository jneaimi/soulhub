/**
 * ADR-011 — Internal page catalog (S1).
 *
 * Static manifest of every Soul Hub page the orchestrator can navigate to or
 * describe. Lives here (not in the route tree) so the server can reference it
 * without importing any Svelte module.
 *
 * Maintenance policy: whenever a new top-level route is added, add an entry
 * here. The `navigateTo` tool's lint check (validateCatalogRoutes) confirms
 * that every route in this catalog actually exists on disk — run
 * `npm run check` to catch drift.
 *
 * Route templates use SvelteKit's `[param]` syntax. The `matchesRoute`
 * helper handles dynamic segments when validating a concrete path.
 */

/** Which ChatScope kind is registered on this page (ADR-002 / ADR-006). */
export type CatalogScopeKind =
	| 'project'
	| 'vault-note'
	| 'inbox-thread'
	| 'crm-contact'
	| 'global';

export interface PageEntry {
	/** Path template in SvelteKit format, e.g. `/projects/[slug]`. */
	route: string;
	/** Human-readable page title. */
	title: string;
	/** What the operator does on this page — used in `describeCurrentPage`. */
	description: string;
	/** Which ChatScope kind this page registers (ADR-002/ADR-006). */
	scopeKind: CatalogScopeKind;
	/** Short list of capabilities available to chat on this page. */
	capabilities: string[];
	/**
	 * Supported deep-link params for S7. Each key maps to a query-string
	 * parameter the page reads — e.g. `{ note: 'notePath' }` means
	 * `?note=<notePath>` pre-selects a vault note.
	 */
	deepLinkParams?: Record<string, string>;
}

/**
 * Static manifest of Soul Hub's navigable pages.
 *
 * Order: most-commonly-referenced first (keeps model output concise when the
 * LLM is asked to pick from the list without seeing route-existence context).
 */
export const PAGE_CATALOG: PageEntry[] = [
	{
		route: '/',
		title: 'Home',
		description:
			'The main dashboard. Shows a high-level overview of recent activity across all areas.',
		scopeKind: 'global',
		capabilities: [
			'Navigate to any Soul Hub section',
			'Ask about recent activity across projects, inbox, and CRM',
			'Get a summary of pending work',
		],
	},
	{
		route: '/projects',
		title: 'Projects',
		description:
			'Project list. Browse and manage all active projects with their ADRs and falsifiers.',
		scopeKind: 'global',
		capabilities: [
			'Browse all projects',
			'Navigate to a specific project',
			'Propose a new ADR',
			'Check which projects have open falsifiers',
		],
	},
	{
		route: '/projects/[slug]',
		title: 'Project detail',
		description:
			'Detail view for a specific project — ADRs, falsifiers, notes, and related agents.',
		scopeKind: 'project',
		capabilities: [
			'Read open ADRs and their slices',
			'Propose a new ADR or slice',
			'Mark a slice as shipped',
			'Describe the current project context',
			'Navigate to the project vault notes',
		],
		deepLinkParams: {
			adr: 'adr',
		},
	},
	{
		route: '/vault',
		title: 'Vault viewer',
		description:
			'Browse and read the knowledge vault. Supports note selection, search, and wikilink navigation.',
		scopeKind: 'vault-note',
		capabilities: [
			'Search and read vault notes',
			'Save a new note to the vault',
			'Navigate to a specific note by path',
			'Describe the focused note context',
		],
		deepLinkParams: {
			note: 'note',
		},
	},
	{
		route: '/inbox',
		title: 'Inbox',
		description:
			'Inbox — IMAP-synced email messages filtered and queued for agent review.',
		scopeKind: 'inbox-thread',
		capabilities: [
			'List queued inbox messages',
			'Drill into a specific message',
			'Mark messages as processed',
			'Correct classification errors',
			'Extract transactional data from receipts',
		],
	},
	{
		route: '/crm',
		title: 'CRM',
		description:
			'Personal Brand CRM — pipeline, contacts, follow-ups, and interaction history.',
		scopeKind: 'crm-contact',
		capabilities: [
			'Find a contact by name, email, or phone',
			'Log an interaction',
			'Move a contact through pipeline stages',
			'Set a follow-up reminder',
			'Add a new contact',
		],
		deepLinkParams: {
			id: 'id',
		},
	},
	{
		route: '/scheduler',
		title: 'Scheduler',
		description:
			'Task scheduler — manage recurring agent jobs, heartbeat tasks, and one-time reminders.',
		scopeKind: 'global',
		capabilities: [
			'View scheduled tasks',
			'Schedule a one-time reminder',
			'Check heartbeat status',
			'Browse reminder history',
		],
	},
	{
		route: '/orchestration',
		title: 'Orchestration',
		description:
			'Orchestration dashboard — agents, tools, metrics, and model analytics.',
		scopeKind: 'global',
		capabilities: [
			'View agent registry and health',
			'Check tool latency and usage',
			'Review model A/B branch metrics',
			'Inspect intent routing analytics',
		],
	},
	{
		route: '/orchestration/agents',
		title: 'Agents',
		description: 'Agent registry — browse, test, and manage all registered agents.',
		scopeKind: 'global',
		capabilities: [
			'Browse agent definitions',
			'Test an agent',
			'Check agent run history',
			'Edit agent configuration',
		],
	},
	{
		route: '/orchestration/tools',
		title: 'Tools',
		description:
			'Tool catalog — live list of orchestrator tools with descriptions and usage stats.',
		scopeKind: 'global',
		capabilities: [
			'Browse all available tools',
			'Check tool usage and latency',
			'Review tool descriptions and examples',
		],
	},
	{
		route: '/orchestration/skills',
		title: 'Skills',
		description: 'Skill registry — browse and enable chat-invokable skills.',
		scopeKind: 'global',
		capabilities: [
			'Browse installed skills',
			'Enable or disable a skill',
			'Install a new skill',
		],
	},
	{
		route: '/orchestration/metrics',
		title: 'Metrics',
		description: 'Orchestrator metrics — cost, token usage, and A/B branch analytics.',
		scopeKind: 'global',
		capabilities: ['View cost breakdown by branch', 'Check daily token spend'],
	},
	{
		route: '/orchestration/intent',
		title: 'Intent analytics',
		description: 'Intent routing log and analytics dashboard.',
		scopeKind: 'global',
		capabilities: ['Browse intent routing history', 'Filter by tool or confidence'],
	},
	{
		route: '/orchestration/heartbeat',
		title: 'Heartbeat',
		description: 'Heartbeat configuration and status — active hours, mute windows, channels.',
		scopeKind: 'global',
		capabilities: ['Check heartbeat status', 'Review active hours and mute windows'],
	},
	{
		route: '/playbooks',
		title: 'Playbooks',
		description:
			'Playbooks — authored multi-step workflows the orchestrator can trigger on request.',
		scopeKind: 'global',
		capabilities: [
			'Browse available playbooks',
			'Trigger a playbook by name',
			'Build a new playbook',
		],
	},
	{
		route: '/sessions',
		title: 'Sessions',
		description: 'Active and past PTY + agent sessions across all scopes.',
		scopeKind: 'global',
		capabilities: [
			'Browse session history',
			'Check which sessions are still alive',
			'Resume a past Claude session',
		],
	},
	{
		route: '/files',
		title: 'Files',
		description: 'File browser for the Soul Hub data directory and generated media.',
		scopeKind: 'global',
		capabilities: ['Browse generated files', 'Preview media assets'],
	},
	{
		route: '/terminal',
		title: 'Terminal',
		description: 'Standalone server-side terminal — a persistent bash session in the repo.',
		scopeKind: 'global',
		capabilities: [
			'Run shell commands',
			'Start a development server',
			'Execute build scripts',
		],
	},
	{
		route: '/settings',
		title: 'Settings',
		description:
			'Soul Hub settings — WhatsApp, channels, media, inbox, and feature flags.',
		scopeKind: 'global',
		capabilities: [
			'Configure WhatsApp and Telegram channels',
			'Adjust image and media generation settings',
			'Manage inbox auto-routing',
			'Toggle feature flags',
		],
	},
	{
		route: '/workspaces',
		title: 'Workspaces',
		description:
			'Workspaces — named scopes that group sessions, notes, and agents for a context.',
		scopeKind: 'global',
		capabilities: ['Browse workspaces', 'Open a workspace', 'Create a new workspace'],
	},
	{
		route: '/setup',
		title: 'Setup',
		description: 'Initial setup wizard — configure channels, vault path, and integrations.',
		scopeKind: 'global',
		capabilities: ['Configure initial settings', 'Connect WhatsApp QR code'],
	},
	{
		route: '/naseej',
		title: 'Naseej portal',
		description:
			'Naseej project portal — brands, documents, and audit tools for the Naseej account.',
		scopeKind: 'global',
		capabilities: [
			'Browse Naseej brands',
			'Review documents',
			'Run audit checks',
			'Navigate to a specific brand or document',
		],
	},
];

// ── Lookup helpers ────────────────────────────────────────────────────────────

/**
 * Check whether a concrete path (e.g. `/projects/naseej`) matches a catalog
 * route template (e.g. `/projects/[slug]`). Dynamic segments (`[param]`) match
 * any non-empty, non-slash segment.
 */
function matchesRoute(template: string, path: string): boolean {
	// Build a regex from the route template:
	// 1. Escape regex special chars that are NOT `[` or `]` (those are handled next).
	// 2. Replace SvelteKit `[param]` segments with `[^/]+` (any non-slash segment).
	const pattern =
		'^' +
		template
			.replace(/[.*+?^${}()|\\]/g, '\\$&') // escape . * + ? ^ $ { } ( ) | \
			.replace(/\[[^\]]+\]/g, '[^/]+') +   // [param] → [^/]+
		'$';
	return new RegExp(pattern).test(path);
}

/**
 * Find the catalog entry that best matches a concrete path.
 * Returns the MOST SPECIFIC match (shortest template — exact routes beat
 * dynamic ones when both would match, e.g. `/projects/queue` beats
 * `/projects/[slug]`).
 *
 * Returns `undefined` when no template matches.
 */
export function findCatalogEntry(path: string): PageEntry | undefined {
	// Normalise: strip trailing slash (except bare `/`), strip query string.
	const normalised = path.replace(/\?.*$/, '').replace(/\/+$/, '') || '/';

	let best: PageEntry | undefined;
	let bestSpecificity = -1; // higher template specificity → fewer dynamic segments

	for (const entry of PAGE_CATALOG) {
		if (!matchesRoute(entry.route, normalised)) continue;
		// Specificity = total chars minus the number of dynamic segments (more
		// static chars = more specific). Exact match always wins.
		const dynamicCount = (entry.route.match(/\[[^\]]+\]/g) ?? []).length;
		const specificity = entry.route.length - dynamicCount * 10;
		if (specificity > bestSpecificity) {
			best = entry;
			bestSpecificity = specificity;
		}
	}
	return best;
}

/**
 * Build a full URL for navigateTo — combines the concrete `path` with optional
 * deep-link query params (S7). External URLs are rejected at the tool level
 * before this is called.
 *
 * @param path  - Concrete path, e.g. `/projects/naseej` or `/vault`.
 * @param params - Optional deep-link params, e.g. `{ note: 'projects/foo.md' }`.
 */
export function buildNavigateUrl(path: string, params?: Record<string, string>): string {
	const base = path.replace(/\?.*$/, '').replace(/\/+$/, '') || '/';
	if (!params || Object.keys(params).length === 0) return base;
	const qs = new URLSearchParams(params).toString();
	return `${base}?${qs}`;
}

/**
 * Format the page catalog as a human-readable list for the `listPages` tool.
 * Returns one bullet per page with its title and description.
 */
export function formatCatalogList(): string {
	const lines = PAGE_CATALOG.map(
		(e) => `- **${e.title}** (\`${e.route}\`): ${e.description}`,
	);
	return `Soul Hub pages (${PAGE_CATALOG.length} total):\n${lines.join('\n')}`;
}

/**
 * Format a single page entry as a contextual description for `describeCurrentPage`.
 * Combines the catalog metadata with a scope-specific identifier when available.
 */
export function formatPageDescription(
	entry: PageEntry,
	scopeParams?: Record<string, string>,
): string {
	const slug = scopeParams?.slug ?? scopeParams?.notePath ?? scopeParams?.contactId ?? '';
	const titleSuffix = slug ? ` — ${slug}` : '';
	const capList = entry.capabilities.map((c) => `  - ${c}`).join('\n');
	return (
		`**Current page: ${entry.title}${titleSuffix}**\n\n` +
		`${entry.description}\n\n` +
		`**What chat can do here:**\n${capList}`
	);
}
