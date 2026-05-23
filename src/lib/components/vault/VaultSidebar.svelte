<script lang="ts">
  import { getVaultStore } from '$lib/vault/store.svelte.js';
  import { TYPE_CHIP_CLASSES, DEFAULT_TYPE_CHIP_CLASS } from '$lib/vault/types';

  const store = getVaultStore();

  interface Props {
    selectedPath: string | null;
    bulkSelected: Set<string>;
    /** Current main-pane view — Recent is hidden when the list view shows
     *  the same data more comprehensively. */
    view?: 'list' | 'graph' | 'note' | 'edit';
    onSelect: (path: string) => void;
    onFilterChange: (filter: { zone?: string }) => void;
    onToggleBulk: (path: string) => void;
    onShowBrokenLinks?: () => void;
  }

  let { selectedPath, bulkSelected, view = 'list', onSelect, onFilterChange, onToggleBulk, onShowBrokenLinks }: Props = $props();

  // Read zone from store so it syncs with smart views
  let activeZone = $derived(store.filters.zone ?? null);
  let sidebarTab = $state<'overview' | 'files'>('overview');

  // Filter recent notes by active filters
  let filteredRecent = $derived.by(() => {
    let notes = store.recentNotes;
    const f = store.filters;
    if (f.zone) {
      notes = notes.filter(n => n.path.split('/')[0] === f.zone);
    }
    if (f.type) {
      const types = Array.isArray(f.type) ? f.type : [f.type];
      notes = notes.filter(n => n.meta?.type && types.includes(n.meta.type));
    }
    if (f.tags && f.tags.length > 0) {
      notes = notes.filter(n => n.meta?.tags && f.tags!.every(t => n.meta.tags!.includes(t)));
    }
    if (f.since) {
      const cutoff = Date.now() - f.since * 24 * 60 * 60 * 1000;
      notes = notes.filter(n => n.mtime >= cutoff);
    }
    return notes;
  });

  // File browser state.
  // ADR-002 (2026-05-16): the 'outputs' root (Pipeline Outputs) was retired
  // along with the pipeline module. Naseej recipe outputs live under
  // ~/vault/projects/<project>/outputs/ and are reachable through the vault
  // root, so a separate toggle is no longer needed.
  interface FileEntry { name: string; type: string; size?: number; }
  let currentDir = $state('');
  let dirEntries = $state<FileEntry[]>([]);
  let loadingDir = $state(false);
  let dirError = $state<string | null>(null);

  function getBasePath(): string {
    return store.vaultDir;
  }

  async function browseDir(dir: string) {
    if (!getBasePath()) return;
    loadingDir = true;
    dirError = null;
    currentDir = dir;
    try {
      const fullPath = getBasePath() + (dir ? '/' + dir : '');
      const res = await fetch(`/api/files?path=${encodeURIComponent(fullPath)}`);
      if (!res.ok) {
        dirError = `Failed to load: ${res.statusText}`;
        dirEntries = [];
        return;
      }
      const data = await res.json();
      let entries = (data.entries || []) as FileEntry[];
      entries = entries.filter((e: FileEntry) => !e.name.startsWith('.') && e.name !== 'CLAUDE.md');
      dirEntries = entries.sort((a: FileEntry, b: FileEntry) => {
        const aDir = a.type === 'dir';
        const bDir = b.type === 'dir';
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch (e) {
      dirError = (e as Error).name === 'AbortError' ? null : 'Network error';
      dirEntries = [];
    } finally { loadingDir = false; }
  }

  function handleFileClick(entry: FileEntry) {
    if (entry.type === 'dir') {
      browseDir(currentDir ? `${currentDir}/${entry.name}` : entry.name);
    } else {
      const relPath = currentDir ? `${currentDir}/${entry.name}` : entry.name;
      // Markdown opens as a vault note; everything else previews as a raw file
      // so SVG/PNG/PDF/etc render in FilePreview instead of erroring at /api/vault/notes.
      if (/\.(md|mdx)$/i.test(entry.name)) {
        onSelect(relPath);
      } else {
        onSelect('__file__:' + getBasePath() + '/' + relPath);
      }
    }
  }

  function navigateUp() {
    const parts = currentDir.split('/');
    parts.pop();
    browseDir(parts.join('/'));
  }

  const zoneIcons: Record<string, string> = {
    inbox: 'M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4',
    projects: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
    knowledge: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
    content: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    operations: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
    archive: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4',
  };

  const zoneColors: Record<string, string> = {
    inbox: 'text-amber-400',
    finance: 'text-emerald-400',
    security: 'text-rose-400',
    projects: 'text-indigo-400',
    knowledge: 'text-cyan-400',
    content: 'text-violet-400',
    operations: 'text-slate-400',
    archive: 'text-gray-400',
  };

  const zoneOrder = ['inbox', 'finance', 'security', 'projects', 'knowledge', 'content', 'operations', 'archive'];
  // Legacy zones to hide from sidebar (still exist on disk but being migrated)
  const legacyZones = new Set(['patterns', 'research', 'sessions']);

  const sortedZones = $derived.by(() => {
    if (!store.stats) return [];
    const allZones = new Set([...zoneOrder, ...Object.keys(store.stats.notesByZone)]);
    return [...allZones].filter(z => !legacyZones.has(z)).sort((a, b) => {
      const ai = zoneOrder.indexOf(a);
      const bi = zoneOrder.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.localeCompare(b);
    }).map(z => ({ name: z, count: store.stats?.notesByZone[z] ?? 0 }));
  });

  function relativeTime(mtime: number): string {
    const diff = Date.now() - mtime;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  function getZoneRules(zonePath: string) {
    return store.zones.find(z => z.path === zonePath) ?? null;
  }

  function formatAllowedTypes(types: string[]): string {
    if (types.length === 0) return 'all';
    if (types.length <= 4) return types.join(', ');
    return types.slice(0, 4).join(', ') + ` +${types.length - 4} more`;
  }

  function selectZone(zone: string | null) {
    onFilterChange({ zone: zone ?? undefined });
  }
</script>

<div class="h-full flex flex-col bg-hub-surface overflow-hidden">
  <!-- Tab switcher -->
  <div class="flex-shrink-0 flex border-b border-hub-border">
    <button
      class="flex-1 py-2 text-xs text-center font-medium transition-colors {sidebarTab === 'overview' ? 'text-hub-cta border-b-2 border-hub-cta' : 'text-hub-muted hover:text-hub-text'}"
      onclick={() => { sidebarTab = 'overview'; }}
    >Overview</button>
    <button
      class="flex-1 py-2 text-xs text-center font-medium transition-colors {sidebarTab === 'files' ? 'text-hub-cta border-b-2 border-hub-cta' : 'text-hub-muted hover:text-hub-text'}"
      onclick={() => { sidebarTab = 'files'; if (dirEntries.length === 0) browseDir(''); }}
    >Files</button>
  </div>

  <div class="flex-1 overflow-y-auto overflow-x-hidden">
  {#if sidebarTab === 'files'}
    <!-- File browser — vault root only (ADR-002, 2026-05-16) -->
    <div class="p-3">
      <div class="flex items-center gap-2 mb-2">
        {#if currentDir}
          <button onclick={navigateUp} class="text-hub-muted hover:text-hub-text text-sm" aria-label="Go up">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
          </button>
        {/if}
        <span class="text-xs text-hub-dim truncate">/{currentDir || 'vault'}</span>
      </div>

      {#if loadingDir}
        <div class="text-xs text-hub-dim animate-pulse py-2">Loading...</div>
      {:else if dirError}
        <div class="text-xs text-hub-danger py-2">{dirError} <button onclick={() => browseDir(currentDir)} class="underline text-hub-muted hover:text-hub-text ml-1">Retry</button></div>
      {:else if dirEntries.length === 0}
        <div class="text-xs text-hub-dim py-2">Empty folder</div>
      {:else}
        <div class="space-y-0.5">
          {#each dirEntries as entry}
            <button
              class="w-full text-left px-2 py-1.5 rounded text-sm text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors flex items-center gap-2"
              onclick={() => handleFileClick(entry)}
            >
              {#if entry.type === 'dir'}
                <svg class="w-4 h-4 text-hub-dim flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
              {:else}
                <svg class="w-4 h-4 text-hub-dim flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
              {/if}
              <span class="truncate">{entry.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <!-- Overview tab (zones, types, recent) -->
    <div class="p-3">
      <h3 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-2">Zones</h3>
      <button
        class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors {activeZone === null ? 'bg-hub-cta/10 text-hub-cta' : 'text-hub-muted hover:text-hub-text hover:bg-hub-card'}"
        onclick={() => selectZone(null)}
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
        <span>All</span>
        {#if store.stats}
          <span class="ml-auto text-xs text-hub-dim">{store.stats.totalNotes}</span>
        {/if}
      </button>

      {#each sortedZones as zone}
        <button
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors cursor-pointer {activeZone === zone.name ? 'bg-hub-cta/10 text-hub-cta' : 'text-hub-muted hover:text-hub-text hover:bg-hub-card'}"
          onclick={() => selectZone(zone.name)}
        >
          <svg class="w-4 h-4 {zoneColors[zone.name] ?? 'text-hub-dim'}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={zoneIcons[zone.name] ?? 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z'} />
          </svg>
          <span class="capitalize">{zone.name}</span>
          <span class="ml-auto text-xs text-hub-dim">{zone.count}</span>
        </button>
        {#if activeZone === zone.name}
          {@const zoneRules = getZoneRules(zone.name)}
          <div class="pl-8 pr-2 py-1 text-[10px] text-hub-dim space-y-0.5">
            {#if zoneRules}
              <div>Types: {formatAllowedTypes(zoneRules.allowedTypes)}</div>
              {#if zoneRules.requiredFields.length > 0}
                <div>Required: {zoneRules.requiredFields.join(', ')}</div>
              {/if}
              {#if zoneRules.namingPattern}
                <div>Naming: <code class="text-[9px] bg-hub-bg px-1 rounded">{zoneRules.namingPattern}</code></div>
              {/if}
              {#if zoneRules.requireTemplate}
                <div class="text-hub-cta">Template required</div>
              {/if}
            {:else}
              <div>No governance rules</div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>

    <!-- Recent notes — hidden when the list view already surfaces them in
         the main pane (avoids showing the same data twice). Shown when
         the user is on graph or a single note, where a quick-jump list
         is genuinely useful. -->
    {#if view !== 'list'}
      <div class="p-3">
        <h3 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-2">Recent</h3>
        {#if filteredRecent.length === 0}
          <div class="text-xs text-hub-dim py-2">{store.filters.zone || store.filters.type || (store.filters.tags && store.filters.tags.length > 0) ? 'No matching notes' : 'No notes yet'}</div>
        {:else}
          <div class="space-y-0.5">
            {#each filteredRecent as note}
              <div class="flex items-start gap-1 group">
                <button
                  class="flex-shrink-0 mt-2 w-3.5 h-3.5 rounded border cursor-pointer transition-colors {bulkSelected.has(note.path) ? 'bg-hub-cta border-hub-cta' : 'border-hub-border hover:border-hub-dim'}"
                  onclick={(e) => { e.stopPropagation(); onToggleBulk(note.path); }}
                  aria-label="Select {note.title}"
                >
                  {#if bulkSelected.has(note.path)}
                    <svg class="w-3.5 h-3.5 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>
                  {/if}
                </button>
                <button
                  class="flex-1 text-left px-1.5 py-1.5 rounded text-sm transition-colors {selectedPath === note.path ? 'bg-hub-cta/10 text-hub-cta' : 'text-hub-muted hover:text-hub-text hover:bg-hub-card'}"
                  onclick={() => onSelect(note.path)}
                >
                  <div class="flex items-center gap-1.5">
                    <span class="flex-1 break-words" style="unicode-bidi: plaintext;">{note.title}</span>
                  </div>
                  <div class="flex items-center gap-1.5 mt-0.5">
                    {#if note.meta?.type}
                      <span class="text-[10px] px-1 rounded {TYPE_CHIP_CLASSES[note.meta.type] ?? DEFAULT_TYPE_CHIP_CLASS}">
                        {note.meta.type}
                      </span>
                    {/if}
                    <span class="text-[10px] text-hub-dim ml-auto">{relativeTime(note.mtime)}</span>
                  </div>
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
  </div>

  <!-- Health footer -->
  {#if store.stats}
    <div class="flex-shrink-0 border-t border-hub-border px-3 py-2">
      <div class="flex items-center gap-2 mb-1">
        <div class="w-2 h-2 rounded-full {store.stats.orphanNotes === 0 && store.stats.unresolvedLinks === 0 ? 'bg-green-400' : 'bg-amber-400'}"></div>
        <span class="text-[10px] text-hub-dim font-medium">Health</span>
      </div>
      <div class="text-[10px] text-hub-dim flex flex-wrap gap-x-3 gap-y-0.5">
        <span>{store.stats.totalNotes} notes</span>
        <span>{store.stats.totalLinks} links</span>
        {#if store.stats.unresolvedLinks > 0}
          {#if onShowBrokenLinks}
            <button
              onclick={onShowBrokenLinks}
              class="text-amber-400 hover:text-amber-300 underline decoration-dotted underline-offset-2 cursor-pointer"
              aria-label="View {store.stats.unresolvedLinks} broken links"
            >{store.stats.unresolvedLinks} broken</button>
          {:else}
            <span class="text-amber-400">{store.stats.unresolvedLinks} broken</span>
          {/if}
        {/if}
        {#if store.stats.orphanNotes > 0}
          <span class="text-amber-400">{store.stats.orphanNotes} orphans</span>
        {/if}
        {#if store.stats.orphanNotes === 0 && store.stats.unresolvedLinks === 0}
          <span class="text-green-400">All clean</span>
        {/if}
      </div>
    </div>
  {/if}
</div>
