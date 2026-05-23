<script lang="ts">
	/** Phase 3c — ADR timeline (Gantt) for one project.
	 *
	 *  Each row is one decision. The bar runs from `created` to the latest
	 *  meaningful date the ADR has reached (`shipped_on` → `accepted_on` →
	 *  `target_date` → today). The bar colour matches the ADR's current status.
	 *
	 *  Bars carrying `date_inferred: true` render with a dashed border — those
	 *  dates were derived from git-history bulk commits during the Phase 3c-prep
	 *  backfill, so they are honest about being approximate. Operators can edit
	 *  them via the drawer to flip the flag off.
	 *
	 *  Click a bar → opens the same AdrDrawer the rest of the project page uses.
	 *
	 *  projects-graph ADR-014 — when ADR rows carry `blockedBy: string[]`,
	 *  an SVG overlay renders Bezier arrows from each blocker's bar-end to
	 *  the dependent's bar-start. Color matches the blocker's status so the
	 *  reader sees at a glance whether the dependency is satisfied. The
	 *  longest dependency chain ending at an unshipped ADR is highlighted
	 *  in violet (critical path). Cycles render in red with a legend
	 *  warning — they're a data bug worth fixing. */

	interface DecisionRow {
		path: string;
		title: string;
		status: string;
		created: string | null;
		acceptedOn: string | null;
		shippedOn: string | null;
		targetDate: string | null;
		dateInferred: boolean;
		falsifierDate: string | null;
		falsifierDaysAway: number | null;
		/** projects-graph ADR-014 — raw wikilink strings as returned by
		 *  `/api/vault/projects` (see `+server.ts` `blockedBy` field).
		 *  Optional so existing call-sites that don't pass it still type-check. */
		blockedBy?: string[];
	}

	let {
		decisions,
		onSelect,
	}: {
		decisions: DecisionRow[];
		onSelect: (path: string) => void;
	} = $props();

	const TODAY_ISO = new Date().toISOString().slice(0, 10);
	const TODAY_MS = Date.parse(TODAY_ISO);
	const MIN_BAR_PCT = 0.5;

	// Showing rejected/superseded by default makes the chart noisy; let the
	// operator toggle them in. Parked stays visible because it's still an open
	// commitment to revisit.
	let showInactive = $state(false);

	function endIso(d: DecisionRow): string {
		if (d.shippedOn) return d.shippedOn;
		if (d.acceptedOn) return d.acceptedOn;
		if (d.targetDate) return d.targetDate;
		return TODAY_ISO;
	}

	const visible = $derived(
		decisions
			.filter((d) => d.created)
			.filter((d) => showInactive || (d.status !== 'rejected' && d.status !== 'superseded'))
			.slice()
			.sort((a, b) => (a.created ?? '').localeCompare(b.created ?? '')),
	);

	/** projects-graph ADR-014 fix bundle — falsifier dates are excluded from
	 *  the axis end. Falsifiers are typically 3 months out from creation
	 *  (operator convention), which previously stretched the axis 9-45×
	 *  beyond the actual work-span and collapsed every bar into a single
	 *  pixel column. A 14-day floor on the visible span guarantees that
	 *  even an all-same-day project (15 ADRs all `created` today) gets a
	 *  readable canvas. Falsifier diamonds clamp to the right edge of the
	 *  visible range — the lane div uses `overflow:visible` so a clamped
	 *  diamond still renders. */
	const AXIS_MIN_SPAN_MS = 14 * 86_400_000;
	const range = $derived.by(() => {
		if (visible.length === 0) return null;
		const starts = visible.map((d) => Date.parse(d.created!));
		const ends = visible.map((d) => Date.parse(endIso(d)));
		// Only OPEN ADRs (proposed/accepted) contribute their target_date to
		// the axis end — those are the rows that actually render a forecast
		// extension. A shipped ADR's lingering `target_date` is historical
		// trivia (operator set it pre-ship, never cleared), and previously
		// stretched the axis 3-4 months forward in projects like
		// soul-hub-whatsapp where all ADRs are shipped but several still
		// carry old targets. Mirrors the `isOpen` gate used inside the
		// per-row forecast block.
		const targets = visible
			.filter((d) => (d.status === 'proposed' || d.status === 'accepted') && d.targetDate)
			.map((d) => Date.parse(d.targetDate!));
		const startMs = Math.min(...starts);
		const rawEndMs = Math.max(TODAY_MS, ...ends, ...targets);
		const endMs = Math.max(rawEndMs, startMs + AXIS_MIN_SPAN_MS);
		const pad = Math.max((endMs - startMs) * 0.03, 86_400_000); // ≥1 day
		return { startMs: startMs - pad, endMs: endMs + pad };
	});

	function pct(ms: number): number {
		if (!range) return 0;
		return ((ms - range.startMs) / (range.endMs - range.startMs)) * 100;
	}

	/** Adaptive axis ticks. Cadence depends on the visible span so labels
	 *  never collapse on top of each other:
	 *  - ≤ 60 days  → weekly (every Monday)
	 *  - ≤ 180 days → fortnightly (every other Monday)
	 *  - > 180 days → monthly (1st of each month)
	 *  Label format also adapts (DD Mon vs Mon 'YY). */
	const axisTicks = $derived.by(() => {
		if (!range) return [];
		const out: { leftPct: number; label: string; major: boolean }[] = [];
		const spanDays = (range.endMs - range.startMs) / 86_400_000;
		const start = new Date(range.startMs);

		if (spanDays > 180) {
			const cur = new Date(start.getFullYear(), start.getMonth(), 1);
			if (cur.getTime() < range.startMs) cur.setMonth(cur.getMonth() + 1);
			while (cur.getTime() <= range.endMs) {
				out.push({
					leftPct: pct(cur.getTime()),
					label: cur.toLocaleDateString('en', { month: 'short', year: '2-digit' }),
					major: cur.getMonth() === 0,
				});
				cur.setMonth(cur.getMonth() + 1);
			}
		} else {
			// Week-aligned ticks. Snap to nearest Monday on/after start.
			const stride = spanDays > 60 ? 14 : 7;
			const cur = new Date(start);
			const dow = cur.getDay(); // 0=Sun, 1=Mon, …
			const daysToMonday = (8 - dow) % 7 || 7; // always advance at least 1 day if already Mon at midnight
			cur.setDate(cur.getDate() + daysToMonday);
			cur.setHours(0, 0, 0, 0);
			while (cur.getTime() <= range.endMs) {
				out.push({
					leftPct: pct(cur.getTime()),
					label: cur.toLocaleDateString('en', { day: 'numeric', month: 'short' }),
					major: cur.getDate() <= 7, // first Mon of month gets emphasized
				});
				cur.setDate(cur.getDate() + stride);
			}
		}
		return out;
	});

	const todayPct = $derived(range ? pct(TODAY_MS) : 0);
	const todayLabel = $derived(
		new Date(TODAY_MS).toLocaleDateString('en', { day: 'numeric', month: 'short' }),
	);

	function statusFill(status: string): string {
		if (status === 'shipped') return 'bg-hub-cta/70 group-hover:bg-hub-cta';
		if (status === 'accepted') return 'bg-hub-info/70 group-hover:bg-hub-info';
		if (status === 'proposed') return 'bg-hub-warning/70 group-hover:bg-hub-warning';
		if (status === 'rejected') return 'bg-hub-danger/40 group-hover:bg-hub-danger/60';
		if (status === 'parked') return 'bg-hub-dim/40 group-hover:bg-hub-dim/60';
		if (status === 'superseded') return 'bg-hub-muted/30 group-hover:bg-hub-muted/50';
		return 'bg-hub-card group-hover:bg-hub-card/80';
	}

	function shortLabel(d: DecisionRow): string {
		const m = d.title.match(/^ADR-\d+/);
		return m ? m[0] : d.title.split(/[—:]/)[0].trim().slice(0, 14);
	}

	function tooltip(d: DecisionRow): string {
		const parts = [d.title, '', `status: ${d.status}`, `created: ${d.created}`];
		if (d.acceptedOn) parts.push(`accepted: ${d.acceptedOn}`);
		if (d.shippedOn) parts.push(`shipped: ${d.shippedOn}`);
		if (d.targetDate) parts.push(`target: ${d.targetDate}`);
		if (d.falsifierDate) {
			const da = d.falsifierDaysAway;
			let suffix = '';
			if (da !== null) {
				// Mirror the urgency buckets from falsifierFill() so the
				// tooltip explains the diamond colour the reader is seeing.
				if (da < 0) suffix = ` (${Math.abs(da)}d overdue — red diamond)`;
				else if (da <= 7) suffix = ` (${da}d — urgent, red diamond)`;
				else if (da <= 30) suffix = ` (${da}d — review soon, amber diamond)`;
				else suffix = ` (${da}d — on track, muted diamond)`;
			}
			parts.push(`falsifier: ${d.falsifierDate}${suffix}`);
		}
		if (d.dateInferred) parts.push('', 'dates inferred from git history');
		return parts.join('\n');
	}

	/** Falsifier diamond colour. Red if overdue or due within a week; amber
	 *  if within a month; muted otherwise. Same buckets the project detail
	 *  page uses for its falsifier badge. */
	function falsifierFill(daysAway: number | null): string {
		if (daysAway === null) return 'bg-hub-muted/60';
		if (daysAway <= 7) return 'bg-hub-danger';
		if (daysAway <= 30) return 'bg-hub-warning';
		return 'bg-hub-muted/60';
	}

	const counts = $derived.by(() => {
		const c = { shipped: 0, accepted: 0, proposed: 0, parked: 0, rejected: 0, superseded: 0 };
		for (const d of visible) {
			if (d.status in c) c[d.status as keyof typeof c]++;
		}
		return c;
	});

	const inferredCount = $derived(visible.filter((d) => d.dateInferred).length);
	const falsifierCount = $derived(visible.filter((d) => d.falsifierDate).length);

	/** ADRs that are open (proposed/accepted) but carry neither a
	 *  `target_date` nor a `falsifier_date` — meaning the chart has no
	 *  forward signal for when they should ship or be reviewed. These
	 *  are the ones quietly losing momentum; the tray surfaces them so
	 *  the operator can schedule them. */
	const unscheduled = $derived(
		decisions.filter(
			(d) =>
				(d.status === 'proposed' || d.status === 'accepted') &&
				!d.targetDate &&
				!d.falsifierDate,
		),
	);

	/** projects-graph ADR-016 — Timeline answers "when did this ship".
	 *  The dependency-structure question is answered by AdrNetwork; this
	 *  count drives a "switch to Network →" hint banner at the top of
	 *  the chart when the project carries any blocked_by edges. We avoid
	 *  parsing wikilinks here — a raw count of blockedBy entries is
	 *  enough signal to know whether the hint is worth rendering. */
	const blockedByEntries = $derived(
		visible.reduce((acc, d) => acc + (d.blockedBy?.length ?? 0), 0),
	);
</script>

{#if visible.length === 0 && decisions.length > 0}
	<p class="text-xs text-hub-dim py-3">No ADRs with a <code class="font-mono">created</code> date yet.</p>
{:else if visible.length > 0 && range}
	<div class="space-y-3">
		<!-- projects-graph ADR-016 — dependency structure lives in the
		     Network view. When this project has any blocked_by edges,
		     surface a hint banner so operators who landed on Timeline by
		     habit know the structural view exists. Anchor-driven so a
		     middle-click opens in a new tab and bookmarking works. -->
		{#if blockedByEntries > 0}
			<a
				href="?view=network"
				class="block rounded-md border border-hub-info/30 bg-hub-info/5 px-3 py-2 text-[11px] text-hub-info hover:bg-hub-info/10 transition-colors"
			>
				🔀 This project has {blockedByEntries} dependency edge{blockedByEntries === 1 ? '' : 's'} —
				<span class="font-medium underline">switch to Network view</span>
				to see the structure.
			</a>
		{/if}
		<!-- Legend + filter -->
		<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-hub-dim">
			<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-hub-warning/70"></span>proposed</span>
			<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-hub-info/70"></span>accepted</span>
			<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-hub-cta/70"></span>shipped</span>
			<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-hub-dim/40"></span>parked</span>
			{#if showInactive}
				<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-hub-muted/30"></span>superseded</span>
				<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-hub-danger/40"></span>rejected</span>
			{/if}
			{#if inferredCount > 0}
				<span class="inline-flex items-center gap-1.5">
					<span class="w-2.5 h-2.5 rounded border border-dashed border-hub-muted"></span>
					inferred ({inferredCount})
				</span>
			{/if}
			{#if falsifierCount > 0}
				<span class="inline-flex items-center gap-1.5" title="Falsifier ≤7 days — urgent review">
					<span class="w-2 h-2 rotate-45 bg-hub-danger"></span>
					≤7d
				</span>
				<span class="inline-flex items-center gap-1.5" title="Falsifier ≤30 days — review soon">
					<span class="w-2 h-2 rotate-45 bg-hub-warning"></span>
					≤30d
				</span>
				<span class="inline-flex items-center gap-1.5" title="Falsifier >30 days — on track">
					<span class="w-2 h-2 rotate-45 bg-hub-muted/60"></span>
					&gt;30d
				</span>
				<span class="text-hub-dim">· falsifier ({falsifierCount})</span>
			{/if}
			<button
				class="ml-auto text-[11px] text-hub-info hover:text-hub-text cursor-pointer"
				onclick={() => (showInactive = !showInactive)}
			>
				{showInactive ? 'Hide' : 'Show'} rejected / superseded
			</button>
		</div>

		<!-- Unscheduled tray — open ADRs with no target_date and no falsifier_date.
		     These don't show on the timeline because they have no forward signal;
		     surfacing them as chips here keeps them visible so they don't drift. -->
		{#if unscheduled.length > 0}
			<div class="rounded-lg border border-hub-dim/40 bg-hub-card/30 px-3 py-2">
				<div class="flex items-baseline justify-between mb-1.5">
					<span class="text-[11px] font-medium text-hub-muted">
						Unscheduled
						<span class="text-hub-dim font-normal">— no target or falsifier date</span>
					</span>
					<span class="text-[10px] text-hub-dim">{unscheduled.length}</span>
				</div>
				<div class="flex flex-wrap gap-1.5">
					{#each unscheduled as d (d.path)}
						<button
							type="button"
							class="group inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono border border-hub-border bg-hub-bg/40 hover:border-hub-cta/40 hover:bg-hub-card transition-colors cursor-pointer"
							onclick={() => onSelect(d.path)}
							title={tooltip(d)}
						>
							<span
								class="w-1.5 h-1.5 rounded-full {d.status === 'proposed' ? 'bg-hub-warning' : 'bg-hub-info'}"
								aria-hidden="true"
							></span>
							<span class="text-hub-text group-hover:text-hub-cta">{shortLabel(d)}</span>
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Chart -->
		<div class="border border-hub-border rounded-lg bg-hub-card/30 overflow-hidden">
			<!-- Time axis -->
			<div class="relative h-9 border-b border-hub-border bg-hub-card/40 ml-[140px]">
				{#each axisTicks as tick}
					<div
						class="absolute top-0 h-full border-l {tick.major ? 'border-hub-border' : 'border-hub-border/50'}"
						style:left="{tick.leftPct}%"
					>
						<span
							class="absolute top-1.5 left-1.5 text-[10px] whitespace-nowrap {tick.major ? 'text-hub-muted font-medium' : 'text-hub-dim'}"
						>
							{tick.label}
						</span>
					</div>
				{/each}
				<!-- Today marker + label -->
				<div
					class="absolute top-0 h-full border-l-2 border-hub-cta/60"
					style:left="{todayPct}%"
				>
					<span
						class="absolute top-1.5 left-1.5 px-1 rounded text-[10px] font-medium text-hub-cta bg-hub-bg/80 whitespace-nowrap"
					>
						Today · {todayLabel}
					</span>
				</div>
			</div>

			<!-- Rows -->
			<div class="relative">
				<div class="divide-y divide-hub-border/40">
					{#each visible as d (d.path)}
						{@const startPct = pct(Date.parse(d.created!))}
						{@const endPct = pct(Date.parse(endIso(d)))}
						{@const widthPct = Math.max(endPct - startPct, MIN_BAR_PCT)}
						{@const targetPct = d.targetDate ? pct(Date.parse(d.targetDate)) : null}
						{@const rawFalsifierPct = d.falsifierDate ? pct(Date.parse(d.falsifierDate)) : null}
					{@const falsifierIsOffAxis = rawFalsifierPct !== null && rawFalsifierPct > 100}
					{@const falsifierPct = rawFalsifierPct !== null ? Math.min(Math.max(rawFalsifierPct, 0), 99) : null}
						{@const isOpen = d.status === 'proposed' || d.status === 'accepted'}
						{@const forecastEndPct = isOpen
							? Math.max(
									endPct,
									targetPct ?? -Infinity,
									// For accepted ADRs only, extend to falsifier as a fallback
									// when there's no target_date — falsifier is the implicit
									// review deadline. Proposed ADRs keep target_date-only
									// behaviour so the dashed bar means "scheduled to ship".
									d.status === 'accepted' && !d.targetDate ? falsifierPct ?? -Infinity : -Infinity,
								)
							: endPct}
						<button
							type="button"
							class="group w-full flex items-stretch h-7 hover:bg-hub-card/60 transition-colors text-left cursor-pointer"
							onclick={() => onSelect(d.path)}
							title={tooltip(d)}
						>
							<!-- Label gutter -->
							<div class="w-[140px] flex-shrink-0 flex items-center px-2 border-r border-hub-border/40">
								<span class="text-[11px] font-mono text-hub-text truncate">
									{shortLabel(d)}
								</span>
							</div>
							<!-- Bar lane. `overflow-visible` so a falsifier diamond clamped
							     to the right edge still renders past the lane bounds rather
							     than getting clipped — per 2026-05-19 render-patterns report. -->
							<div class="flex-1 relative overflow-visible">
								<!-- Bar — `min-w-[8px]` enforces the universal pattern: zero-
								     duration tasks render as a milestone pill, never as 0px.
								     Every mature Gantt tool (MS Project, Jira, Airtable, DHTMLX)
								     does this. The pill width survives narrow visible spans. -->
								<div
									class="absolute top-1.5 bottom-1.5 rounded min-w-[8px] {statusFill(d.status)} transition-colors {d.dateInferred ? 'border border-dashed border-hub-text/30' : ''}"
									style:left="{startPct}%"
									style:width="{widthPct}%"
								></div>
								<!-- Forecast extension for open ADRs (proposed → target_date,
								     accepted → target_date OR falsifier_date if no target). -->
								{#if isOpen && forecastEndPct > endPct}
									<div
										class="absolute top-2.5 bottom-2.5 rounded border border-dashed {d.status === 'proposed' ? 'border-hub-warning/60' : 'border-hub-info/60'}"
										style:left="{endPct}%"
										style:width="{Math.max(forecastEndPct - endPct, MIN_BAR_PCT)}%"
										title="Forecast → {d.targetDate ?? d.falsifierDate}"
									></div>
								{/if}
								<!-- Falsifier diamond. Clamps to 99% when the actual falsifier
								     date is past the visible range (typical: 3 months out).
								     A subtle `›` chevron precedes the clamped diamond so the
								     off-axis status reads at a glance. Click bubbles to the
								     row button (drawer opens via onSelect). -->
								{#if falsifierPct !== null}
									{#if falsifierIsOffAxis}
										<span
											class="absolute top-1/2 -translate-y-1/2 text-[10px] text-hub-dim/80 pointer-events-none select-none"
											style:left="calc({falsifierPct}% - 11px)"
											aria-hidden="true"
										>›</span>
									{/if}
									<span
										class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rotate-45 {falsifierFill(d.falsifierDaysAway)} border border-hub-bg shadow-sm pointer-events-none"
										style:left="{falsifierPct}%"
										aria-hidden="true"
										title={falsifierIsOffAxis ? 'Falsifier ' + d.falsifierDate + ' — off-axis (clamped)' : undefined}
									></span>
								{/if}
							</div>
						</button>
					{/each}
				</div>

			</div>

			<!-- Footer summary -->
			<div class="px-3 py-2 border-t border-hub-border/40 bg-hub-card/40 text-[11px] text-hub-dim flex flex-wrap items-center gap-x-3 gap-y-1">
				<span>{visible.length} ADR{visible.length === 1 ? '' : 's'}</span>
				{#if counts.shipped > 0}<span>· {counts.shipped} shipped</span>{/if}
				{#if counts.accepted > 0}<span>· {counts.accepted} accepted</span>{/if}
				{#if counts.proposed > 0}<span>· {counts.proposed} proposed</span>{/if}
				{#if counts.parked > 0}<span>· {counts.parked} parked</span>{/if}
				{#if showInactive && counts.rejected > 0}<span>· {counts.rejected} rejected</span>{/if}
				{#if showInactive && counts.superseded > 0}<span>· {counts.superseded} superseded</span>{/if}
			</div>
		</div>
	</div>
{/if}

