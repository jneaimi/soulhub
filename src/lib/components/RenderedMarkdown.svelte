<script lang="ts">
	/** Renders pre-baked HTML (the `rendered` field on `/api/vault/notes/<path>`)
	 *  with the same `vault-prose` styles VaultNoteView ships. Lifted into a
	 *  shared component so the project detail page, the ADR drawer, and the
	 *  vault note view all paint markdown the same way.
	 */

	interface Props {
		html: string;
		rtl?: boolean;
	}

	let { html, rtl = false }: Props = $props();
</script>

<div class="vault-prose" dir="auto" lang={rtl ? 'ar' : undefined}>
	{@html html}
</div>

<style>
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

	:global(.vault-prose code) {
		background: var(--color-hub-card, #1E293B);
		padding: 0.15rem 0.4rem;
		border-radius: 0.25rem;
		font-size: 0.875rem;
		font-family: 'JetBrains Mono', 'Fira Code', 'Menlo', monospace;
	}

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

	:global(.vault-prose blockquote) {
		border-inline-start: 3px solid var(--color-hub-border, #334155);
		padding-inline-start: 1rem;
		color: var(--color-hub-muted, #94A3B8);
		margin: 0.75rem 0;
	}

	:global(.vault-prose a) {
		color: var(--color-hub-info, #60A5FA);
		text-decoration: underline;
		text-decoration-color: rgba(96, 165, 250, 0.4);
	}
	:global(.vault-prose a:hover) {
		text-decoration-color: var(--color-hub-info, #60A5FA);
	}

	:global(.vault-prose table) {
		border-collapse: collapse;
		margin: 0.75rem 0;
		font-size: 0.875rem;
	}
	:global(.vault-prose th, .vault-prose td) {
		border: 1px solid var(--color-hub-border, #334155);
		padding: 0.4rem 0.6rem;
		text-align: left;
	}
	:global(.vault-prose th) {
		background: var(--color-hub-card, #1E293B);
		font-weight: 600;
	}
</style>
