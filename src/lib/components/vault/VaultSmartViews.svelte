<script lang="ts">
  import { onMount } from 'svelte';

  interface SmartView {
    name: string;
    icon: string;
    filters: { zone?: string; type?: string[]; tags?: string[]; since?: number };
  }

  interface Props {
    activeFilters: { zone?: string; type?: string | string[]; tags?: string[]; since?: number };
    allTags: Record<string, number>;
    /** Note types known to exist in the vault (for the ad-hoc Type popover). */
    allTypes?: string[];
    /** Tag names known to exist in the vault (for the ad-hoc Tags popover). */
    allTagsList?: string[];
    onApply: (filters: { zone?: string; type?: string[]; tags?: string[]; since?: number }) => void;
    /** Ad-hoc filter changes — type/tags only; zone/since flow through onApply. */
    onAdHocFilterChange?: (f: { type?: string[]; tags?: string[] }) => void;
  }

  let {
    activeFilters,
    allTags = {},
    allTypes = [],
    allTagsList = [],
    onApply,
    onAdHocFilterChange,
  }: Props = $props();

  let views = $state<SmartView[]>([
    { name: 'All', icon: 'list', filters: {} },
  ]);

  // Editor state
  let showEditor = $state(false);
  let editIndex = $state<number | null>(null);
  let editName = $state('');
  let editIcon = $state('list');
  let editZone = $state('');
  let editTypes = $state('');
  let editTags = $state('');
  let editSince = $state(0);
  let contextMenu = $state<{ x: number; y: number; index: number } | null>(null);

  const ICONS: Record<string, string> = {
    list: 'M4 6h16M4 12h16M4 18h16',
    bolt: 'M13 10V3L4 14h7v7l9-11h-7z',
    book: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
    edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
    settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
    calendar: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
    star: 'M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z',
    tag: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z',
    folder: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
    inbox: 'M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4',
    heart: 'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z',
    code: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
    globe: 'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9',
    users: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
  };

  const ZONES = ['inbox', 'finance', 'security', 'projects', 'knowledge', 'content', 'operations', 'archive'];
  const TYPES = ['learning', 'decision', 'debugging', 'pattern', 'research', 'output', 'snippet',
    'report', 'recipe', 'draft', 'social-draft', 'article-draft', 'video-script',
    'agent-profile', 'config', 'project', 'index', 'reference', 'guide'];

  onMount(async () => {
    try {
      const res = await fetch('/api/vault/smart-views');
      if (res.ok) views = await res.json();
    } catch { /* use defaults */ }
  });

  async function saveViews() {
    try {
      await fetch('/api/vault/smart-views', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(views),
      });
    } catch { /* silent */ }
  }

  function openEditor(index: number | null = null) {
    contextMenu = null;
    if (index !== null && index < views.length) {
      const v = views[index];
      editIndex = index;
      editName = v.name;
      editIcon = v.icon;
      editZone = v.filters.zone || '';
      editTypes = (v.filters.type || []).join(', ');
      editTags = (v.filters.tags || []).join(', ');
      editSince = v.filters.since || 0;
    } else {
      editIndex = null;
      editName = '';
      editIcon = 'tag';
      editZone = '';
      editTypes = '';
      editTags = '';
      editSince = 0;
    }
    showEditor = true;
  }

  function saveView() {
    const filters: SmartView['filters'] = {};
    if (editZone) filters.zone = editZone;
    const types = editTypes.split(',').map(s => s.trim()).filter(Boolean);
    if (types.length > 0) filters.type = types;
    const tags = editTags.split(',').map(s => s.trim()).filter(Boolean);
    if (tags.length > 0) filters.tags = tags;
    if (editSince > 0) filters.since = editSince;

    const view: SmartView = { name: editName || 'Untitled', icon: editIcon, filters };

    if (editIndex !== null) {
      views[editIndex] = view;
      views = [...views]; // trigger reactivity
    } else {
      views = [...views, view];
    }

    showEditor = false;
    saveViews();
  }

  function deleteView(index: number) {
    contextMenu = null;
    views = views.filter((_, i) => i !== index);
    saveViews();
  }

  function handleContextMenu(e: MouseEvent, index: number) {
    if (index === 0 && views[0]?.name === 'All') return; // Don't edit "All"
    e.preventDefault();
    contextMenu = { x: e.clientX, y: e.clientY, index };
  }

  function closeContextMenu() {
    contextMenu = null;
  }

  function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  }

  function isActive(view: SmartView): boolean {
    const f = activeFilters;
    const vf = view.filters;
    const activeType = f.type ? (Array.isArray(f.type) ? f.type : [f.type]) : undefined;
    const viewType = vf.type && vf.type.length > 0 ? vf.type : undefined;
    const activeTags = f.tags && f.tags.length > 0 ? f.tags : undefined;
    const viewTags = vf.tags && vf.tags.length > 0 ? vf.tags : undefined;
    return (f.zone ?? undefined) === (vf.zone ?? undefined)
      && arraysEqual(activeType, viewType)
      && arraysEqual(activeTags, viewTags)
      && (f.since ?? 0) === (vf.since ?? 0);
  }

  // Top tags for suggestions in editor
  const topTags = $derived(
    Object.entries(allTags)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name]) => name)
  );

  // ── Ad-hoc filter state (lifted from the deleted VaultCommandBar) ──
  // Type/Tags multi-select popovers that live in the smart-views row,
  // alongside saved presets — single canonical filter region.
  let showTypePopover = $state(false);
  let showTagPopover = $state(false);
  let typeSearch = $state('');
  let tagSearch = $state('');

  // The smart-views toolbar uses overflow-x-auto, which forces overflow-y to
  // clip too — popovers positioned `absolute` inside it get cropped at the
  // toolbar's bottom edge. Use position:fixed and re-compute coords from the
  // trigger button so the popovers escape the clipping container.
  let typeBtnEl: HTMLButtonElement | undefined = $state();
  let tagBtnEl: HTMLButtonElement | undefined = $state();
  let typePopoverStyle = $state('');
  let tagPopoverStyle = $state('');

  function updateTypePopoverPos() {
    if (!typeBtnEl) return;
    const r = typeBtnEl.getBoundingClientRect();
    typePopoverStyle = `top: ${r.bottom + 4}px; left: ${r.left}px;`;
  }

  function updateTagPopoverPos() {
    if (!tagBtnEl) return;
    const r = tagBtnEl.getBoundingClientRect();
    tagPopoverStyle = `top: ${r.bottom + 4}px; right: ${window.innerWidth - r.right}px;`;
  }

  $effect(() => {
    if (!showTypePopover) return;
    updateTypePopoverPos();
    window.addEventListener('scroll', updateTypePopoverPos, true);
    window.addEventListener('resize', updateTypePopoverPos);
    return () => {
      window.removeEventListener('scroll', updateTypePopoverPos, true);
      window.removeEventListener('resize', updateTypePopoverPos);
    };
  });

  $effect(() => {
    if (!showTagPopover) return;
    updateTagPopoverPos();
    window.addEventListener('scroll', updateTagPopoverPos, true);
    window.addEventListener('resize', updateTagPopoverPos);
    return () => {
      window.removeEventListener('scroll', updateTagPopoverPos, true);
      window.removeEventListener('resize', updateTagPopoverPos);
    };
  });

  let activeAdHocTypes = $derived.by(() => {
    const t = activeFilters.type;
    if (!t) return [] as string[];
    return Array.isArray(t) ? t : [t];
  });
  let activeAdHocTags = $derived(activeFilters.tags ?? []);

  // Click-outside helper for the popovers.
  function clickOutside(node: HTMLElement, callback: () => void) {
    function handleClick(e: MouseEvent) {
      if (!node.contains(e.target as Node)) callback();
    }
    document.addEventListener('click', handleClick, true);
    return { destroy() { document.removeEventListener('click', handleClick, true); } };
  }

  // Type categories — same buckets the deleted CommandBar used so users see
  // a familiar grouping when constructing ad-hoc filters.
  const typeCategories: Record<string, string[]> = {
    Knowledge: ['research', 'pattern', 'snippet', 'decision', 'review', 'recipe', 'report', 'analysis', 'evaluation', 'data-pack', 'reference', 'guide', 'wiki'],
    Content: ['draft', 'social-draft', 'social-post', 'article-draft', 'video-script', 'video-script-draft', 'content-menu', 'content-prep', 'ideas', 'daily-quote', 'media-asset', 'insight-draft', 'miner-report', 'signal-report', 'strategist-prep'],
    Project: ['project', 'learning', 'debugging', 'output', 'index', 'task', 'design', 'requirements'],
    Operations: ['agent-profile', 'config', 'session-log', 'playbook', 'system-config', 'identity', 'boundaries'],
  };

  let filteredTypesBySearch = $derived.by(() => {
    const q = typeSearch.toLowerCase();
    return q ? allTypes.filter((t) => t.toLowerCase().includes(q)) : allTypes;
  });

  let filteredTagsBySearch = $derived.by(() => {
    const q = tagSearch.toLowerCase();
    return q ? allTagsList.filter((t) => t.toLowerCase().includes(q)) : allTagsList;
  });

  let groupedTypes = $derived.by(() => {
    const available = new Set(filteredTypesBySearch);
    const groups: { name: string; types: string[] }[] = [];
    const categorized = new Set<string>();
    for (const [cat, types] of Object.entries(typeCategories)) {
      const matching = types.filter((t) => available.has(t));
      if (matching.length > 0) {
        groups.push({ name: cat, types: matching });
        matching.forEach((t) => categorized.add(t));
      }
    }
    const uncategorized = filteredTypesBySearch.filter((t) => !categorized.has(t));
    if (uncategorized.length > 0) groups.push({ name: 'Other', types: uncategorized });
    return groups;
  });

  function emitAdHoc(next: { type?: string[]; tags?: string[] }) {
    onAdHocFilterChange?.({
      type: next.type ?? activeAdHocTypes,
      tags: next.tags ?? activeAdHocTags,
    });
  }

  function toggleType(t: string) {
    const next = activeAdHocTypes.includes(t)
      ? activeAdHocTypes.filter((x) => x !== t)
      : [...activeAdHocTypes, t];
    emitAdHoc({ type: next });
  }

  function toggleTag(t: string) {
    const next = activeAdHocTags.includes(t)
      ? activeAdHocTags.filter((x) => x !== t)
      : [...activeAdHocTags, t];
    emitAdHoc({ tags: next });
  }

  function removeChip(kind: 'type' | 'tag', value: string) {
    if (kind === 'type') emitAdHoc({ type: activeAdHocTypes.filter((x) => x !== value) });
    else emitAdHoc({ tags: activeAdHocTags.filter((x) => x !== value) });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="flex items-center gap-1.5 px-4 py-2 border-b border-hub-border bg-hub-bg/50 overflow-x-auto scrollbar-thin"
  onclick={closeContextMenu}
  role="toolbar"
>
  {#each views as view, i}
    <div class="flex-shrink-0 relative group">
      <button
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150 cursor-pointer
          {isActive(view) ? 'bg-hub-cta/15 text-hub-cta border border-hub-cta/30' : 'text-hub-muted hover:text-hub-text hover:bg-hub-card border border-transparent'}
          focus:ring-2 focus:ring-blue-500 focus:outline-none"
        onclick={() => onApply(view.filters)}
        oncontextmenu={(e) => handleContextMenu(e, i)}
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={ICONS[view.icon] || ICONS.tag} />
        </svg>
        {view.name}
      </button>
      {#if !(i === 0 && view.name === 'All')}
        <button
          class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-hub-card border border-hub-border text-hub-dim hover:text-hub-text hover:bg-hub-surface opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer"
          onclick={(e) => { e.stopPropagation(); openEditor(i); }}
          title="Edit view"
        >
          <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </button>
      {/if}
    </div>
  {/each}

  <!-- Add button -->
  <button
    class="flex-shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-hub-dim hover:text-hub-muted hover:bg-hub-card border border-transparent transition-colors cursor-pointer"
    onclick={() => openEditor(null)}
    title="Add smart view"
  >
    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
    </svg>
  </button>

  <!-- Divider before ad-hoc filter section -->
  {#if onAdHocFilterChange}
    <span class="flex-shrink-0 w-px h-5 bg-hub-border mx-1" aria-hidden="true"></span>

    <!-- Active ad-hoc filter chips (universal across views — graph, list, note all see them) -->
    {#each activeAdHocTypes as t (t)}
      <span class="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-violet-500/15 text-violet-400 text-[11px] font-medium">
        type: {t}
        <button
          class="ml-0.5 hover:text-violet-200 cursor-pointer"
          onclick={() => removeChip('type', t)}
          aria-label="Remove type filter {t}"
        >
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </span>
    {/each}
    {#each activeAdHocTags as t (t)}
      <span class="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400 text-[11px] font-medium">
        #{t}
        <button
          class="ml-0.5 hover:text-emerald-200 cursor-pointer"
          onclick={() => removeChip('tag', t)}
          aria-label="Remove tag filter {t}"
        >
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </span>
    {/each}

    <!-- Type multi-select trigger -->
    <div class="flex-shrink-0 relative" use:clickOutside={() => { showTypePopover = false; typeSearch = ''; }}>
      <button
        bind:this={typeBtnEl}
        class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] cursor-pointer transition-colors duration-150 border
          {activeAdHocTypes.length > 0 ? 'border-hub-border bg-hub-card text-hub-text' : 'border-transparent text-hub-dim hover:text-hub-muted hover:bg-hub-card'}"
        onclick={() => {
          const next = !showTypePopover;
          showTagPopover = false;
          if (next) updateTypePopoverPos();
          showTypePopover = next;
        }}
        aria-expanded={showTypePopover}
        aria-haspopup="listbox"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
        </svg>
        Type{activeAdHocTypes.length > 0 ? ` · ${activeAdHocTypes.length}` : ''}
        <svg class="w-3 h-3 text-hub-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {#if showTypePopover}
        <div class="fixed z-50 w-[260px] rounded-lg bg-hub-card border border-hub-border shadow-lg" style={typePopoverStyle}>
          <div class="p-2 border-b border-hub-border">
            <input
              type="text"
              bind:value={typeSearch}
              placeholder="Filter types..."
              class="w-full px-2 py-1.5 text-sm rounded bg-hub-bg border border-hub-border text-hub-text placeholder:text-hub-dim focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>
          <div class="max-h-64 overflow-y-auto py-1">
            {#each groupedTypes as group}
              <div class="px-3 pt-2 pb-1 text-xs font-medium text-hub-dim uppercase tracking-wider">{group.name}</div>
              {#each group.types as t}
                <label class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-hub-surface/50">
                  <input
                    type="checkbox"
                    checked={activeAdHocTypes.includes(t)}
                    onchange={() => toggleType(t)}
                    class="rounded border-hub-border text-hub-cta focus:ring-blue-500 cursor-pointer"
                  />
                  <span class={activeAdHocTypes.includes(t) ? 'text-hub-text' : 'text-hub-muted'}>{t}</span>
                </label>
              {/each}
            {/each}
            {#if groupedTypes.length === 0}
              <div class="px-3 py-2 text-sm text-hub-dim">No types match</div>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    <!-- Tags multi-select trigger -->
    <div class="flex-shrink-0 relative" use:clickOutside={() => { showTagPopover = false; tagSearch = ''; }}>
      <button
        bind:this={tagBtnEl}
        class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] cursor-pointer transition-colors duration-150 border
          {activeAdHocTags.length > 0 ? 'border-hub-border bg-hub-card text-hub-text' : 'border-transparent text-hub-dim hover:text-hub-muted hover:bg-hub-card'}"
        onclick={() => {
          const next = !showTagPopover;
          showTypePopover = false;
          if (next) updateTagPopoverPos();
          showTagPopover = next;
        }}
        aria-expanded={showTagPopover}
        aria-haspopup="listbox"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
        </svg>
        Tags{activeAdHocTags.length > 0 ? ` · ${activeAdHocTags.length}` : ''}
        <svg class="w-3 h-3 text-hub-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {#if showTagPopover}
        <div class="fixed z-50 w-[240px] rounded-lg bg-hub-card border border-hub-border shadow-lg" style={tagPopoverStyle}>
          <div class="p-2 border-b border-hub-border">
            <input
              type="text"
              bind:value={tagSearch}
              placeholder="Filter tags..."
              class="w-full px-2 py-1.5 text-sm rounded bg-hub-bg border border-hub-border text-hub-text placeholder:text-hub-dim focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>
          <div class="max-h-64 overflow-y-auto py-1">
            {#each filteredTagsBySearch as t}
              <label class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-hub-surface/50">
                <input
                  type="checkbox"
                  checked={activeAdHocTags.includes(t)}
                  onchange={() => toggleTag(t)}
                  class="rounded border-hub-border text-hub-cta focus:ring-blue-500 cursor-pointer"
                />
                <span class={activeAdHocTags.includes(t) ? 'text-hub-text' : 'text-hub-muted'}>{t}</span>
              </label>
            {/each}
            {#if filteredTagsBySearch.length === 0}
              <div class="px-3 py-2 text-sm text-hub-dim">No tags match</div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<!-- Context menu -->
{#if contextMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed z-50 bg-hub-surface border border-hub-border rounded-lg shadow-xl py-1 min-w-[120px]"
    style="left: {contextMenu.x}px; top: {contextMenu.y}px"
    onclick={(e) => e.stopPropagation()}
  >
    <button class="w-full px-3 py-1.5 text-xs text-left text-hub-text hover:bg-hub-card cursor-pointer" onclick={() => openEditor(contextMenu?.index ?? 0)}>
      Edit
    </button>
    <button class="w-full px-3 py-1.5 text-xs text-left text-hub-danger hover:bg-hub-card cursor-pointer" onclick={() => deleteView(contextMenu?.index ?? 0)}>
      Delete
    </button>
  </div>
{/if}

<!-- Editor modal -->
{#if showEditor}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onclick={() => { showEditor = false; }}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="bg-hub-surface border border-hub-border rounded-xl p-5 w-full max-w-md shadow-2xl" onclick={(e) => e.stopPropagation()}>
      <h3 class="text-sm font-semibold text-hub-text mb-4">
        {editIndex !== null ? 'Edit Smart View' : 'New Smart View'}
      </h3>

      <!-- Name -->
      <label class="block mb-3">
        <span class="text-xs text-hub-dim mb-1 block">Name</span>
        <input
          type="text"
          bind:value={editName}
          placeholder="My View"
          class="w-full px-3 py-1.5 text-sm bg-hub-card border border-hub-border rounded-lg text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta"
        />
      </label>

      <!-- Icon picker -->
      <label class="block mb-3">
        <span class="text-xs text-hub-dim mb-1 block">Icon</span>
        <div class="flex flex-wrap gap-1.5">
          {#each Object.keys(ICONS) as iconName}
            <button
              class="p-1.5 rounded-md border transition-colors cursor-pointer
                {editIcon === iconName ? 'border-hub-cta bg-hub-cta/10 text-hub-cta' : 'border-hub-border text-hub-dim hover:text-hub-muted'}"
              onclick={() => { editIcon = iconName; }}
              title={iconName}
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={ICONS[iconName]} />
              </svg>
            </button>
          {/each}
        </div>
      </label>

      <!-- Zone -->
      <label class="block mb-3">
        <span class="text-xs text-hub-dim mb-1 block">Zone (optional)</span>
        <select
          bind:value={editZone}
          class="w-full px-3 py-1.5 text-sm bg-hub-card border border-hub-border rounded-lg text-hub-text focus:outline-none focus:border-hub-cta"
        >
          <option value="">Any zone</option>
          {#each ZONES as z}
            <option value={z}>{z}</option>
          {/each}
        </select>
      </label>

      <!-- Date range -->
      <label class="block mb-3">
        <span class="text-xs text-hub-dim mb-1 block">Modified within</span>
        <div class="flex flex-wrap gap-1.5">
          {#each [
            { label: 'Any time', value: 0 },
            { label: 'Today', value: 1 },
            { label: '3 days', value: 3 },
            { label: 'This week', value: 7 },
            { label: '2 weeks', value: 14 },
            { label: 'This month', value: 30 },
            { label: '3 months', value: 90 },
          ] as opt}
            <button
              class="px-2 py-1 text-[11px] rounded-md border transition-colors cursor-pointer
                {editSince === opt.value ? 'border-hub-cta bg-hub-cta/10 text-hub-cta' : 'border-hub-border text-hub-dim hover:text-hub-muted'}"
              onclick={() => { editSince = opt.value; }}
            >{opt.label}</button>
          {/each}
        </div>
      </label>

      <!-- Types -->
      <label class="block mb-3">
        <span class="text-xs text-hub-dim mb-1 block">Types (comma-separated)</span>
        <input
          type="text"
          bind:value={editTypes}
          placeholder="e.g. learning, pattern, decision"
          class="w-full px-3 py-1.5 text-sm bg-hub-card border border-hub-border rounded-lg text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta"
        />
        <div class="flex flex-wrap gap-1 mt-1.5">
          {#each TYPES.slice(0, 12) as t}
            <button
              class="px-1.5 py-0.5 text-[10px] rounded cursor-pointer transition-colors
                {editTypes.includes(t) ? 'bg-hub-cta/20 text-hub-cta' : 'bg-hub-card text-hub-dim hover:text-hub-muted'}"
              onclick={() => {
                const current = editTypes.split(',').map(s => s.trim()).filter(Boolean);
                if (current.includes(t)) {
                  editTypes = current.filter(c => c !== t).join(', ');
                } else {
                  editTypes = [...current, t].join(', ');
                }
              }}
            >{t}</button>
          {/each}
        </div>
      </label>

      <!-- Tags -->
      <label class="block mb-4">
        <span class="text-xs text-hub-dim mb-1 block">Tags (comma-separated)</span>
        <input
          type="text"
          bind:value={editTags}
          placeholder="e.g. signal-forge, email"
          class="w-full px-3 py-1.5 text-sm bg-hub-card border border-hub-border rounded-lg text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta"
        />
        {#if topTags.length > 0}
          <div class="flex flex-wrap gap-1 mt-1.5">
            {#each topTags.slice(0, 12) as t}
              <button
                class="px-1.5 py-0.5 text-[10px] rounded cursor-pointer transition-colors
                  {editTags.includes(t) ? 'bg-hub-info/20 text-hub-info' : 'bg-hub-card text-hub-dim hover:text-hub-muted'}"
                onclick={() => {
                  const current = editTags.split(',').map(s => s.trim()).filter(Boolean);
                  if (current.includes(t)) {
                    editTags = current.filter(c => c !== t).join(', ');
                  } else {
                    editTags = [...current, t].join(', ');
                  }
                }}
              >{t}</button>
            {/each}
          </div>
        {/if}
      </label>

      <!-- Actions -->
      <div class="flex items-center gap-2">
        {#if editIndex !== null && editIndex > 0}
          <button
            class="px-3 py-1.5 text-xs rounded-lg text-hub-danger hover:bg-hub-danger/10 border border-hub-danger/30 cursor-pointer"
            onclick={() => { if (editIndex !== null) { deleteView(editIndex); showEditor = false; } }}
          >Delete</button>
        {/if}
        <div class="flex-1"></div>
        <button
          class="px-3 py-1.5 text-xs rounded-lg text-hub-muted hover:text-hub-text bg-hub-card border border-hub-border cursor-pointer"
          onclick={() => { showEditor = false; }}
        >Cancel</button>
        <button
          class="px-3 py-1.5 text-xs rounded-lg text-white bg-hub-cta hover:bg-hub-cta/80 cursor-pointer"
          onclick={saveView}
        >Save</button>
      </div>
    </div>
  </div>
{/if}
