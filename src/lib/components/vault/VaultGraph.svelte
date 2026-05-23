<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { GraphNode, GraphEdge } from '$lib/vault/types';
  import { computeNetworkLayout } from '$lib/projects/dagre-layout.js';

  interface Props {
    nodes: GraphNode[];
    edges: GraphEdge[];
    onNodeClick: (path: string) => void;
    /** projects-graph ADR-005 — layout mode.
     *  - `'force'` (default): random seed + forceAtlas2 post-layout. Used
     *    by `/vault` for note-level wikilink graphs. Behaviour unchanged
     *    from pre-ADR-005.
     *  - `'hierarchical'`: dagre Sugiyama (left-to-right rank-by-rank);
     *    reuses ADR-016's `computeNetworkLayout`. Used by `/projects?view=graph`
     *    for project-level parent_project graphs. Skips forceAtlas2. */
    layout?: 'force' | 'hierarchical';
  }

  let { nodes, edges, onNodeClick, layout = 'force' }: Props = $props();

  let container: HTMLDivElement;
  let renderer: InstanceType<typeof import('sigma').default> | null = null;
  let mounted = false;

  let GraphClass: typeof import('graphology').default;
  let SigmaClass: typeof import('sigma').default;
  let EdgeProg: unknown;

  let hoveredNode = $state<string | null>(null);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let tooltipFlipX = $state(false);
  let tooltipFlipY = $state(false);
  let tooltipEl: HTMLDivElement | undefined = $state();
  let tooltipLabel = $state('');
  let tooltipType = $state('');
  let tooltipDegree = $state(0);
  let tooltipNew = $state(false);
  // ADR-005 — project-graph context (empty in note-level usage).
  let tooltipShape = $state('');
  let tooltipCluster = $state('');
  let tooltipAggOpen = $state(0);
  let tooltipAggTotal = $state(0);
  let tooltipOverdue = $state(false);
  let showRanking = $state(true);
  // Track whether the user has manually toggled the panel — once they have,
  // we stop auto-adjusting based on node count and respect their choice.
  let panelUserToggled = $state(false);
  let rankingTab = $state<'latest' | 'connected'>('latest');

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  /** Check if a note was CREATED (not just modified) within the last 7 days */
  function isNew(created: string | undefined): boolean {
    if (!created) return false;
    const createdMs = new Date(created).getTime();
    if (isNaN(createdMs)) return false;
    return Date.now() - createdMs < SEVEN_DAYS_MS;
  }

  function daysAgo(created: string): string {
    const diff = Date.now() - new Date(created).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return 'today';
    if (days === 1) return '1d ago';
    return `${days}d ago`;
  }

  // Top nodes by degree
  const topConnected = $derived(
    [...nodes]
      .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))
      .slice(0, 7)
      .filter((n) => (n.degree ?? 0) > 0)
  );

  // Latest nodes by created date
  const latestNodes = $derived(
    [...nodes]
      .filter((n) => n.created)
      .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
      .slice(0, 7)
  );

  const newCount = $derived(
    nodes.filter((n) => isNew(n.created)).length
  );

  const rankingNodes = $derived(rankingTab === 'connected' ? topConnected : latestNodes);

  /** Derive a stable slug from a GraphNode id. For the project-level
   *  graph, ids look like `projects/<slug>/index.md` — we want `<slug>`
   *  so dagre groups parent-child by slug, not by the literal `index`
   *  filename. Falls back to the filename stem for note-level ids. */
  function nodeIdToSlug(id: string): string {
    const last = (id.split('/').pop() ?? id).replace(/\.md$/i, '');
    if (last === 'index') {
      const parts = id.split('/');
      return parts[parts.length - 2] ?? last;
    }
    return last;
  }

  /** ADR-005 P2 — compute hierarchical positions via dagre (reused from
   *  ADR-016's `computeNetworkLayout`). Synthesises the `RowLike` +
   *  `DepEdge` shapes the wrapper expects so we get the same Sugiyama
   *  rank-by-rank layout used on `/projects/[slug]`. Returns null in
   *  `'force'` mode so the caller falls back to random + forceAtlas2. */
  function computeHierarchicalPositions(): Map<string, { x: number; y: number }> | null {
    if (layout !== 'hierarchical') return null;
    const slugByNode = new Map<string, string>();
    for (const n of nodes) slugByNode.set(n.id, nodeIdToSlug(n.id));

    const synthRows = nodes.map((n) => ({ path: `${slugByNode.get(n.id)}.md` }));
    const depEdges = edges
      .filter((e) => slugByNode.has(e.source) && slugByNode.has(e.target))
      .map((e) => ({
        blocker: slugByNode.get(e.source)!,
        dependent: slugByNode.get(e.target)!,
        external: false,
        blockerStatus: null,
      }));

    // LR (left-to-right) for project hierarchies: parents on the left,
    // children stacked vertically to the right. Counter-intuitive but
    // load-bearing — when one parent has 17 children (soul-hub's actual
    // shape), TB packs them into a single horizontal row that no
    // viewport can render without label collisions; LR stacks them
    // vertically (one slug per line), letting the canvas height carry
    // the burden instead of width. ADR-014's per-project ADR network
    // uses LR for the same reason — long chain shapes.
    const result = computeNetworkLayout(synthRows, depEdges, {
      rankdir: 'LR',
      nodeWidth: 180,
      nodeHeight: 36,
      rankSep: 220,
      nodeSep: 18,
    });
    const slugToNode = new Map<string, string>();
    for (const [nodeId, slug] of slugByNode.entries()) slugToNode.set(slug, nodeId);
    const positions = new Map<string, { x: number; y: number }>();
    // Sigma uses Y-up (math); dagre uses Y-down (web). Flip Y so rank
    // ordering matches visual ordering.
    for (const ln of result.nodes) {
      const nodeId = slugToNode.get(ln.slug);
      if (nodeId) positions.set(nodeId, { x: ln.x, y: -ln.y });
    }
    return positions;
  }

  function buildGraph() {
    if (renderer) {
      renderer.kill();
      renderer = null;
    }
    if (!GraphClass || !SigmaClass || !container || nodes.length === 0) return;

    const graph = new GraphClass();
    const positions = computeHierarchicalPositions();
    // ADR-005 — in hierarchical mode the node `size` field carries
    // `activity_30d` (raw note count), which can run 0..60+. Sigma sizes
    // are unitless and small (typical range 2..15); a raw count would
    // render absurdly large balls that swallow the canvas. Clamp into a
    // legible range while preserving relative ordering via sqrt.
    const isHierarchical = layout === 'hierarchical';

    for (const node of nodes) {
      const nodeIsNew = isNew(node.created);
      const pos = positions?.get(node.id);
      const displaySize = isHierarchical
        ? Math.max(4, Math.min(12, Math.sqrt((node.size ?? 1) + 1) * 2.5))
        : node.size;
      graph.addNode(node.id, {
        label: node.label,
        size: displaySize,
        color: node.color,
        x: pos?.x ?? Math.random() * 100,
        y: pos?.y ?? Math.random() * 100,
        nodeType: node.type || '',
        degree: node.degree ?? 0,
        isNew: nodeIsNew,
        // ADR-005 — extra fields surfaced in the tooltip when present.
        shape: node.shape ?? '',
        cluster: node.cluster ?? '',
        aggregateOpen: node.aggregateStatus?.open ?? 0,
        aggregateTotal: node.aggregateStatus?.total ?? 0,
        overdue: node.hasOverdueFalsifier ?? false,
      });
    }

    for (const edge of edges) {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        try {
          // Edge color by type (project-level graph adds the semantic types):
          // - `'parent'` → soft slate (project hierarchy, structure-only)
          // - `'produces_for'` (ADR-006) → emerald green (operator-declared
          //   producer→consumer flow; thicker stroke to read as a primary edge)
          // - default (note-level wikilink) → existing purple
          let edgeColor = '#7c8cf844';
          let edgeSize = 1;
          if (edge.type === 'parent') edgeColor = '#94a3b888';
          else if (edge.type === 'produces_for') {
            edgeColor = '#22c55edd'; // emerald-500 with slight transparency
            edgeSize = 2;
          }
          graph.addEdge(edge.source, edge.target, {
            color: edgeColor,
            size: edgeSize,
          });
        } catch {
          // parallel edge — skip
        }
      }
    }

    // ADR-005 — hierarchical mode (project graph) shows EVERY node as
    // an addressable target; the operator needs to be able to read each
    // slug. Force mode (note graph) has hundreds of nodes and relies on
    // the density gates so labels don't smear into illegible noise.
    const settings: Record<string, unknown> = isHierarchical
      ? {
          renderEdgeLabels: false,
          labelColor: { color: '#e2e8f0' },
          labelFont: 'IBM Plex Sans',
          labelSize: 12,
          // 0 = always render the label regardless of zoom-scaled node size.
          labelRenderedSizeThreshold: 0,
          // 1 = pack as many labels as possible per grid cell.
          labelDensity: 1,
          labelGridCellSize: 80,
          defaultNodeColor: '#6b7280',
          defaultEdgeColor: '#94a3b888',
          defaultEdgeType: 'rectangle',
          minEdgeThickness: 0.6,
        }
      : {
          renderEdgeLabels: false,
          labelColor: { color: '#e2e8f0' },
          labelFont: 'IBM Plex Sans',
          labelSize: 11,
          labelRenderedSizeThreshold: 8,
          labelDensity: 0.07,
          labelGridCellSize: 150,
          defaultNodeColor: '#6b7280',
          defaultEdgeColor: '#7c8cf844',
          defaultEdgeType: 'rectangle',
          minEdgeThickness: 0.5,
        };

    if (EdgeProg) {
      settings.edgeProgramClasses = { rectangle: EdgeProg };
    }

    renderer = new SigmaClass(graph, container, settings as ConstructorParameters<typeof SigmaClass>[2]);

    renderer.on('enterNode', ({ node }) => {
      hoveredNode = node;
      const attrs = graph.getNodeAttributes(node);
      tooltipLabel = (attrs.label as string) || node;
      tooltipType = (attrs.nodeType as string) || '';
      tooltipDegree = (attrs.degree as number) || 0;
      tooltipNew = (attrs.isNew as boolean) || false;
      tooltipShape = (attrs.shape as string) || '';
      tooltipCluster = (attrs.cluster as string) || '';
      tooltipAggOpen = (attrs.aggregateOpen as number) || 0;
      tooltipAggTotal = (attrs.aggregateTotal as number) || 0;
      tooltipOverdue = (attrs.overdue as boolean) || false;
      container.style.cursor = 'pointer';

      const neighbors = new Set(graph.neighbors(node));
      neighbors.add(node);
      renderer!.setSetting('nodeReducer', (n: string, data: Record<string, unknown>) => {
        if (neighbors.has(n)) return { ...data, zIndex: 1 };
        return { ...data, color: '#333333', label: '' };
      });
      renderer!.setSetting('edgeReducer', (edge: string, data: Record<string, unknown>) => {
        const src = graph.source(edge);
        const tgt = graph.target(edge);
        if (neighbors.has(src) && neighbors.has(tgt)) {
          return { ...data, color: '#7c8cf8cc', size: 2 };
        }
        return { ...data, color: '#ffffff08' };
      });
    });

    renderer.on('leaveNode', () => {
      hoveredNode = null;
      tooltipFlipX = false;
      tooltipFlipY = false;
      container.style.cursor = 'default';
      renderer!.setSetting('nodeReducer', null);
      renderer!.setSetting('edgeReducer', null);
    });

    renderer.on('clickNode', ({ node }) => {
      onNodeClick(node);
    });

    renderer.getMouseCaptor().on('mousemove', (e: { x: number; y: number }) => {
      if (!hoveredNode) return;
      tooltipX = e.x;
      tooltipY = e.y;
      // Flip tooltip to the left/top when it would overflow the graph canvas
      // — keeps it on-screen for nodes near the right or bottom edge.
      const w = tooltipEl?.offsetWidth ?? 200;
      const h = tooltipEl?.offsetHeight ?? 60;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      tooltipFlipX = e.x + 12 + w > cw;
      tooltipFlipY = e.y - 10 + h > ch;
    });

    // ADR-005 — only run forceAtlas2 post-layout in `'force'` mode.
    // Hierarchical mode trusts dagre's deterministic positions; running
    // forceAtlas2 over them would scramble the rank layering.
    if (layout === 'force') {
      import('graphology-layout-forceatlas2').then(({ default: forceAtlas2 }) => {
        if (!graph || graph.order === 0) return;
        forceAtlas2.assign(graph, {
          iterations: 150,
          settings: {
            gravity: 0.1,
            scalingRatio: 20,
            strongGravityMode: true,
            barnesHutOptimize: false,
            slowDown: 6,
          }
        });
        renderer?.refresh();
      }).catch(() => {});
    } else {
      renderer?.refresh();
    }
  }

  function focusNode(nodeId: string) {
    if (!renderer) return;
    const cam = renderer.getCamera();
    const pos = renderer.getNodeDisplayData(nodeId);
    if (pos) {
      cam.animate({ x: pos.x, y: pos.y, ratio: 0.3 }, { duration: 400 });
    }
  }

  $effect(() => {
    const _n = nodes;
    const _e = edges;
    if (mounted) buildGraph();
  });

  // Auto-collapse the ranking panel when the visible graph is small enough to
  // be readable on its own. Stops auto-adjusting once the user clicks toggle.
  $effect(() => {
    if (panelUserToggled) return;
    if (nodes.length === 0) return;
    showRanking = nodes.length >= 50;
  });

  onMount(async () => {
    const [graphMod, sigmaMod, renderMod] = await Promise.all([
      import('graphology'),
      import('sigma'),
      import('sigma/rendering'),
    ]);
    GraphClass = graphMod.default;
    SigmaClass = sigmaMod.default;
    EdgeProg = renderMod.EdgeRectangleProgram;
    mounted = true;
    buildGraph();
  });

  onDestroy(() => {
    if (renderer) {
      renderer.kill();
      renderer = null;
    }
  });
</script>

<div class="relative w-full h-full">
  <div bind:this={container} class="w-full h-full"></div>

  {#if hoveredNode}
    <div
      bind:this={tooltipEl}
      class="absolute pointer-events-none bg-hub-card border border-hub-border rounded-lg px-3 py-2 shadow-lg z-10"
      style:left={tooltipFlipX ? 'auto' : `${tooltipX + 12}px`}
      style:right={tooltipFlipX ? `${(container?.clientWidth ?? 0) - tooltipX + 12}px` : 'auto'}
      style:top={tooltipFlipY ? 'auto' : `${tooltipY - 10}px`}
      style:bottom={tooltipFlipY ? `${(container?.clientHeight ?? 0) - tooltipY - 10}px` : 'auto'}
    >
      <p class="text-sm text-hub-text font-medium">{tooltipLabel}</p>
      <div class="flex items-center gap-2 mt-0.5">
        {#if tooltipShape}
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-surface text-hub-muted font-medium">{tooltipShape}</span>
        {:else if tooltipType}
          <span class="text-xs text-hub-muted">{tooltipType}</span>
        {/if}
        {#if tooltipCluster}
          <span class="text-[10px] text-hub-dim">cluster:{tooltipCluster}</span>
        {/if}
        {#if tooltipAggTotal > 0}
          <span class="text-[10px] text-hub-dim">{tooltipAggOpen} open · {tooltipAggTotal} ADRs</span>
        {:else}
          <span class="text-xs text-hub-dim">{tooltipDegree} connections</span>
        {/if}
        {#if tooltipOverdue}
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 font-medium">overdue</span>
        {/if}
        {#if tooltipNew}
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400 font-medium">new</span>
        {/if}
      </div>
    </div>
  {/if}

  {#if nodes.length === 0}
    <div class="absolute inset-0 flex items-center justify-center">
      <div class="text-center">
        <svg class="w-12 h-12 mx-auto text-hub-dim mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5"/>
        </svg>
        <p class="text-hub-dim text-sm">No notes in the vault yet</p>
        <p class="text-hub-dim/60 text-xs mt-1">Create a note to see the knowledge graph</p>
      </div>
    </div>
  {/if}

  {#if nodes.length > 0}
    <!-- Top right: stats -->
    <div class="absolute top-3 right-3 bg-hub-card/90 backdrop-blur-sm border border-hub-border rounded-lg px-3 py-1.5 flex items-center gap-3">
      <span class="text-xs text-hub-muted">{nodes.length} nodes · {edges.length} edges</span>
      {#if newCount > 0}
        <span class="text-[10px] text-cyan-400">{newCount} new</span>
      {/if}
      <button
        onclick={() => { panelUserToggled = true; showRanking = !showRanking; }}
        class="text-[10px] text-hub-dim hover:text-hub-muted transition-colors cursor-pointer"
      >
        {showRanking ? 'Hide' : 'Show'} panel
      </button>
    </div>

    <!-- Ranking panel with tabs -->
    {#if showRanking && rankingNodes.length > 0}
      <div class="absolute top-12 right-3 bg-hub-card/90 backdrop-blur-sm border border-hub-border rounded-lg w-60 max-h-72 overflow-hidden flex flex-col">
        <div class="flex border-b border-hub-border/50">
          <button
            onclick={() => { rankingTab = 'latest'; }}
            class="flex-1 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider cursor-pointer transition-colors
              {rankingTab === 'latest' ? 'text-cyan-400 border-b border-cyan-400' : 'text-hub-dim hover:text-hub-muted'}"
          >
            Latest
          </button>
          <button
            onclick={() => { rankingTab = 'connected'; }}
            class="flex-1 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider cursor-pointer transition-colors
              {rankingTab === 'connected' ? 'text-hub-cta border-b border-hub-cta' : 'text-hub-dim hover:text-hub-muted'}"
          >
            Most connected
          </button>
        </div>

        <div class="overflow-y-auto px-3 py-1.5">
          {#each rankingNodes as node, i (node.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              onclick={() => { focusNode(node.id); onNodeClick(node.id); }}
              class="flex items-center gap-2 py-1.5 px-1 -mx-1 rounded hover:bg-hub-surface transition-colors cursor-pointer group"
            >
              <span class="text-[10px] text-hub-dim w-3 text-right font-mono flex-shrink-0">{i + 1}</span>
              <span
                class="flex-shrink-0 w-2.5 h-2.5 rounded-full"
                style="background-color: {node.color}"
              ></span>
              <div class="flex-1 min-w-0">
                <span class="text-xs text-hub-muted group-hover:text-hub-text transition-colors truncate block">{node.label}</span>
                {#if rankingTab === 'latest' && node.created}
                  <span class="text-[10px] text-hub-dim">{daysAgo(node.created)}</span>
                {/if}
              </div>
              {#if rankingTab === 'connected'}
                <span class="text-[10px] text-hub-dim font-mono flex-shrink-0">{node.degree}</span>
              {/if}
              {#if isNew(node.created)}
                <span class="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Bottom left: legend. ADR-005 — hierarchical mode swaps the zone
         palette (irrelevant on project view) for a project-shape legend
         driven by the actual shapes present in the visible node set. -->
    {#if layout === 'hierarchical'}
      {@const presentShapes = Array.from(new Set(nodes.map((n) => n.shape).filter(Boolean))).sort()}
      {@const hasProducesFor = edges.some((e) => e.type === 'produces_for')}
      {#if presentShapes.length > 0}
        <div class="absolute bottom-3 left-3 bg-hub-card/90 backdrop-blur-sm border border-hub-border rounded-lg px-3 py-2 max-w-md">
          <div class="flex flex-wrap gap-x-3 gap-y-1">
            {#each presentShapes as s (s)}
              {@const sample = nodes.find((n) => n.shape === s)}
              <span class="flex items-center gap-1 text-[11px] text-hub-muted">
                <span class="w-2.5 h-2.5 rounded-full" style="background: {sample?.color ?? '#9ca3af'}"></span> {s}
              </span>
            {/each}
            {#if hasProducesFor}
              <span class="flex items-center gap-1 text-[11px] text-hub-muted">
                <span class="w-3 h-0.5 inline-block rounded" style="background: #22c55edd"></span> produces_for
              </span>
            {/if}
          </div>
          <p class="text-[10px] text-hub-dim/60 mt-1">Color = project_shape · size = activity (30d) · green = producer→consumer · click node → project page.</p>
        </div>
      {/if}
    {:else}
      <div class="absolute bottom-3 left-3 bg-hub-card/90 backdrop-blur-sm border border-hub-border rounded-lg px-3 py-2">
        <div class="flex flex-wrap gap-x-3 gap-y-1">
          <span class="flex items-center gap-1 text-xs text-hub-muted">
            <span class="w-2.5 h-2.5 rounded-full" style="background: #6366f1"></span> projects
          </span>
          <span class="flex items-center gap-1 text-xs text-hub-muted">
            <span class="w-2.5 h-2.5 rounded-full" style="background: #06b6d4"></span> knowledge
          </span>
          <span class="flex items-center gap-1 text-xs text-hub-muted">
            <span class="w-2.5 h-2.5 rounded-full" style="background: #8b5cf6"></span> content
          </span>
          <span class="flex items-center gap-1 text-xs text-hub-muted">
            <span class="w-2.5 h-2.5 rounded-full" style="background: #64748b"></span> operations
          </span>
        </div>
        <p class="text-[10px] text-hub-dim/60 mt-1">Larger nodes = more connections. Cyan ring marks new notes (7d).</p>
      </div>
    {/if}
  {/if}
</div>
