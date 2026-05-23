<script lang="ts">
  import { getVaultStore } from '$lib/vault/store.svelte.js';

  const store = getVaultStore();

  interface Props {
    selected: Set<string>;
    onClear: () => void;
    onDone: () => void;
  }

  let { selected, onClear, onDone }: Props = $props();

  let showMoveDropdown = $state(false);
  let actionLoading = $state(false);
  let toast = $state<string | null>(null);

  const zones = ['inbox', 'finance', 'security', 'projects', 'knowledge', 'content', 'operations', 'archive'];

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

  function showToast(msg: string) {
    toast = msg;
    setTimeout(() => { toast = null; }, 3000);
  }

  async function moveSelected(targetZone: string) {
    showMoveDropdown = false;
    actionLoading = true;
    let moved = 0;
    for (const path of selected) {
      try {
        const res = await fetch(`/api/vault/notes/${path.split('/').map(encodeURIComponent).join('/')}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ move: targetZone }),
        });
        // If PUT doesn't support move, use a dedicated move approach
        if (!res.ok) {
          // Try the move via archive/re-create pattern
          const noteRes = await fetch(`/api/vault/notes/${path.split('/').map(encodeURIComponent).join('/')}`);
          if (noteRes.ok) {
            const note = await noteRes.json();
            const filename = path.split('/').pop()!;
            // Create in new zone
            const createRes = await fetch('/api/vault/notes', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                zone: targetZone,
                filename,
                meta: note.meta,
                content: note.content,
              }),
            });
            if (createRes.ok) {
              // Delete from old location
              await fetch(`/api/vault/notes/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
              moved++;
            }
          }
        } else {
          moved++;
        }
      } catch { /* skip failed */ }
    }
    actionLoading = false;
    showToast(`${moved} note${moved === 1 ? '' : 's'} moved to ${targetZone}/`);
    onClear();
    await store.invalidate('overview', 'recent', 'graph');
    onDone();
  }

  async function archiveSelected() {
    actionLoading = true;
    let archived = 0;
    for (const path of selected) {
      try {
        const res = await fetch(`/api/vault/notes/${path.split('/').map(encodeURIComponent).join('/')}`, {
          method: 'DELETE',
        });
        if (res.ok) archived++;
      } catch { /* skip */ }
    }
    actionLoading = false;
    showToast(`${archived} note${archived === 1 ? '' : 's'} archived`);
    onClear();
    await store.invalidate('overview', 'recent', 'graph');
    onDone();
  }
</script>

{#if selected.size > 0}
  <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2.5 rounded-xl bg-hub-surface border border-hub-border shadow-xl">
    <span class="text-sm text-hub-text font-medium">{selected.size} selected</span>

    <!-- Move -->
    <div class="relative">
      <button
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-hub-card border border-hub-border text-hub-muted hover:text-hub-text transition-colors cursor-pointer"
        onclick={() => { showMoveDropdown = !showMoveDropdown; }}
        disabled={actionLoading}
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
        </svg>
        Move
      </button>
      {#if showMoveDropdown}
        <div class="absolute bottom-full mb-1 left-0 z-50 min-w-[150px] rounded-lg bg-hub-card border border-hub-border shadow-lg py-1">
          {#each zones as z}
            <button
              class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left cursor-pointer transition-colors hover:bg-hub-surface/50 {zoneColors[z]}"
              onclick={() => moveSelected(z)}
            >
              <span class="capitalize">{z}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Archive -->
    <button
      class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-hub-card border border-hub-border text-hub-warning hover:text-hub-danger transition-colors cursor-pointer"
      onclick={archiveSelected}
      disabled={actionLoading}
    >
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/>
      </svg>
      Archive
    </button>

    <!-- Clear -->
    <button
      class="p-1.5 rounded-lg text-hub-dim hover:text-hub-text transition-colors cursor-pointer"
      onclick={onClear}
      aria-label="Clear selection"
    >
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
      </svg>
    </button>

    {#if actionLoading}
      <div class="text-xs text-hub-muted animate-pulse">Working...</div>
    {/if}
  </div>
{/if}

{#if toast}
  <div class="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-hub-cta text-black text-sm font-medium shadow-lg">
    {toast}
  </div>
{/if}
