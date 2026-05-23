<script lang="ts">
  import { getVaultStore } from '$lib/vault/store.svelte.js';
  import { TYPE_COLORS, ZONE_COLORS } from '$lib/vault/types';
  import type { GraphNode } from '$lib/vault/types';

  interface Props {
    onSelect: (path: string) => void;
  }

  let { onSelect }: Props = $props();
  const store = getVaultStore();

  type SortKey = 'mtime' | 'title' | 'zone' | 'type' | 'degree';
  const PAGE_STEP = 50;

  let sortKey = $state<SortKey>('mtime');
  let sortDir = $state<'asc' | 'desc'>('desc');
  let pageSize = $state(PAGE_STEP);
  let loadingMore = $state(false);

  let scrollContainer: HTMLDivElement | undefined = $state();
  let sentinel: HTMLDivElement | undefined = $state();

  // Source: graphNodes is already filtered by store.setFilters()
  // and includes mtime, type, tags, zone, degree, created — everything we need.
  let rows = $derived.by(() => {
    const f = store.filters;
    const sinceCutoff = f.since ? Date.now() - f.since * 24 * 60 * 60 * 1000 : null;
    let list: GraphNode[] = [...store.graphNodes];
    // Defense in depth: graphNodes is filtered server-side by zone/type/tags,
    // but `since` is a client-only filter — apply here in case the graph was
    // loaded before `since` was set.
    if (sinceCutoff) list = list.filter(n => (n.mtime ?? 0) >= sinceCutoff);

    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      switch (sortKey) {
        case 'mtime':  return ((a.mtime ?? 0) - (b.mtime ?? 0)) * dir;
        case 'title':  return a.label.localeCompare(b.label) * dir;
        case 'zone':   return (a.zone ?? '').localeCompare(b.zone ?? '') * dir;
        case 'type':   return (a.type ?? '').localeCompare(b.type ?? '') * dir;
        case 'degree': return ((a.degree ?? 0) - (b.degree ?? 0)) * dir;
      }
    });
    return list;
  });

  let visibleRows = $derived(rows.slice(0, pageSize));
  let hasMore = $derived(rows.length > visibleRows.length);

  // Type/tags chips now live in the smart-views row (universal across all
  // views). The list header keeps only zone + since callouts because those
  // are not represented as chips in that row.
  let filterDescription = $derived.by(() => {
    const f = store.filters;
    const parts: string[] = [];
    if (f.zone) parts.push(`zone: ${f.zone}`);
    if (f.since) parts.push(f.since === 1 ? 'last 24h' : `last ${f.since} days`);
    return parts;
  });
  let hasActiveFilters = $derived.by(() => {
    const f = store.filters;
    const types = Array.isArray(f.type) ? f.type : f.type ? [f.type] : [];
    return Boolean(f.zone) || types.length > 0 || (f.tags?.length ?? 0) > 0 || Boolean(f.since);
  });

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = key === 'title' || key === 'zone' || key === 'type' ? 'asc' : 'desc';
    }
  }

  function clearFilters() {
    store.setFilters({});
  }

  function relativeTime(mtime: number | undefined): string {
    if (!mtime) return '—';
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

  // Reset paging when filters or sort change so the user starts fresh.
  $effect(() => {
    void store.filters;
    void sortKey;
    void sortDir;
    pageSize = PAGE_STEP;
    if (scrollContainer) scrollContainer.scrollTop = 0;
  });

  // Infinite scroll: when the sentinel enters the viewport, load the next page.
  // Using $effect (not onMount) because the sentinel lives inside {#if hasMore}
  // and graphNodes load asynchronously after the component mounts — onMount
  // would fire before graphNodes arrived and find sentinel === undefined.
  // Yield one frame via requestAnimationFrame so the spinner row paints before
  // the slice grows — without it, large jumps feel like teleportation.
  $effect(() => {
    const root = scrollContainer;
    const target = sentinel;
    if (!root || !target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && hasMore && !loadingMore) {
            loadingMore = true;
            requestAnimationFrame(() => {
              pageSize = pageSize + PAGE_STEP;
              loadingMore = false;
            });
          }
        }
      },
      { root, rootMargin: '300px 0px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  });
</script>

<div class="h-full flex flex-col bg-hub-bg">
  <!-- Result summary + filter readout -->
  <div class="flex-shrink-0 px-4 py-2 border-b border-hub-border bg-hub-surface/30 flex items-center gap-3 text-xs text-hub-dim flex-wrap">
    <span>
      <span class="text-hub-text font-medium">{rows.length}</span>
      {rows.length === 1 ? 'note' : 'notes'}
      {#if hasActiveFilters}<span class="text-hub-muted">·</span>{/if}
    </span>

    {#if hasActiveFilters}
      {#each filterDescription as part}
        <span class="px-2 py-0.5 rounded-md bg-hub-card border border-hub-border text-hub-muted">{part}</span>
      {/each}
      <button
        onclick={clearFilters}
        class="text-hub-muted hover:text-hub-text underline decoration-dotted underline-offset-2 cursor-pointer"
      >× Clear filters</button>
    {/if}

    <div class="flex-1"></div>

    {#if visibleRows.length < rows.length}
      <span class="hidden md:inline text-hub-dim/70">Showing {visibleRows.length} of {rows.length}</span>
    {/if}
    <span class="hidden md:inline">Sort: {sortKey} {sortDir === 'asc' ? '↑' : '↓'}</span>
  </div>

  <!-- Table -->
  <div bind:this={scrollContainer} class="flex-1 min-h-0 overflow-y-auto">
    {#if rows.length === 0}
      <div class="h-full flex items-center justify-center">
        <div class="text-center px-6">
          <svg class="w-10 h-10 mx-auto text-hub-dim mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
          <p class="text-sm text-hub-muted">No notes match the current filters.</p>
          {#if hasActiveFilters}
            <button
              onclick={clearFilters}
              class="mt-3 text-xs text-hub-cta hover:underline cursor-pointer"
            >Clear filters</button>
          {/if}
        </div>
      </div>
    {:else}
      <table class="w-full text-sm">
        <thead class="sticky top-0 bg-hub-bg border-b border-hub-border z-10">
          <tr class="text-left text-[11px] font-medium text-hub-dim uppercase tracking-wider">
            <th class="px-4 py-2 cursor-pointer hover:text-hub-text" onclick={() => toggleSort('title')}>
              Title {sortKey === 'title' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </th>
            <th class="px-3 py-2 cursor-pointer hover:text-hub-text w-28" onclick={() => toggleSort('type')}>
              Type {sortKey === 'type' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </th>
            <th class="px-3 py-2 cursor-pointer hover:text-hub-text w-28 hidden md:table-cell" onclick={() => toggleSort('zone')}>
              Zone {sortKey === 'zone' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </th>
            <th class="px-3 py-2 w-24 hidden lg:table-cell">Tags</th>
            <th class="px-3 py-2 cursor-pointer hover:text-hub-text w-20 text-right hidden md:table-cell" onclick={() => toggleSort('degree')}>
              Links {sortKey === 'degree' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </th>
            <th class="px-4 py-2 cursor-pointer hover:text-hub-text w-28 text-right" onclick={() => toggleSort('mtime')}>
              Modified {sortKey === 'mtime' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </th>
          </tr>
        </thead>
        <tbody>
          {#each visibleRows as node (node.id)}
            <tr
              class="border-b border-hub-border/40 hover:bg-hub-surface/40 cursor-pointer transition-colors"
              onclick={() => onSelect(node.id)}
            >
              <td class="px-4 py-2 max-w-0">
                <div class="flex items-center gap-2 min-w-0">
                  <span
                    class="flex-shrink-0 w-1.5 h-1.5 rounded-full"
                    style="background-color: {ZONE_COLORS[node.zone] ?? '#6b7280'}"
                  ></span>
                  <span class="truncate text-hub-text" style="unicode-bidi: plaintext;">{node.label}</span>
                </div>
                <div class="text-[10px] text-hub-dim truncate ml-3.5" style="unicode-bidi: plaintext;">{node.id}</div>
              </td>
              <td class="px-3 py-2">
                {#if node.type}
                  <span
                    class="inline-block text-[10px] px-1.5 py-0.5 rounded font-medium"
                    style="background-color: {(TYPE_COLORS[node.type] ?? '#6b7280')}26; color: {TYPE_COLORS[node.type] ?? '#9ca3af'}"
                  >
                    {node.type}
                  </span>
                {:else}
                  <span class="text-hub-dim text-xs">—</span>
                {/if}
              </td>
              <td class="px-3 py-2 hidden md:table-cell">
                <span class="text-xs text-hub-muted capitalize">{node.zone || '—'}</span>
              </td>
              <td class="px-3 py-2 hidden lg:table-cell">
                {#if node.tags && node.tags.length > 0}
                  <div class="flex gap-1 truncate">
                    {#each node.tags.slice(0, 2) as t}
                      <span class="text-[10px] text-hub-dim truncate">#{t}</span>
                    {/each}
                    {#if node.tags.length > 2}
                      <span class="text-[10px] text-hub-dim">+{node.tags.length - 2}</span>
                    {/if}
                  </div>
                {:else}
                  <span class="text-hub-dim text-xs">—</span>
                {/if}
              </td>
              <td class="px-3 py-2 text-right hidden md:table-cell">
                <span class="text-xs text-hub-muted font-mono">{node.degree ?? 0}</span>
              </td>
              <td class="px-4 py-2 text-right">
                <span class="text-xs text-hub-dim">{relativeTime(node.mtime)}</span>
              </td>
            </tr>
          {/each}
          {#if loadingMore}
            <tr>
              <td colspan="6" class="px-4 py-3 text-center text-xs text-hub-dim animate-pulse">Loading more…</td>
            </tr>
          {/if}
        </tbody>
      </table>

      <!-- Sentinel: when this enters the viewport, infinite-scroll triggers. -->
      {#if hasMore}
        <div bind:this={sentinel} class="h-1" aria-hidden="true"></div>
        <div class="px-4 py-3 text-center border-t border-hub-border/40 text-[11px] text-hub-dim">
          {rows.length - visibleRows.length} more · scroll to load
        </div>
      {:else if rows.length > PAGE_STEP}
        <div class="px-4 py-3 text-center text-[11px] text-hub-dim/70">End of {rows.length} notes</div>
      {/if}
    {/if}
  </div>
</div>
