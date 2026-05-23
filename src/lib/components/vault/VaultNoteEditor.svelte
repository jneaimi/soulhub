<script lang="ts">
	import { onMount } from 'svelte';
	import { marked } from 'marked';
	import type { VaultNote } from '$lib/vault/types';
	import { TYPE_COLORS } from '$lib/vault/types';

	interface Props {
		note: VaultNote;
		onSave: (path: string) => void;
		onCancel: () => void;
	}

	let { note, onSave, onCancel }: Props = $props();

	// Canonical superset across all zones — must include every type that any
	// zone's `Allowed Types` lists in its CLAUDE.md governance file. Missing a
	// type here means notes of that type lose their type when the editor saves.
	// `reference` (used by L3 S4 auto-route in finance/security), `draft`,
	// `recipe`, `task`, `project`, `index`, `idea`, `contact` were all missing
	// before — added 2026-05-12 when finance/security became top-level zones.
	const NOTE_TYPES = [
		'learning', 'decision', 'debugging', 'pattern', 'research', 'output',
		'snippet', 'report', 'daily', 'reference', 'draft', 'recipe', 'task',
		'project', 'index', 'idea', 'contact'
	];

	let editType = $state(note.meta.type || 'learning');
	let editStatus = $state(note.meta.status || '');
	let editTags = $state((note.meta.tags || []).join(', '));
	let editProject = $state(note.meta.project || '');
	let editContent = $state(note.content);

	let saving = $state(false);
	let saveError: string | null = $state(null);
	let showPreview = $state(false);
	let savedMtime = $state(note.mtime);
	let showConflict = $state(false);

	function isRtl(text: string): boolean {
		const rtlChars = text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF]/g);
		if (!rtlChars) return false;
		const latinChars = text.match(/[a-zA-Z]/g);
		const totalAlpha = (rtlChars?.length || 0) + (latinChars?.length || 0);
		return totalAlpha > 0 && (rtlChars.length / totalAlpha) > 0.3;
	}

	const contentIsRtl = $derived(isRtl(editContent));

	const isDirty = $derived(
		editContent !== note.content ||
		editType !== (note.meta.type || 'learning') ||
		editStatus !== (note.meta.status || '') ||
		editTags !== (note.meta.tags || []).join(', ') ||
		editProject !== (note.meta.project || '')
	);

	const previewHtml = $derived(showPreview ? (marked.parse(editContent) as string) : '');
	const typeColor = $derived(TYPE_COLORS[editType] || '#6b7280');

	async function save() {
		saving = true;
		saveError = null;

		const meta = {
			type: editType,
			status: editStatus || undefined,
			tags: editTags.split(',').map(t => t.trim()).filter(Boolean),
			project: editProject || undefined,
			created: note.meta.created,
		};

		try {
			const res = await fetch(`/api/vault/notes/${encodeURIComponent(note.path)}`, {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
					'X-Note-Mtime': savedMtime.toString(),
				},
				body: JSON.stringify({ meta, content: editContent }),
			});

			if (res.status === 409) {
				showConflict = true;
				saving = false;
				return;
			}

			const data = await res.json();
			if (data.success) {
				savedMtime = Date.now();
				onSave(note.path);
			} else {
				saveError = data.error || 'Save failed';
			}
		} catch (err) {
			saveError = err instanceof Error ? err.message : 'Network error';
		}

		saving = false;
	}

	// Reset savedMtime when note prop changes (user navigates to different note)
	$effect(() => {
		savedMtime = note.mtime;
		showConflict = false;
	});

	onMount(() => {
		function handleBeforeUnload(e: BeforeUnloadEvent) {
			if (isDirty) {
				e.preventDefault();
			}
		}
		window.addEventListener('beforeunload', handleBeforeUnload);
		return () => window.removeEventListener('beforeunload', handleBeforeUnload);
	});

	function handleCancel() {
		if (isDirty) {
			if (!confirm('You have unsaved changes. Discard?')) return;
		}
		onCancel();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Tab') {
			e.preventDefault();
			const textarea = e.target as HTMLTextAreaElement;
			const start = textarea.selectionStart;
			const end = textarea.selectionEnd;
			editContent = editContent.substring(0, start) + '  ' + editContent.substring(end);
			requestAnimationFrame(() => {
				textarea.selectionStart = textarea.selectionEnd = start + 2;
			});
		}
	}
</script>

<div class="flex flex-col gap-4">
	<!-- Header -->
	<div class="flex items-center justify-between flex-wrap gap-2">
		<div class="flex items-center gap-2 text-hub-muted text-sm min-w-0">
			<span class="truncate">Editing: <span class="text-hub-text font-medium">{note.title}</span></span>
		</div>
		<div class="flex items-center gap-2">
			<button
				onclick={handleCancel}
				class="px-3 py-1 text-sm rounded bg-hub-card text-hub-muted hover:text-hub-text transition-colors"
			>
				Cancel
			</button>
			<button
				onclick={save}
				disabled={saving}
				class="px-3 py-1 text-sm rounded bg-hub-cta/20 text-hub-cta hover:bg-hub-cta/30 transition-colors disabled:opacity-50"
			>
				{saving ? 'Saving...' : 'Save'}
			</button>
		</div>
	</div>

	{#if showConflict}
		<div class="mb-4 px-4 py-3 rounded-lg bg-hub-warning/10 border border-hub-warning/30">
			<p class="text-sm text-hub-warning font-medium">This note was modified externally.</p>
			<div class="flex gap-2 mt-2">
				<button onclick={() => { onCancel(); }} class="text-xs px-3 py-1 rounded bg-hub-card border border-hub-border text-hub-muted hover:text-hub-text">
					Reload latest
				</button>
				<button onclick={() => { showConflict = false; savedMtime = Date.now(); save(); }} class="text-xs px-3 py-1 rounded bg-hub-warning/20 text-hub-warning hover:brightness-110">
					Overwrite anyway
				</button>
			</div>
		</div>
	{/if}

	{#if saveError}
		<div class="px-3 py-2 rounded bg-hub-danger/10 text-hub-danger text-sm border border-hub-danger/30">
			{saveError}
		</div>
	{/if}

	<!-- Frontmatter form -->
	<div class="bg-hub-surface rounded-lg p-4 border border-hub-border grid grid-cols-2 gap-3">
		<label class="flex flex-col gap-1">
			<span class="text-xs text-hub-dim">Type</span>
			<div class="relative">
				<select
					bind:value={editType}
					class="w-full bg-hub-card text-hub-text text-sm rounded px-3 py-1.5 border border-hub-border appearance-none pr-8"
				>
					{#each NOTE_TYPES as t}
						<option value={t}>{t}</option>
					{/each}
				</select>
				<span
					class="absolute right-2 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full pointer-events-none"
					style="background-color: {typeColor}"
				></span>
			</div>
		</label>

		<label class="flex flex-col gap-1">
			<span class="text-xs text-hub-dim">Status</span>
			<input
				type="text"
				bind:value={editStatus}
				placeholder="proposed, active, resolved..."
				class="bg-hub-card text-hub-text text-sm rounded px-3 py-1.5 border border-hub-border placeholder:text-hub-dim"
			/>
		</label>

		<label class="flex flex-col gap-1 col-span-2">
			<span class="text-xs text-hub-dim">Tags (comma-separated)</span>
			<input
				type="text"
				bind:value={editTags}
				placeholder="svelte, debugging, performance"
				class="bg-hub-card text-hub-text text-sm rounded px-3 py-1.5 border border-hub-border placeholder:text-hub-dim"
			/>
		</label>

		<label class="flex flex-col gap-1 col-span-2">
			<span class="text-xs text-hub-dim">Project</span>
			<input
				type="text"
				bind:value={editProject}
				placeholder="soul-hub"
				class="bg-hub-card text-hub-text text-sm rounded px-3 py-1.5 border border-hub-border placeholder:text-hub-dim"
			/>
		</label>

		{#if note.meta.created}
			<div class="flex flex-col gap-1">
				<span class="text-xs text-hub-dim">Created</span>
				<span class="text-sm text-hub-muted">{note.meta.created}</span>
			</div>
		{/if}

		{#if note.meta.source}
			<div class="flex flex-col gap-1">
				<span class="text-xs text-hub-dim">Source</span>
				<span class="text-sm text-hub-muted truncate">{note.meta.source}</span>
			</div>
		{/if}
	</div>

	<!-- Content editor -->
	<div class="bg-hub-surface rounded-lg border border-hub-border overflow-hidden">
		<textarea
			bind:value={editContent}
			onkeydown={handleKeydown}
			rows={20}
			dir={contentIsRtl ? 'rtl' : 'ltr'}
			class="w-full bg-transparent text-hub-text text-sm p-4 font-mono resize-y min-h-[20rem] border-none outline-none"
			spellcheck="false"
		></textarea>
	</div>

	<!-- Preview toggle -->
	<div>
		<button
			onclick={() => showPreview = !showPreview}
			class="text-sm text-hub-muted hover:text-hub-text transition-colors"
		>
			{showPreview ? 'Hide Preview' : 'Show Preview'}
		</button>
	</div>

	{#if showPreview}
		<div class="vault-prose bg-hub-surface rounded-lg p-6 border border-hub-border" dir={contentIsRtl ? 'rtl' : undefined} lang={contentIsRtl ? 'ar' : undefined}>
			{@html previewHtml}
		</div>
	{/if}
</div>
