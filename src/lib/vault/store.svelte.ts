// src/lib/vault/store.svelte.ts
import type { VaultNote, VaultStats, GraphData, GraphNode, GraphEdge, SearchResult, VaultZone } from './types.js';

// ── Singleton state ──
let stats = $state<VaultStats | null>(null);
let zones = $state<VaultZone[]>([]);
let vaultDir = $state('');
let pipelinesDir = $state('');
let recentNotes = $state<VaultNote[]>([]);
let graphNodes = $state<GraphNode[]>([]);
let graphEdges = $state<GraphEdge[]>([]);
let selectedNote = $state<VaultNote | null>(null);
let selectedPath = $state<string | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let filters = $state<{ zone?: string; type?: string | string[]; tags?: string[]; since?: number }>({});

// ── AbortController pool ──
const controllers = new Map<string, AbortController>();

function abortAndReplace(key: string, timeoutMs = 10000): AbortSignal {
  controllers.get(key)?.abort();
  const c = new AbortController();
  controllers.set(key, c);
  setTimeout(() => c.abort(), timeoutMs);
  return c.signal;
}

// ── Fetch functions ──

async function fetchOverview(): Promise<void> {
  try {
    const signal = abortAndReplace('overview', 5000);
    const res = await fetch('/api/vault', { signal });
    if (!res.ok) { error = 'Vault not ready'; return; }
    const data = await res.json();
    stats = data.stats;
    zones = data.zones;
    vaultDir = data.paths?.vaultDir || '';
    pipelinesDir = data.paths?.pipelinesDir || '';
    error = null;
  } catch (e) {
    if ((e as Error).name !== 'AbortError') error = 'Failed to load vault';
  } finally {
    loading = false;
  }
}

async function fetchRecent(): Promise<void> {
  try {
    const signal = abortAndReplace('recent', 5000);
    const res = await fetch('/api/vault/recent?limit=50', { signal });
    if (res.ok) {
      const data = await res.json();
      recentNotes = data.notes ?? data;
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') { /* silent */ }
  }
}

async function fetchGraph(opts?: { zone?: string; type?: string | string[]; tags?: string[]; since?: number; project?: string }): Promise<void> {
  const params = new URLSearchParams();
  if (opts?.zone) params.set('zone', opts.zone);
  if (opts?.type) {
    const types = Array.isArray(opts.type) ? opts.type : [opts.type];
    params.set('type', types.join(','));
  }
  if (opts?.tags) params.set('tags', opts.tags.join(','));
  if (opts?.project) params.set('project', opts.project);
  const url = `/api/vault/graph${params.toString() ? '?' + params : ''}`;
  try {
    const signal = abortAndReplace('graph');
    const res = await fetch(url, { signal });
    if (res.ok) {
      const data = await res.json();
      let nodes: GraphNode[] = data.nodes;
      let edges: GraphEdge[] = data.edges;
      const filterTypes = opts?.type ? (Array.isArray(opts.type) ? opts.type : [opts.type]) : null;
      const filterTags = opts?.tags && opts.tags.length > 0 ? opts.tags : null;
      const sinceCutoff = opts?.since ? Date.now() - opts.since * 24 * 60 * 60 * 1000 : null;
      if (filterTypes || filterTags || sinceCutoff) {
        const matchIds = new Set(
          nodes.filter(n => {
            if (filterTypes && !(n.type && filterTypes.includes(n.type))) return false;
            if (filterTags && !(n.tags && filterTags.every(t => n.tags!.includes(t)))) return false;
            if (sinceCutoff && (n.mtime ?? 0) < sinceCutoff) return false;
            return true;
          }).map(n => n.id)
        );
        nodes = nodes.filter(n => matchIds.has(n.id));
        edges = edges.filter(e => matchIds.has(e.source) && matchIds.has(e.target));

        // Re-normalize node sizes for the filtered set so small nodes become visible
        if (nodes.length > 0) {
          const MIN_SIZE = 6;
          const MAX_SIZE = 18;
          const maxDegree = Math.max(1, ...nodes.map(n => n.degree ?? 0));
          for (const node of nodes) {
            node.size = MIN_SIZE + ((node.degree ?? 0) / maxDegree) * (MAX_SIZE - MIN_SIZE);
          }
        }
      }
      graphNodes = nodes;
      graphEdges = edges;
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') { /* silent */ }
  }
}

async function fetchNote(path: string): Promise<void> {
  selectedPath = path;
  try {
    const signal = abortAndReplace('note', 5000);
    const url = `/api/vault/notes/${path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, { signal });
    if (res.ok) {
      selectedNote = await res.json();
    } else if (res.status === 404) {
      selectedNote = null;
      error = `Note not found: ${path}`;
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') { /* silent */ }
  }
}

// ── Invalidation ──
// Components call this after mutations to refresh the right data.
// Debounces graph refreshes to prevent rapid rebuilds.

let graphDebounce: ReturnType<typeof setTimeout> | undefined;

async function invalidate(...targets: ('overview' | 'recent' | 'graph' | 'note')[]): Promise<void> {
  const promises: Promise<void>[] = [];

  if (targets.includes('overview')) promises.push(fetchOverview());
  if (targets.includes('recent')) promises.push(fetchRecent());
  if (targets.includes('graph')) {
    clearTimeout(graphDebounce);
    await new Promise<void>(resolve => {
      graphDebounce = setTimeout(async () => {
        await fetchGraph(filters);
        resolve();
      }, 300);
    });
  }
  if (targets.includes('note') && selectedPath) promises.push(fetchNote(selectedPath));

  await Promise.all(promises);
}

// ── Mutations ──

async function selectNote(path: string): Promise<void> {
  await fetchNote(path);
}

function clearSelection(): void {
  selectedNote = null;
  selectedPath = null;
}

function setFilters(f: { zone?: string; type?: string | string[]; tags?: string[]; since?: number }): void {
  filters = f;
  fetchGraph(f);
}

// ── Lifecycle ──

async function init(): Promise<void> {
  await fetchOverview();
  await Promise.all([fetchRecent(), fetchGraph()]);
}

function destroy(): void {
  for (const c of controllers.values()) c.abort();
  controllers.clear();
  clearTimeout(graphDebounce);
}

// ── Public API ──
// Export a function that returns the reactive state + actions.
// Components call getVaultStore() to access everything.

export function getVaultStore() {
  return {
    // Reactive state (read by components)
    get stats() { return stats; },
    get zones() { return zones; },
    get vaultDir() { return vaultDir; },
    get pipelinesDir() { return pipelinesDir; },
    get recentNotes() { return recentNotes; },
    get graphNodes() { return graphNodes; },
    get graphEdges() { return graphEdges; },
    get selectedNote() { return selectedNote; },
    get selectedPath() { return selectedPath; },
    get loading() { return loading; },
    get error() { return error; },
    get filters() { return filters; },

    // Actions
    init,
    destroy,
    invalidate,
    selectNote,
    clearSelection,
    setFilters,
    fetchGraph,
    fetchNote,
    fetchRecent,
  };
}
