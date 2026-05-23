<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    onSelect: (path: string) => void;
    onClose: () => void;
  }

  let { onSelect, onClose }: Props = $props();

  interface Unresolved { source: string; raw: string }

  let items = $state<Unresolved[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let query = $state('');

  let bySource = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? items.filter(it => it.source.toLowerCase().includes(q) || it.raw.toLowerCase().includes(q))
      : items;
    const groups = new Map<string, string[]>();
    for (const it of filtered) {
      const arr = groups.get(it.source);
      if (arr) arr.push(it.raw);
      else groups.set(it.source, [it.raw]);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  });

  async function load() {
    loading = true;
    loadError = null;
    try {
      const res = await fetch('/api/vault/unresolved');
      if (!res.ok) {
        loadError = `Failed to load (${res.status})`;
        return;
      }
      const data = await res.json();
      items = data.unresolved ?? [];
    } catch (e) {
      loadError = (e as Error).message || 'Network error';
    } finally {
      loading = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  onMount(() => { load(); });
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]" onkeydown={handleKeydown}>
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick={onClose}></div>

  <div class="relative w-full max-w-2xl mx-4 bg-hub-surface border border-hub-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
    <!-- Header -->
    <div class="flex items-center gap-3 px-4 py-3 border-b border-hub-border">
      <svg class="w-5 h-5 text-amber-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
      </svg>
      <div class="flex-1 min-w-0">
        <h2 class="text-sm font-semibold text-hub-text">Broken links</h2>
        <p class="text-xs text-hub-dim">
          {#if loading}Loading…{:else}{items.length} unresolved {items.length === 1 ? 'link' : 'links'} across {bySource.length} {bySource.length === 1 ? 'note' : 'notes'}{/if}
        </p>
      </div>
      <button
        onclick={onClose}
        class="text-hub-dim hover:text-hub-text transition-colors"
        aria-label="Close"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>

    <!-- Filter -->
    {#if !loading && items.length > 0}
      <div class="px-4 py-2 border-b border-hub-border">
        <input
          type="text"
          bind:value={query}
          placeholder="Filter by source path or link text…"
          class="w-full px-3 py-1.5 text-sm rounded bg-hub-bg border border-hub-border text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta"
        />
      </div>
    {/if}

    <!-- Body -->
    <div class="flex-1 overflow-y-auto">
      {#if loading}
        <div class="px-4 py-12 text-center text-sm text-hub-dim animate-pulse">Loading broken links…</div>
      {:else if loadError}
        <div class="px-4 py-12 text-center">
          <p class="text-sm text-hub-danger mb-2">{loadError}</p>
          <button onclick={load} class="text-xs text-hub-muted hover:text-hub-text underline">Retry</button>
        </div>
      {:else if items.length === 0}
        <div class="px-4 py-12 text-center">
          <svg class="w-10 h-10 mx-auto text-emerald-400/60 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/>
          </svg>
          <p class="text-sm text-hub-muted">No broken links — all clean.</p>
        </div>
      {:else if bySource.length === 0}
        <div class="px-4 py-12 text-center text-sm text-hub-dim">No matches.</div>
      {:else}
        <div class="divide-y divide-hub-border/50">
          {#each bySource as [source, raws] (source)}
            <div class="px-4 py-3">
              <button
                class="text-left w-full group"
                onclick={() => onSelect(source)}
              >
                <div class="flex items-center gap-2">
                  <span class="text-sm text-hub-text truncate group-hover:text-hub-cta transition-colors">
                    {source.split('/').pop()}
                  </span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium flex-shrink-0">
                    {raws.length} broken
                  </span>
                </div>
                <div class="text-xs text-hub-dim truncate">{source}</div>
              </button>
              <div class="mt-2 flex flex-wrap gap-1.5">
                {#each raws as raw}
                  <span class="text-[11px] px-2 py-0.5 rounded bg-hub-card border border-hub-border text-hub-muted font-mono">
                    [[{raw}]]
                  </span>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Footer -->
    <div class="px-4 py-2 border-t border-hub-border flex items-center gap-3 text-[10px] text-hub-dim">
      <span>Click a note title to open it and fix its links</span>
      <div class="flex-1"></div>
      <span><kbd class="bg-hub-bg px-1 rounded">esc</kbd> close</span>
    </div>
  </div>
</div>
