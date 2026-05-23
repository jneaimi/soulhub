<script lang="ts">
  import { onMount } from 'svelte';
  import { getVaultStore } from '$lib/vault/store.svelte.js';
  import type { GraphNode, GraphEdge } from '$lib/vault/types';
  import VaultSidebar from '$lib/components/vault/VaultSidebar.svelte';
  import VaultGraph from '$lib/components/vault/VaultGraph.svelte';
  import VaultList from '$lib/components/vault/VaultList.svelte';
  import VaultNoteView from '$lib/components/vault/VaultNoteView.svelte';
  import VaultNoteEditor from '$lib/components/vault/VaultNoteEditor.svelte';
  import VaultSearch from '$lib/components/vault/VaultSearch.svelte';
  import VaultNewNote from '$lib/components/vault/VaultNewNote.svelte';
  import VaultSmartViews from '$lib/components/vault/VaultSmartViews.svelte';
  import VaultBulkBar from '$lib/components/vault/VaultBulkBar.svelte';
  import VaultBrokenLinksDrawer from '$lib/components/vault/VaultBrokenLinksDrawer.svelte';
  import FilePreview from '$lib/components/FilePreview.svelte';

  const store = getVaultStore();
  let { data } = $props();

  // Local UI state only
  type View = 'list' | 'graph' | 'note' | 'edit';
  let view = $state<View>(data.initialView as View);
  let sidebarWidth = $state(280);
  let resizing = $state(false);
  let showNewNote = $state(false);
  let showSearch = $state(false);
  let showBrokenLinks = $state(false);
  let previewFile = $state<{ path: string; name: string } | null>(null);
  // Local-graph mode: when set, the graph view renders an ego subgraph
  // (depth 2) around this note instead of the full filtered graph.
  let localGraphCenter = $state<string | null>(null);
  const LOCAL_GRAPH_DEPTH = 2;
  let scaffoldingAll = $state(false);
  let scaffoldMessage = $state<string | null>(null);
  let allTags = $state<Record<string, number>>({});
  let isMobile = $state(false);
  let mobileView = $state<'sidebar' | 'main'>('main');
  let bulkSelected = $state<Set<string>>(new Set());

  function toggleBulk(path: string) {
    const next = new Set(bulkSelected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    bulkSelected = next;
  }

  // Note state — initialized from load() data, updated via fetchNote
  let currentNote = $state<any>(data.initialNote);
  let noteError = $state<string | null>(data.initialNoteError);

  async function fetchNote(path: string) {
    currentNote = null;
    noteError = null;
    try {
      const url = `/api/vault/notes/${path.split('/').map(encodeURIComponent).join('/')}`;
      const res = await fetch(url);
      if (res.ok) {
        currentNote = await res.json();
      } else {
        const body = await res.json().catch(() => ({}));
        noteError = body.error ?? `Failed to load note (${res.status})`;
      }
    } catch (e) {
      noteError = (e as Error).message || 'Network error';
    }
  }

  $effect(() => {
    const path = store.selectedPath;
    if (path && (view === 'note' || view === 'edit')) {
      fetchNote(path);
    }
  });

  // Local-graph mode uses the canonical server endpoint
  // /api/vault/graph/local/[...path]?depth=N which BFS-walks the unfiltered
  // index through links + backlinks and re-normalizes node sizes for the
  // local subgraph. Filtering on the client would lose connections that pass
  // through notes outside the user's active filter.
  let localGraphData = $state<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  let localGraphLoading = $state(false);
  let localGraphError = $state<string | null>(null);
  let localGraphController: AbortController | null = null;

  async function fetchLocalGraph(path: string, depth: number) {
    localGraphController?.abort();
    localGraphController = new AbortController();
    localGraphLoading = true;
    localGraphError = null;
    try {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const res = await fetch(`/api/vault/graph/local/${encoded}?depth=${depth}`, { signal: localGraphController.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        localGraphError = body.error ?? `Failed to load local graph (${res.status})`;
        localGraphData = null;
        return;
      }
      const data = await res.json();
      localGraphData = { nodes: data.nodes ?? [], edges: data.edges ?? [] };
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        localGraphError = (e as Error).message || 'Network error';
        localGraphData = null;
      }
    } finally {
      localGraphLoading = false;
    }
  }

  $effect(() => {
    if (localGraphCenter && view === 'graph') {
      fetchLocalGraph(localGraphCenter, LOCAL_GRAPH_DEPTH);
    } else {
      localGraphData = null;
    }
  });

  let displayGraph = $derived.by(() => {
    if (localGraphCenter && view === 'graph' && localGraphData) {
      return localGraphData;
    }
    return { nodes: store.graphNodes, edges: store.graphEdges };
  });

  let localGraphTitle = $derived.by(() => {
    if (!localGraphCenter) return '';
    const node = store.graphNodes.find((n) => n.id === localGraphCenter);
    return node?.label ?? localGraphCenter.split('/').pop() ?? localGraphCenter;
  });

  function showLocalGraph(path: string) {
    localGraphCenter = path;
    view = 'graph';
    updateUrl();
  }

  function clearLocalGraph() {
    localGraphCenter = null;
    localGraphData = null;
    localGraphError = null;
  }

  function buildUrlParams(): string {
    const params = new URLSearchParams();
    if (view !== 'list') params.set('view', view);
    if (store.selectedPath) params.set('note', store.selectedPath);
    if (store.filters.zone) params.set('zone', store.filters.zone);
    if (store.filters.type) {
      const types = Array.isArray(store.filters.type) ? store.filters.type : [store.filters.type];
      params.set('type', types.join(','));
    }
    if (store.filters.tags && store.filters.tags.length > 0) {
      params.set('tags', store.filters.tags.join(','));
    }
    const qs = params.toString();
    return `/vault${qs ? '?' + qs : ''}`;
  }

  function updateUrl() {
    history.pushState({ view, note: store.selectedPath }, '', buildUrlParams());
  }

  function replaceUrl() {
    history.replaceState({ view, note: store.selectedPath }, '', buildUrlParams());
  }

  function handleSelectNote(path: string) {
    if (path.startsWith('__file__:')) {
      const absPath = path.slice(9);
      previewFile = { path: absPath, name: absPath.split('/').pop() || absPath };
      return;
    }
    view = 'note';
    if (isMobile) mobileView = 'main';
    noteError = null;
    store.selectNote(path);
    updateUrl();
  }

  function backToHome() {
    view = 'list';
    currentNote = null;
    noteError = null;
    localGraphCenter = null;
    store.clearSelection();
    updateUrl();
  }

  function toggleSurface() {
    // Switching to graph manually means "show me the whole graph" — clear any
    // local-graph framing so the full filtered set renders.
    if (view === 'list') localGraphCenter = null;
    view = view === 'graph' ? 'list' : 'graph';
    updateUrl();
  }

  async function handleArchive() {
    if (!store.selectedPath) return;
    const res = await fetch(`/api/vault/notes/${encodeURIComponent(store.selectedPath)}`, { method: 'DELETE' });
    if (res.ok) {
      view = 'list';
      store.clearSelection();
      await store.invalidate('overview', 'recent', 'graph');
      updateUrl();
    }
  }

  async function handleNoteSaved(path: string) {
    view = 'note';
    await fetchNote(path);
    await store.invalidate('overview', 'graph');
    replaceUrl();
  }

  async function handleNoteCreated(path: string) {
    showNewNote = false;
    await store.invalidate('overview', 'recent', 'graph');
    await store.selectNote(path);
    view = 'note';
    updateUrl();
  }

  function handleFilterChange(filter: { zone?: string }) {
    // Sidebar sends zone only — merge with existing type/tag filters
    store.setFilters({
      zone: filter.zone,
      type: store.filters.type,
      tags: store.filters.tags,
    });
    replaceUrl();
  }

  function handleNavigate(path: string) {
    if (!path) { view = 'list'; store.clearSelection(); currentNote = null; return; }
    if (path.startsWith('__file__:')) {
      const absPath = path.slice(9);
      previewFile = { path: absPath, name: absPath.split('/').pop() || absPath };
      return;
    }
    noteError = null;
    store.selectNote(path);
    view = 'note';
  }

  async function scaffoldAll() {
    scaffoldingAll = true;
    try {
      const res = await fetch('/api/workspaces');
      if (!res.ok) return;
      const data = await res.json();
      const projects = data.projects || [];

      let count = 0;
      for (const project of projects) {
        const scaffoldRes = await fetch(`/api/vault/scaffold/${encodeURIComponent(project.name)}`, { method: 'POST' });
        if (scaffoldRes.ok) {
          const data = await scaffoldRes.json();
          if (data.created.length > 0) count++;
        }
      }

      await store.invalidate('overview', 'graph');
      scaffoldMessage = count > 0 ? `Scaffolded ${count} projects` : 'All projects already scaffolded';
      setTimeout(() => { scaffoldMessage = null; }, 3000);
    } finally {
      scaffoldingAll = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 'k') {
      e.preventDefault();
      showSearch = !showSearch;
    }
    if (meta && e.key === 'n') {
      e.preventDefault();
      showNewNote = true;
    }
    if (e.key === 'Escape') {
      if (showBrokenLinks) { showBrokenLinks = false; return; }
      if (showSearch) showSearch = false;
      if (showNewNote) showNewNote = false;
      if (view === 'note') backToHome();
    }
  }

  function startResize(e: MouseEvent) {
    e.preventDefault();
    resizing = true;
    const startX = e.clientX;
    const startW = sidebarWidth;
    function onMove(ev: MouseEvent) {
      sidebarWidth = Math.max(200, Math.min(400, startW + (ev.clientX - startX)));
    }
    function onUp() {
      resizing = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function handlePopState(_e: PopStateEvent) {
    const params = new URLSearchParams(window.location.search);
    const notePath = params.get('note');
    const urlView = params.get('view') as View | null;
    const urlZone = params.get('zone');
    const urlType = params.get('type');

    if (notePath) {
      const decoded = decodeURIComponent(notePath);
      noteError = null;
      store.selectNote(decoded);
      view = urlView || 'note';
    } else {
      view = urlView || 'list';
      store.clearSelection();
    }

    const urlTags = params.get('tags');
    const tagsArray = urlTags ? urlTags.split(',').filter(Boolean) : undefined;
    const typesArray = urlType ? urlType.split(',').filter(Boolean) : undefined;
    if (urlZone || typesArray || tagsArray) {
      store.setFilters({ zone: urlZone || undefined, type: typesArray, tags: tagsArray });
    }

    if (isMobile && notePath) mobileView = 'main';
  }

  onMount(() => {
    const checkMobile = () => { isMobile = window.innerWidth < 768; };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    window.addEventListener('popstate', handlePopState);

    if (new URLSearchParams(window.location.search).get('new') === '1') {
      showNewNote = true;
    }

    // Refresh vault state on tab focus + SSE reindex events
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        store.invalidate('overview', 'recent');
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    let es: EventSource | null = null;
    let sseDebounce: ReturnType<typeof setTimeout> | null = null;
    try {
      es = new EventSource('/api/vault/events');
      es.addEventListener('reindexed', () => {
        if (sseDebounce) clearTimeout(sseDebounce);
        sseDebounce = setTimeout(() => {
          store.invalidate('overview', 'recent');
        }, 300);
      });
      es.onerror = () => { /* browser auto-reconnects */ };
    } catch { /* SSE unsupported — visibility fallback covers it */ }

    store.init().then(async () => {
      if (data.initialZone || data.initialTypes || data.initialTags) {
        store.setFilters({ zone: data.initialZone || undefined, type: data.initialTypes, tags: data.initialTags });
      }
      if (data.initialNotePath) {
        store.selectNote(data.initialNotePath);
        if (data.initialView === 'edit') view = 'edit';
      }

      try {
        const tagsRes = await fetch('/api/vault/tags');
        if (tagsRes.ok) {
          const tagsData = await tagsRes.json();
          allTags = tagsData.tags ?? tagsData;
        }
      } catch { /* silent */ }
    });

    if (isMobile && data.initialNotePath) mobileView = 'main';

    return () => {
      window.removeEventListener('resize', checkMobile);
      window.removeEventListener('popstate', handlePopState);
      document.removeEventListener('visibilitychange', onVisible);
      if (sseDebounce) clearTimeout(sseDebounce);
      es?.close();
      store.destroy();
    };
  });
</script>

<svelte:head><title>Vault | Soul Hub</title></svelte:head>
<svelte:window onkeydown={handleKeydown} />

<div class="h-full flex flex-col">
  <header class="flex-shrink-0 px-4 py-3 border-b border-hub-border bg-hub-surface/50 flex items-center gap-3">
    <h1 class="text-lg font-semibold text-hub-text">Vault</h1>

    {#if store.stats}
      <span class="text-xs text-hub-dim">{store.stats.totalNotes} notes</span>
    {/if}

    <div class="flex-1"></div>

    <!-- Search (always visible) -->
    <button onclick={() => { showSearch = true; }} class="flex items-center gap-2 px-2 md:px-3 py-1.5 rounded-lg bg-hub-card border border-hub-border text-hub-muted text-sm hover:border-hub-dim transition-colors" aria-label="Search">
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
      <span class="hidden md:inline">Search</span>
      <kbd class="hidden md:inline text-xs text-hub-dim bg-hub-bg px-1 rounded">&#8984;K</kbd>
    </button>

    <!-- Desktop-only admin buttons -->
    <button onclick={scaffoldAll} disabled={scaffoldingAll}
      class="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-hub-card border border-hub-border text-hub-muted text-sm hover:text-hub-text transition-colors disabled:opacity-50 cursor-pointer" aria-label="Scaffold">
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
      </svg>
      {scaffoldingAll ? 'Scaffolding...' : 'Scaffold'}
    </button>

    {#if scaffoldMessage}
      <span class="hidden md:inline text-xs text-hub-cta animate-pulse">{scaffoldMessage}</span>
    {/if}

    <!-- New Note (always visible) -->
    <button onclick={() => { showNewNote = true; }} class="flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-lg bg-hub-cta text-white text-sm font-medium hover:brightness-110 transition-all" aria-label="New Note">
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
      <span class="hidden sm:inline">New Note</span>
    </button>

    <!-- Surface toggle (list ↔ graph) when not viewing a note -->
    {#if view === 'list' || view === 'graph'}
      <div class="flex rounded-lg border border-hub-border overflow-hidden" role="tablist" aria-label="Vault surface">
        <button
          onclick={() => { if (view !== 'list') toggleSurface(); }}
          class="flex items-center gap-1.5 px-2 md:px-3 py-1.5 text-sm transition-colors {view === 'list' ? 'bg-hub-cta/15 text-hub-cta' : 'bg-hub-card text-hub-muted hover:text-hub-text'}"
          role="tab"
          aria-selected={view === 'list'}
          aria-label="List view"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
          <span class="hidden sm:inline">List</span>
        </button>
        <button
          onclick={() => { if (view !== 'graph') toggleSurface(); }}
          class="flex items-center gap-1.5 px-2 md:px-3 py-1.5 text-sm transition-colors border-l border-hub-border {view === 'graph' ? 'bg-hub-cta/15 text-hub-cta' : 'bg-hub-card text-hub-muted hover:text-hub-text'}"
          role="tab"
          aria-selected={view === 'graph'}
          aria-label="Graph view"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><circle cx="6" cy="6" r="2" stroke-width="2"/><circle cx="18" cy="18" r="2" stroke-width="2"/><circle cx="6" cy="18" r="2" stroke-width="2"/><circle cx="18" cy="6" r="2" stroke-width="2"/><path stroke-linecap="round" stroke-width="2" d="M7.5 7.5l9 9M16.5 7.5l-9 9"/></svg>
          <span class="hidden sm:inline">Graph</span>
        </button>
      </div>
    {:else}
      <button onclick={backToHome} class="flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-lg bg-hub-card border border-hub-border text-hub-muted text-sm hover:text-hub-text transition-colors" aria-label="Back">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
        <span class="hidden sm:inline">Back</span>
      </button>
    {/if}
  </header>

  <VaultSmartViews
    activeFilters={store.filters}
    {allTags}
    allTypes={Object.keys(store.stats?.notesByType ?? {})}
    allTagsList={Object.keys(allTags)}
    onApply={(f) => {
      store.setFilters({
        zone: f.zone,
        type: f.type && f.type.length > 0 ? f.type : undefined,
        tags: f.tags && f.tags.length > 0 ? f.tags : undefined,
        since: f.since || undefined,
      });
      replaceUrl();
    }}
    onAdHocFilterChange={(f) => {
      // Ad-hoc Type/Tags edits keep the active zone/since dimensions intact —
      // those flow only through smart-view selection.
      store.setFilters({
        zone: store.filters.zone,
        type: f.type && f.type.length > 0 ? f.type : undefined,
        tags: f.tags && f.tags.length > 0 ? f.tags : undefined,
        since: store.filters.since,
      });
      replaceUrl();
    }}
  />

  {#if isMobile}
    <div class="flex border-b border-hub-border bg-hub-surface/30">
      <button
        class="flex-1 py-2 text-sm text-center {mobileView === 'sidebar' ? 'text-hub-cta border-b-2 border-hub-cta' : 'text-hub-muted'}"
        onclick={() => { mobileView = 'sidebar'; }}
      >Sidebar</button>
      <button
        class="flex-1 py-2 text-sm text-center {mobileView === 'main' ? 'text-hub-cta border-b-2 border-hub-cta' : 'text-hub-muted'}"
        onclick={() => { mobileView = 'main'; }}
      >
        {view === 'list' ? 'List' : view === 'graph' ? 'Graph' : view === 'edit' ? 'Edit' : 'Note'}
      </button>
    </div>
  {/if}

  <div class="flex-1 min-h-0 flex">
    {#if !isMobile || mobileView === 'sidebar'}
      <div
        class="flex-shrink-0 border-r border-hub-border overflow-hidden"
        class:w-full={isMobile}
        style={isMobile ? '' : `width: ${sidebarWidth}px`}
      >
        <VaultSidebar
          selectedPath={store.selectedPath}
          {bulkSelected}
          {view}
          onSelect={handleSelectNote}
          onFilterChange={handleFilterChange}
          onToggleBulk={toggleBulk}
          onShowBrokenLinks={() => { showBrokenLinks = true; }}
        />
      </div>

      {#if !isMobile}
        <div
          class="flex-shrink-0 w-1 cursor-col-resize hover:bg-hub-cta/30 active:bg-hub-cta/50 transition-colors {resizing ? 'bg-hub-cta/50' : ''}"
          onmousedown={startResize}
        ></div>
      {/if}
    {/if}

    {#if !isMobile || mobileView === 'main'}
      <div class="flex-1 min-w-0 min-h-0 flex flex-col">
        {#if store.loading}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-hub-muted animate-pulse">Loading vault...</div>
          </div>
        {:else if store.error}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-center">
              <p class="text-hub-danger mb-2">{store.error}</p>
              <button onclick={() => store.init()} class="text-sm text-hub-muted hover:text-hub-text">Retry</button>
            </div>
          </div>
        {:else if view === 'list'}
          <div class="flex-1 min-h-0">
            <VaultList onSelect={handleSelectNote} />
          </div>
        {:else if view === 'graph'}
          <div class="flex-1 min-h-0 relative bg-hub-bg flex flex-col">
            {#if localGraphCenter}
              <div class="flex-shrink-0 flex items-center gap-3 px-4 py-2 border-b border-hub-border bg-hub-cta/5 text-xs">
                <span class="text-hub-cta font-medium">Local graph</span>
                <span class="text-hub-muted truncate" style="unicode-bidi: plaintext;" title={localGraphTitle}>{localGraphTitle}</span>
                <span class="text-hub-dim">
                  · depth {LOCAL_GRAPH_DEPTH}
                  {#if localGraphLoading}
                    · <span class="animate-pulse">loading…</span>
                  {:else if localGraphError}
                    · <span class="text-hub-danger">{localGraphError}</span>
                  {:else}
                    · {displayGraph.nodes.length} nodes
                  {/if}
                </span>
                <div class="flex-1"></div>
                <button
                  onclick={clearLocalGraph}
                  class="text-hub-muted hover:text-hub-text underline decoration-dotted underline-offset-2 cursor-pointer"
                >× Show all notes</button>
              </div>
            {/if}
            <div class="flex-1 min-h-0 relative">
              <VaultGraph
                nodes={displayGraph.nodes}
                edges={displayGraph.edges}
                onNodeClick={handleSelectNote}
              />
            </div>
          </div>
        {:else if view === 'note' && currentNote}
          <div class="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
            <div class="max-w-4xl mx-auto">
              <VaultNoteView
                note={currentNote}
                vaultDir={store.vaultDir}
                onNavigate={handleNavigate}
                onEdit={() => { view = 'edit'; }}
                onArchive={handleArchive}
                onLocalGraph={() => { if (store.selectedPath) showLocalGraph(store.selectedPath); }}
              />
            </div>
          </div>
        {:else if view === 'note' && !currentNote && noteError}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-center space-y-3">
              <div class="text-hub-muted">{noteError}</div>
              <button
                class="text-sm text-hub-accent hover:underline"
                onclick={() => store.selectedPath && fetchNote(store.selectedPath)}
              >Retry</button>
            </div>
          </div>
        {:else if view === 'note' && !currentNote}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-hub-muted animate-pulse">Loading note...</div>
          </div>
        {:else if view === 'edit' && currentNote}
          <div class="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
            <div class="max-w-4xl mx-auto">
              <VaultNoteEditor
                note={currentNote}
                onSave={handleNoteSaved}
                onCancel={() => { view = 'note'; }}
              />
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<VaultBulkBar
  selected={bulkSelected}
  onClear={() => { bulkSelected = new Set(); }}
  onDone={() => { store.invalidate('overview', 'recent'); }}
/>

{#if showSearch}
  <VaultSearch
    onSelect={(path) => { showSearch = false; handleSelectNote(path); }}
    onClose={() => { showSearch = false; }}
  />
{/if}

{#if showNewNote}
  <VaultNewNote
    onCreated={handleNoteCreated}
    onClose={() => { showNewNote = false; }}
  />
{/if}

{#if previewFile}
  <FilePreview
    filePath={previewFile.path}
    fileName={previewFile.name}
    onClose={() => { previewFile = null; }}
  />
{/if}

{#if showBrokenLinks}
  <VaultBrokenLinksDrawer
    onSelect={(path) => { showBrokenLinks = false; handleSelectNote(path); }}
    onClose={() => { showBrokenLinks = false; }}
  />
{/if}
