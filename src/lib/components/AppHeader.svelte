<script lang="ts">
	import { page } from '$app/stores';
	import type { FeaturesConfig } from '$lib/config.schema';

	let { features }: { features?: FeaturesConfig } = $props();

	// ADR-008 — `feature` tags a nav entry to a visibility flag; entries with no
	// tag always show. An entry is hidden only when its flag is explicitly false
	// (operator default is all-true; the public export seeds them false).
	const NAV: { href: string; label: string; matchPrefix: string; feature?: keyof FeaturesConfig }[] = [
		{ href: '/orchestration', label: 'Orchestration', matchPrefix: '/orchestration' },
		{ href: '/projects', label: 'Projects', matchPrefix: '/projects', feature: 'workspaces' },
		{ href: '/workspaces', label: 'Workspaces', matchPrefix: '/workspace', feature: 'workspaces' },
		{ href: '/inbox', label: 'Inbox', matchPrefix: '/inbox' },
		{ href: '/scheduler', label: 'Scheduler', matchPrefix: '/scheduler' },
		{ href: '/crm', label: 'CRM', matchPrefix: '/crm' },
		{ href: '/naseej', label: 'Naseej', matchPrefix: '/naseej', feature: 'naseej' },
		{ href: '/vault', label: 'Vault', matchPrefix: '/vault' },
		{ href: '/sessions', label: 'Sessions', matchPrefix: '/sessions' },
	];

	const nav = $derived(NAV.filter((item) => !item.feature || features?.[item.feature] !== false));

	const path = $derived($page.url.pathname);

	function isActive(prefix: string): boolean {
		// /workspace prefix matches both /workspaces (list) and /workspace/[name] (detail)
		if (prefix === '/workspace') {
			return path === '/workspaces' || path.startsWith('/workspace/');
		}
		return path === prefix || path.startsWith(prefix + '/');
	}
</script>

<header class="flex-shrink-0 border-b border-hub-border bg-hub-bg/95 backdrop-blur sticky top-0 z-30">
	<div class="flex items-center gap-3 max-w-6xl mx-auto w-full px-4 sm:px-6 h-10">
		<a
			href="/"
			class="flex items-center gap-2 text-hub-text hover:text-hub-info transition-colors -ml-1"
			aria-label="Soul Hub home"
		>
			<img src="/logo.png" alt="" class="w-5 h-5" />
			<span class="text-sm font-semibold tracking-tight">Soul Hub</span>
		</a>

		<div class="h-4 w-px bg-hub-border hidden sm:block"></div>

		<nav class="hidden sm:flex items-center gap-0.5 text-xs flex-1 min-w-0 overflow-x-auto">
			{#each nav as item}
				<a
					href={item.href}
					class="px-2 py-1 rounded-md transition-colors whitespace-nowrap hover:bg-hub-card hover:text-hub-text"
					class:text-hub-text={isActive(item.matchPrefix)}
					class:bg-hub-card={isActive(item.matchPrefix)}
					class:text-hub-muted={!isActive(item.matchPrefix)}
				>
					{item.label}
				</a>
			{/each}
		</nav>

		<div class="flex-1 sm:flex-none"></div>

		<div class="flex items-center gap-1">
			<a
				href="/terminal"
				class="p-1.5 rounded-md text-hub-dim hover:text-hub-text hover:bg-hub-card transition-colors"
				aria-label="Terminal"
				title="Terminal"
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
				</svg>
			</a>
			<a
				href="/settings"
				class="p-1.5 rounded-md text-hub-dim hover:text-hub-text hover:bg-hub-card transition-colors"
				class:text-hub-text={path === '/settings'}
				class:bg-hub-card={path === '/settings'}
				aria-label="Settings"
				title="Settings"
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="3"/>
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
				</svg>
			</a>
		</div>
	</div>

	<!-- Mobile sub-nav: only shows on small screens, scrollable -->
	<nav class="sm:hidden flex items-center gap-0.5 px-2 pb-2 text-xs overflow-x-auto scrollbar-thin">
		{#each nav as item}
			<a
				href={item.href}
				class="px-2 py-1 rounded-md transition-colors whitespace-nowrap"
				class:text-hub-text={isActive(item.matchPrefix)}
				class:bg-hub-card={isActive(item.matchPrefix)}
				class:text-hub-muted={!isActive(item.matchPrefix)}
			>
				{item.label}
			</a>
		{/each}
	</nav>
</header>
