<script lang="ts">
	interface Props {
		/** Absolute vault root (e.g. /Users/jneaimi/vault) */
		vaultDir: string;
		/** Note's folder, relative to vault root (e.g. "content/katib/business-proposal/2026-04-21-foo") */
		noteFolder: string;
		/** Current note's filename (e.g. "manifest.md") — excluded from the list */
		currentNote: string;
		/** Called when the user wants to preview a file. Receives absolute path + filename. */
		onOpen: (absPath: string, name: string) => void;
	}

	let { vaultDir, noteFolder, currentNote, onOpen }: Props = $props();

	interface FileEntry {
		name: string;
		type: string;
		size?: number;
	}

	let entries = $state<FileEntry[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	const absDir = $derived(noteFolder ? `${vaultDir}/${noteFolder}` : vaultDir);

	async function load(dir: string) {
		if (!dir) {
			entries = [];
			loading = false;
			return;
		}
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/files?path=${encodeURIComponent(dir)}`);
			if (!res.ok) {
				error = `HTTP ${res.status}`;
				entries = [];
				return;
			}
			const data = await res.json();
			const all = (data.entries || []) as FileEntry[];
			entries = all.filter((e) => {
				if (e.type !== 'file') return false;
				if (e.name.startsWith('.')) return false;
				if (e.name === 'CLAUDE.md') return false;
				if (e.name === currentNote) return false;
				if (/\.(md|mdx)$/i.test(e.name)) return false;
				return true;
			});
		} catch (e) {
			error = (e as Error).message;
			entries = [];
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void load(absDir);
	});

	function iconFor(name: string): string {
		const ext = name.split('.').pop()?.toLowerCase() || '';
		if (ext === 'pdf') return '📄';
		if (/^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(ext)) return '🖼️';
		if (/^(mp4|webm|mov|avi|mkv)$/.test(ext)) return '🎬';
		if (/^(mp3|wav|ogg|m4a|flac)$/.test(ext)) return '🎵';
		if (ext === 'html') return '📃';
		if (ext === 'json') return '{ }';
		if (ext === 'csv') return '📊';
		if (ext === 'docx' || ext === 'doc') return '📝';
		if (ext === 'xlsx' || ext === 'xls') return '📊';
		if (ext === 'zip' || ext === 'tar' || ext === 'gz') return '📦';
		return '📎';
	}

	function fmtSize(bytes?: number): string {
		if (!bytes) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1048576).toFixed(1)} MB`;
	}

	function downloadUrl(name: string): string {
		return `/api/files?path=${encodeURIComponent(absDir)}&action=raw&file=${encodeURIComponent(name)}`;
	}

	function handleClick(name: string) {
		onOpen(`${absDir}/${name}`, name);
	}
</script>

{#if loading}
	<div class="bg-hub-surface rounded-lg p-4 border border-hub-border">
		<div class="text-sm text-hub-dim">Loading attachments…</div>
	</div>
{:else if error}
	<div class="bg-hub-surface rounded-lg p-4 border border-hub-border">
		<div class="text-sm text-hub-danger">Attachments error: {error}</div>
	</div>
{:else if entries.length > 0}
	<div class="bg-hub-surface rounded-lg p-4 border border-hub-border">
		<h3 class="text-sm font-medium text-hub-muted mb-3">
			Attachments ({entries.length})
		</h3>
		<ul class="space-y-1.5">
			{#each entries as entry (entry.name)}
				<li class="flex items-center gap-1.5 group">
					<button
						class="flex-1 flex items-center gap-2 text-left px-2 py-1.5 rounded hover:bg-hub-card transition-colors cursor-pointer min-w-0"
						onclick={() => handleClick(entry.name)}
						title="Preview"
					>
						<span class="text-base flex-shrink-0 w-5 text-center">{iconFor(entry.name)}</span>
						<span class="text-sm text-hub-text truncate flex-1">{entry.name}</span>
						<span class="text-[11px] text-hub-dim flex-shrink-0">{fmtSize(entry.size)}</span>
					</button>
					<a
						href={downloadUrl(entry.name)}
						download={entry.name}
						class="p-1.5 rounded hover:bg-hub-card transition-colors text-hub-dim hover:text-hub-text flex-shrink-0"
						title="Download"
					>
						<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
							<polyline points="7 10 12 15 17 10" />
							<line x1="12" y1="15" x2="12" y2="3" />
						</svg>
					</a>
				</li>
			{/each}
		</ul>
	</div>
{/if}
