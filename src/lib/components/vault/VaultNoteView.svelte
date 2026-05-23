<script lang="ts">
	import type { VaultNote } from '$lib/vault/types';
	import { TYPE_COLORS } from '$lib/vault/types';
	import VaultAttachments from './VaultAttachments.svelte';
	import CrmSenderCard from './CrmSenderCard.svelte';
	import EmailDraftCard from './EmailDraftCard.svelte';

	interface Props {
		note: VaultNote & { rendered?: string; contentIsRtl?: boolean; titleIsRtl?: boolean };
		vaultDir?: string;
		onNavigate: (path: string) => void;
		onEdit: () => void;
		onArchive: () => void;
		onLocalGraph?: () => void;
	}

	let { note, vaultDir = '', onNavigate, onEdit, onArchive, onLocalGraph }: Props = $props();

	const noteFolder = $derived(
		note.path.includes('/') ? note.path.substring(0, note.path.lastIndexOf('/')) : ''
	);
	const noteFilename = $derived(note.path.split('/').pop() || note.path);

	const downloadUrl = $derived(
		vaultDir
			? `/api/files?path=${encodeURIComponent(vaultDir + '/' + note.path.substring(0, note.path.lastIndexOf('/')))}&action=raw&file=${encodeURIComponent(note.path.split('/').pop() || '')}`
			: ''
	);

	let confirmingArchive = $state(false);

	const zone = $derived(note.path.split('/')[0] || '');
	const typeColor = $derived(TYPE_COLORS[note.meta.type ?? ''] || '#6b7280');

	function timeAgo(mtime: number): string {
		const seconds = Math.floor((Date.now() - mtime) / 1000);
		if (seconds < 60) return 'just now';
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
		if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
		return new Date(mtime).toLocaleDateString();
	}

	function handleContentClick(e: MouseEvent) {
		const target = e.target as HTMLElement;
		const wikilink = target.closest('.vault-wikilink') as HTMLElement | null;
		if (wikilink) {
			e.preventDefault();
			const linkTarget = wikilink.dataset.target;
			if (linkTarget) onNavigate(linkTarget);
			return;
		}
		const attachment = target.closest('[data-vault-attachment]') as HTMLElement | null;
		if (attachment) {
			e.preventDefault();
			const absPath = attachment.dataset.vaultAttachmentPath;
			if (absPath) onNavigate(`__file__:${absPath}`);
		}
	}

	function handleArchiveClick() {
		if (confirmingArchive) {
			onArchive();
			confirmingArchive = false;
		} else {
			confirmingArchive = true;
			setTimeout(() => { confirmingArchive = false; }, 3000);
		}
	}

	const resolvedLinks = $derived(note.links.filter(l => l.resolved));
	const unresolvedLinks = $derived(note.links.filter(l => !l.resolved));
</script>

<div class="flex flex-col gap-4">
	<!-- Header bar -->
	<div class="flex items-center gap-3 flex-wrap">
		<button
			onclick={() => onNavigate('')}
			class="text-hub-muted hover:text-hub-text text-sm transition-colors"
		>
			&larr; Back
		</button>

		{#if note.meta.type}
			<span
				class="px-2 py-0.5 rounded text-xs font-medium text-white"
				style="background-color: {typeColor}"
			>
				{note.meta.type}
			</span>
		{/if}

		<span class="text-hub-dim text-sm">
			{zone}{zone ? ' / ' : ''}{note.path}
		</span>

		<div class="ml-auto flex items-center gap-2">
			{#if onLocalGraph}
				<button
					onclick={onLocalGraph}
					class="px-3 py-1 text-sm rounded bg-hub-card text-hub-muted hover:text-hub-text transition-colors flex items-center gap-1.5"
					title="Show ego graph (depth 2) around this note"
				>
					<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<circle cx="6" cy="6" r="2" stroke-width="2"/>
						<circle cx="18" cy="18" r="2" stroke-width="2"/>
						<circle cx="6" cy="18" r="2" stroke-width="2"/>
						<circle cx="18" cy="6" r="2" stroke-width="2"/>
						<path stroke-linecap="round" stroke-width="2" d="M7.5 7.5l9 9M16.5 7.5l-9 9"/>
					</svg>
					Local graph
				</button>
			{/if}
			{#if downloadUrl}
				<a
					href={downloadUrl}
					download={note.path.split('/').pop() || 'note.md'}
					class="px-3 py-1 text-sm rounded bg-hub-card text-hub-muted hover:text-hub-text transition-colors"
					title="Download"
				>
					Download
				</a>
			{/if}
			<button
				onclick={onEdit}
				class="px-3 py-1 text-sm rounded bg-hub-info/20 text-hub-info hover:bg-hub-info/30 transition-colors"
			>
				Edit
			</button>
			<button
				onclick={handleArchiveClick}
				class="px-3 py-1 text-sm rounded transition-colors {confirmingArchive
					? 'bg-hub-danger/20 text-hub-danger'
					: 'bg-hub-card text-hub-muted hover:text-hub-text'}"
			>
				{confirmingArchive ? 'Confirm?' : 'Archive'}
			</button>
		</div>
	</div>

	<!-- Metadata -->
	<div class="bg-hub-surface rounded-lg p-4 border border-hub-border">
		<h1 class="text-xl font-semibold text-hub-text mb-3" dir="auto">{note.title}</h1>

		{#if note.meta.tags && note.meta.tags.length > 0}
			<div class="flex items-center gap-2 flex-wrap mb-2">
				<span class="text-hub-dim text-sm">Tags:</span>
				{#each note.meta.tags as tag}
					<span class="px-2 py-0.5 rounded bg-hub-card text-hub-muted text-xs">
						{tag}
					</span>
				{/each}
			</div>
		{/if}

		<div class="flex items-center gap-4 text-sm text-hub-dim flex-wrap">
			{#if note.meta.created}
				<span>Created: {note.meta.created}</span>
			{/if}
			<span>Modified: {timeAgo(note.mtime)}</span>
			{#if note.meta.project}
				<span>Project: <span class="text-hub-muted">{note.meta.project}</span></span>
			{/if}
			{#if note.meta.status}
				<span>Status: <span class="text-hub-muted">{note.meta.status}</span></span>
			{/if}
		</div>
	</div>

	<!-- ADR-044.E — CRM sender card. Renders on email-save notes that
	     have `crm_sender_status` in frontmatter; nothing otherwise. -->
	{#if note.meta.crm_sender_status}
		<CrmSenderCard notePath={note.path} meta={note.meta as Record<string, unknown>} />
	{/if}

	<!-- ADR-044 Phase B — Draft-reply card. Renders on email-save notes
	     that carry `inbox_message_id` (added Phase A + backfilled). One
	     click dispatches mailwright via /api/inbox/messages/[id]/draft. -->
	{#if note.meta.inbox_message_id}
		<EmailDraftCard meta={note.meta as Record<string, unknown>} />
	{/if}

	<!-- Rendered content -->
	<div
		class="vault-prose bg-hub-surface rounded-lg p-6 border border-hub-border"
		dir="auto"
		lang={note.contentIsRtl ? 'ar' : undefined}
		onclick={handleContentClick}
		role="presentation"
	>
		{@html note.rendered ?? ''}
	</div>

	<!-- Attachments (non-md siblings in the same folder) -->
	{#if vaultDir}
		<VaultAttachments
			vaultDir={vaultDir}
			noteFolder={noteFolder}
			currentNote={noteFilename}
			onOpen={(absPath) => onNavigate(`__file__:${absPath}`)}
		/>
	{/if}

	<!-- Outgoing links -->
	{#if note.links.length > 0}
		<div class="bg-hub-surface rounded-lg p-4 border border-hub-border">
			<h3 class="text-sm font-medium text-hub-muted mb-2">
				Outgoing Links ({note.links.length})
			</h3>
			<ul class="space-y-1">
				{#each resolvedLinks as link}
					<li>
						<button
							onclick={() => onNavigate(link.resolved!)}
							class="text-sm text-hub-info hover:underline"
						>
							{link.alias || link.raw}
						</button>
					</li>
				{/each}
				{#each unresolvedLinks as link}
					<li class="text-sm text-hub-dim italic">
						{link.alias || link.raw} (unresolved)
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- Backlinks -->
	{#if note.backlinks.length > 0}
		<div class="bg-hub-surface rounded-lg p-4 border border-hub-border">
			<h3 class="text-sm font-medium text-hub-muted mb-2">
				Backlinks ({note.backlinks.length})
			</h3>
			<ul class="space-y-1">
				{#each note.backlinks as bl}
					<li>
						<button
							onclick={() => onNavigate(bl)}
							class="text-sm text-hub-purple hover:underline"
						>
							{bl.split('/').pop()?.replace('.md', '') || bl}
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

<style>
	/* Base prose */
	:global(.vault-prose) {
		color: var(--color-hub-text, #F8FAFC);
		line-height: 1.7;
	}
	:global(.vault-prose h1) { font-size: 1.5rem; font-weight: 700; margin: 1.5rem 0 0.75rem; }
	:global(.vault-prose h2) { font-size: 1.25rem; font-weight: 600; margin: 1.25rem 0 0.5rem; }
	:global(.vault-prose h3) { font-size: 1.1rem; font-weight: 600; margin: 1rem 0 0.5rem; }
	:global(.vault-prose p) { margin: 0.5rem 0; }
	:global(.vault-prose ul, .vault-prose ol) { padding-inline-start: 1.5rem; margin: 0.5rem 0; }
	:global(.vault-prose li) { margin: 0.25rem 0; }

	/* Inline code */
	:global(.vault-prose code) {
		background: var(--color-hub-card, #1E293B);
		padding: 0.15rem 0.4rem;
		border-radius: 0.25rem;
		font-size: 0.875rem;
		font-family: 'JetBrains Mono', 'Fira Code', 'Menlo', monospace;
	}

	/* Code blocks */
	:global(.vault-code-block) {
		margin: 0.75rem 0;
		border-radius: 0.5rem;
		overflow: hidden;
		border: 1px solid var(--color-hub-border, #334155);
	}
	:global(.vault-code-header) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.35rem 0.75rem;
		background: var(--color-hub-card, #1E293B);
		border-bottom: 1px solid var(--color-hub-border, #334155);
	}
	:global(.vault-code-lang) {
		font-size: 0.7rem;
		color: var(--color-hub-dim, #64748B);
		font-family: 'JetBrains Mono', 'Fira Code', monospace;
		text-transform: lowercase;
	}
	:global(.vault-code-copy) {
		font-size: 0.65rem;
		color: var(--color-hub-dim, #64748B);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.15rem 0.5rem;
		border-radius: 0.25rem;
		transition: color 0.15s, background 0.15s;
	}
	:global(.vault-code-copy:hover) {
		color: var(--color-hub-text, #F8FAFC);
		background: rgba(255,255,255,0.05);
	}
	:global(.vault-code-block pre) {
		background: #0d1117 !important;
		padding: 1rem;
		margin: 0;
		overflow-x: auto;
		font-size: 0.8rem;
		line-height: 1.6;
	}
	:global(.vault-code-block pre code) {
		background: none !important;
		padding: 0;
		font-family: 'JetBrains Mono', 'Fira Code', 'Menlo', monospace;
	}

	/* Legacy pre (without code-block wrapper — e.g. from wikilinks) */
	:global(.vault-prose > pre) {
		background: var(--color-hub-card, #1E293B);
		padding: 1rem;
		border-radius: 0.5rem;
		overflow-x: auto;
		margin: 0.75rem 0;
	}
	:global(.vault-prose > pre code) {
		background: none;
		padding: 0;
	}

	/* Media */
	:global(.vault-media) {
		margin: 1rem 0;
		text-align: center;
	}
	:global(.vault-image) {
		max-width: 100%;
		max-height: 500px;
		object-fit: contain;
		border-radius: 0.5rem;
		border: 1px solid var(--color-hub-border, #334155);
	}
	:global(.vault-video) {
		max-width: 100%;
		max-height: 500px;
		border-radius: 0.5rem;
	}
	:global(.vault-audio) {
		width: 100%;
		max-width: 400px;
	}
	:global(.vault-caption) {
		font-size: 0.8rem;
		color: var(--color-hub-dim, #64748B);
		margin-top: 0.35rem;
	}

	/* Blockquotes */
	:global(.vault-prose blockquote) {
		border-inline-start: 3px solid var(--color-hub-border, #334155);
		padding-inline-start: 1rem;
		color: var(--color-hub-muted, #94A3B8);
		margin: 0.75rem 0;
	}

	/* Links */
	:global(.vault-prose a:not(.vault-wikilink)) {
		color: #3B82F6;
		text-decoration: underline;
	}
	:global(.vault-wikilink) {
		color: #A78BFA;
		cursor: pointer;
		text-decoration: none;
		border-bottom: 1px dashed #A78BFA;
	}
	:global(.vault-wikilink:hover) {
		color: #c4b5fd;
		border-bottom-style: solid;
	}
	:global(.vault-wikilink-broken) {
		color: #f87171;
		border-bottom-color: #f87171;
		font-style: italic;
	}
	:global(.vault-wikilink-broken:hover) {
		color: #fca5a5;
		border-bottom-color: #fca5a5;
	}
	:global(.vault-attachment-link) {
		color: #34D399;
		text-decoration: none;
		border-bottom: 1px dashed #34D399;
		cursor: pointer;
	}
	:global(.vault-attachment-link:hover) {
		color: #6EE7B7;
		border-bottom-style: solid;
	}
	/* Inline color swatches — rendered next to any `<code>` whose entire
	   content is a CSS hex literal. Picked up by the renderer's
	   rehypeHexSwatches plugin. Squared, subtly bordered so light values
	   stay visible on light surfaces and dark values on dark. */
	:global(.vault-prose code.hex-code) {
		display: inline-flex;
		align-items: center;
		gap: 0.4em;
		padding: 0.05em 0.4em 0.05em 0.3em;
	}
	:global(.vault-prose code.hex-code .hex-swatch) {
		display: inline-block;
		width: 0.95em;
		height: 0.95em;
		border-radius: 3px;
		border: 1px solid rgba(148, 163, 184, 0.35);
		box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.1);
		flex: 0 0 auto;
	}

	:global(.vault-attachment-link::before) {
		content: '📎 ';
		font-size: 0.85em;
		margin-inline-end: 2px;
	}

	/* Horizontal rules */
	:global(.vault-prose hr) {
		border-color: var(--color-hub-border, #334155);
		margin: 1rem 0;
	}

	/* Tables */
	:global(.vault-prose table) {
		width: 100%;
		border-collapse: collapse;
		margin: 0.75rem 0;
		font-size: 0.875rem;
	}
	:global(.vault-prose th, .vault-prose td) {
		border: 1px solid var(--color-hub-border, #334155);
		padding: 0.5rem 0.75rem;
		text-align: start;
	}
	:global(.vault-prose th) {
		background: var(--color-hub-card, #1E293B);
		font-weight: 600;
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.02em;
		color: var(--color-hub-muted, #94A3B8);
	}
	:global(.vault-prose tr:hover td) {
		background: rgba(255,255,255,0.02);
	}

	/* Shiki output */
	:global(.vault-code-block .shiki) {
		background: #0d1117 !important;
	}
	:global(.vault-code-block .shiki code) {
		font-family: 'JetBrains Mono', 'Fira Code', 'Menlo', monospace;
		font-size: 0.8rem;
	}
</style>
