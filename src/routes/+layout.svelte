<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import ChatDrawer from '$lib/components/chat/ChatDrawer.svelte';

	let { children, data } = $props();

	// Routes that opt out of the global header and chat drawer — full-screen /
	// centered-card layouts where the chrome would either eat into critical
	// viewport real estate (terminal, vault graph mode) or visually clash with
	// the page's own framing (centered onboarding cards).
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
		<AppHeader features={data.features} update={data.update} />
	{/if}
	<div class="flex-1 min-h-0 overflow-hidden">
		{@render children()}
	</div>
	<!--
		ADR-004 — Chat drawer: bottom-docked flex-shrink-0 member of the root column.
		Hidden on opt-out routes (terminal, setup, new) that own their full viewport.
		The AdrDrawer (right-side, z-50) and this bottom surface do not compete:
		the drawer is in the flex flow (no fixed positioning) so its height is
		deducted from the content area rather than overlaying it.
	-->
	{#if showHeader}
		<ChatDrawer />
	{/if}
</div>
