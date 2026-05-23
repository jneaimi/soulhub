<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import AppHeader from '$lib/components/AppHeader.svelte';

	let { children, data } = $props();

	// Routes that opt out of the global header — full-screen / centered-card layouts
	// where the chrome would either eat into critical viewport real estate (terminal,
	// vault graph mode) or visually clash with the page's own framing (centered onboarding cards).
	const HEADER_OPT_OUT_PREFIXES = ['/terminal', '/setup', '/new'];

	const showHeader = $derived.by(() => {
		const path = $page.url.pathname;
		return !HEADER_OPT_OUT_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
	});
</script>

<svelte:head>
	<title>Soul Hub</title>
</svelte:head>

<div class="h-screen overflow-hidden bg-hub-bg flex flex-col">
	{#if showHeader}
		<AppHeader features={data.features} />
	{/if}
	<div class="flex-1 min-h-0 overflow-hidden">
		{@render children()}
	</div>
</div>
