<script lang="ts">
	import { page } from '$app/stores';

	let { children } = $props();

	const NAV: { href: string; label: string; matchPrefix: string }[] = [
		{ href: '/orchestration', label: 'Overview', matchPrefix: '/orchestration' },
		{ href: '/orchestration/agents', label: 'Agents', matchPrefix: '/orchestration/agents' },
		{ href: '/orchestration/skills', label: 'Skills', matchPrefix: '/orchestration/skills' },
		{ href: '/orchestration/tools', label: 'Tools', matchPrefix: '/orchestration/tools' },
		{ href: '/orchestration/metrics', label: 'Metrics', matchPrefix: '/orchestration/metrics' },
		{ href: '/orchestration/audit', label: 'Audit', matchPrefix: '/orchestration/audit' },
		{ href: '/orchestration/intent', label: 'Intent', matchPrefix: '/orchestration/intent' },
		{ href: '/orchestration/models', label: 'Models', matchPrefix: '/orchestration/models' },
		{ href: '/orchestration/heartbeat', label: 'Heartbeat', matchPrefix: '/orchestration/heartbeat' },
		{ href: '/orchestration/hygiene', label: 'Hygiene', matchPrefix: '/orchestration/hygiene' },
	];

	const path = $derived($page.url.pathname);

	function isActive(item: { href: string; matchPrefix: string }): boolean {
		// "Overview" should only match the exact /orchestration path, not its subpages.
		if (item.matchPrefix === '/orchestration') {
			return path === '/orchestration';
		}
		return path === item.matchPrefix || path.startsWith(item.matchPrefix + '/');
	}
</script>

<div class="flex flex-col h-full bg-hub-bg">
	<nav class="flex-shrink-0 border-b border-hub-border">
		<div class="flex items-center gap-1 max-w-6xl mx-auto w-full px-4 sm:px-6 h-9 text-xs overflow-x-auto">
			{#each NAV as item}
				<a
					href={item.href}
					class="px-2 py-1 rounded-md transition-colors whitespace-nowrap hover:bg-hub-card hover:text-hub-text"
					class:text-hub-text={isActive(item)}
					class:bg-hub-card={isActive(item)}
					class:text-hub-muted={!isActive(item)}
				>
					{item.label}
				</a>
			{/each}
		</div>
	</nav>

	<div class="flex-1 overflow-hidden flex flex-col">
		{@render children()}
	</div>
</div>
