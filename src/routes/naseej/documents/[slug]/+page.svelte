<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';

	const slug = $page.params.slug;

	type SlotClass = 'static' | 'deterministic' | 'judgment';
	const CLASSES: SlotClass[] = ['static', 'deterministic', 'judgment'];
	const CLASS_META: Record<SlotClass, { label: string; text: string; hint: string }> = {
		static: { label: 'static', text: 'text-hub-cta', hint: 'set once' },
		deterministic: { label: 'determ.', text: 'text-hub-info', hint: 'computed at run' },
		judgment: { label: 'judgment', text: 'text-hub-purple', hint: 'AI drafts → review' },
	};

	interface CompInput { name: string; slot_class?: SlotClass; description?: string }
	interface PresComp { name: string; inputs: CompInput[]; description?: string }
	interface SlotBinding { class: SlotClass; value: string }
	interface Entry { component: string; slots: Record<string, SlotBinding> }

	let loading = $state(true);
	let isNew = $state(false);
	let loadError = $state<string | null>(null);

	let presComps = $state<Record<string, PresComp>>({});
	let brands = $state<{ slug: string; name: string }[]>([]);

	let name = $state('');
	let brand = $state('');
	let lang = $state<'en' | 'ar'>('en');
	let composition = $state<Entry[]>([]);
	let addPick = $state('');

	let saving = $state(false);
	let saveStatus = $state<'idle' | 'passed' | 'failed'>('idle');
	let saveMessage = $state<string | null>(null);
	let saveChecks = $state<{ name: string; status: string; detail?: string; problems?: string[]; errors?: unknown[] }[]>([]);

	// Live composition preview (CP3)
	let previewing = $state(false);
	let previewUrl = $state<string | null>(null);
	let previewError = $state<string | null>(null);
	let previewLang = $state<'en' | 'ar'>('en');

	function defaultClass(component: string, input: string): SlotClass {
		return presComps[component]?.inputs.find((i) => i.name === input)?.slot_class ?? 'judgment';
	}

	function initSlots(component: string): Record<string, SlotBinding> {
		const out: Record<string, SlotBinding> = {};
		for (const inp of presComps[component]?.inputs ?? []) {
			out[inp.name] = { class: inp.slot_class ?? 'judgment', value: '' };
		}
		return out;
	}

	async function load() {
		loading = true;
		try {
			const [idxRes, brandsRes, docRes] = await Promise.all([
				fetch('/api/components/index'),
				fetch('/api/brands'),
				fetch(`/api/documents/${slug}`),
			]);
			const idx = (await idxRes.json()) as { components: Record<string, PresComp & { kind?: string }> };
			presComps = Object.fromEntries(
				Object.entries(idx.components)
					.filter(([, c]) => c.kind === 'presentation')
					.map(([n, c]) => [n, { name: n, inputs: c.inputs ?? [], description: c.description }]),
			);
			brands = ((await brandsRes.json()) as { results: { slug: string; name: string }[] }).results;

			if (docRes.status === 404) {
				isNew = true;
				brand = brands[0]?.slug ?? '';
			} else if (docRes.ok) {
				const { template } = (await docRes.json()) as { template: any };
				name = template.name ?? '';
				brand = template.brand ?? '';
				lang = template.lang === 'ar' ? 'ar' : 'en';
				composition = (template.composition ?? []).map((e: any) => {
					const slots = initSlots(e.component);
					for (const [k, b] of Object.entries(e.slots ?? {})) {
						if (slots[k]) slots[k] = { class: (b as any).class ?? slots[k].class, value: String((b as any).value ?? '') };
					}
					return { component: e.component, slots };
				});
			} else {
				throw new Error(`HTTP ${docRes.status}`);
			}
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	function addComponent() {
		if (!addPick || !presComps[addPick]) return;
		composition = [...composition, { component: addPick, slots: initSlots(addPick) }];
		addPick = '';
	}
	function removeEntry(i: number) {
		composition = composition.filter((_, idx) => idx !== i);
	}
	function move(i: number, dir: -1 | 1) {
		const j = i + dir;
		if (j < 0 || j >= composition.length) return;
		const next = [...composition];
		[next[i], next[j]] = [next[j], next[i]];
		composition = next;
	}

	const summary = $derived(() => {
		const c = { static: 0, deterministic: 0, judgment: 0 };
		for (const e of composition) for (const b of Object.values(e.slots)) c[b.class]++;
		return c;
	});

	function assemble() {
		return {
			name: name.trim(),
			brand,
			lang,
			composition: composition.map((e) => ({
				component: e.component,
				slots: Object.fromEntries(
					Object.entries(e.slots).map(([k, b]) =>
						b.class === 'static' ? [k, { class: 'static', value: b.value }] : [k, { class: b.class }],
					),
				),
			})),
		};
	}

	async function save() {
		if (!name.trim()) { saveStatus = 'failed'; saveMessage = 'Document name is required.'; saveChecks = []; return; }
		if (!brand) { saveStatus = 'failed'; saveMessage = 'Pick a brand.'; saveChecks = []; return; }
		if (composition.length === 0) { saveStatus = 'failed'; saveMessage = 'Add at least one component.'; saveChecks = []; return; }
		for (const e of composition)
			for (const [k, b] of Object.entries(e.slots))
				if (b.class === 'static' && !b.value.trim()) {
					saveStatus = 'failed';
					saveMessage = `Static slot "${e.component}.${k}" needs a value.`;
					saveChecks = [];
					return;
				}
		saving = true; saveMessage = null;
		try {
			const res = await fetch(`/api/documents/${slug}`, {
				method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(assemble()),
			});
			const data = await res.json();
			saveChecks = data.checks ?? [];
			if (res.ok) { saveStatus = 'passed'; saveMessage = isNew ? `Document "${slug}" created.` : 'Saved.'; isNew = false; }
			else { saveStatus = 'failed'; saveMessage = data.error ?? 'Validation failed — nothing was written.'; }
		} catch (err) { saveStatus = 'failed'; saveMessage = (err as Error).message; }
		finally { saving = false; }
	}

	async function renderPreview() {
		if (!brand) { previewError = 'Pick a brand first.'; return; }
		if (composition.length === 0) { previewError = 'Add a component first.'; return; }
		for (const e of composition)
			for (const [k, b] of Object.entries(e.slots))
				if (b.class === 'static' && !b.value.trim()) {
					previewError = `Static slot "${e.component}.${k}" needs a value before previewing.`;
					return;
				}
		previewing = true;
		previewError = null;
		try {
			const res = await fetch(`/api/documents/${slug}/preview`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ template: assemble(), lang: previewLang }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			const blob = await res.blob();
			if (previewUrl) URL.revokeObjectURL(previewUrl);
			previewUrl = URL.createObjectURL(blob);
		} catch (err) {
			previewError = (err as Error).message;
		} finally {
			previewing = false;
		}
	}

	onMount(load);
</script>

<svelte:head><title>{slug} — Documents — Naseej</title></svelte:head>

<main class="h-full overflow-y-auto">
	<div class="max-w-6xl mx-auto w-full px-4 sm:px-6 py-6">
		<header class="mb-6 flex items-start justify-between gap-4 flex-wrap">
			<div>
				<a href="/naseej/documents" class="text-xs text-hub-muted hover:text-hub-text">← Documents</a>
				<h1 class="mt-1 text-2xl font-semibold tracking-tight text-hub-text">
					{name || slug}{#if isNew}<span class="ml-2 text-xs font-normal text-hub-cta">new</span>{/if}
				</h1>
				<p class="mt-1 text-sm text-hub-muted font-mono">{slug}</p>
			</div>
			<button onclick={save} disabled={saving || loading}
				class="px-4 py-2 text-sm rounded-md bg-hub-cta hover:bg-hub-cta-hover text-hub-bg font-medium transition-colors cursor-pointer disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-hub-info">
				{saving ? 'Saving…' : isNew ? 'Create document' : 'Save'}
			</button>
		</header>

		{#if loadError}<div class="mb-4 px-4 py-3 border border-hub-danger/30 bg-hub-danger/10 text-hub-danger text-sm rounded-md" role="alert">{loadError}</div>{/if}

		<div aria-live="polite">
			{#if saveStatus === 'passed' && saveMessage}
				<div class="mb-4 px-4 py-2 border border-hub-cta/30 bg-hub-cta/10 text-hub-cta text-sm rounded-md">{saveMessage}</div>
			{:else if saveStatus === 'failed' && saveMessage}
				<div class="mb-4 px-4 py-2 border border-hub-danger/30 bg-hub-danger/10 text-hub-danger text-sm rounded-md" role="alert">{saveMessage}</div>
			{/if}
		</div>

		{#if loading}
			<div class="text-sm text-hub-muted py-12 text-center">Loading…</div>
		{:else}
			<!-- top: brand + lang -->
			<div class="mb-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
				<div class="flex flex-col gap-1">
					<label for="doc-name" class="text-xs text-hub-muted">Name</label>
					<input id="doc-name" type="text" bind:value={name} class="px-3 py-1.5 text-sm bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:ring-2 focus:ring-hub-info" />
				</div>
				<div class="flex flex-col gap-1">
					<label for="doc-brand" class="text-xs text-hub-muted">Brand</label>
					<select id="doc-brand" bind:value={brand} class="px-3 py-1.5 text-sm bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:ring-2 focus:ring-hub-info">
						<option value="" disabled>— pick a brand —</option>
						{#each brands as b}<option value={b.slug}>{b.name} ({b.slug})</option>{/each}
					</select>
				</div>
				<div class="flex flex-col gap-1">
					<label for="doc-lang" class="text-xs text-hub-muted">Default language</label>
					<select id="doc-lang" bind:value={lang} class="px-3 py-1.5 text-sm bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:ring-2 focus:ring-hub-info">
						<option value="en">en</option><option value="ar">ar</option>
					</select>
				</div>
			</div>

			<div class="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
				<!-- composition -->
				<section class="space-y-3">
					<div class="flex items-center gap-2">
						<select bind:value={addPick} aria-label="component to add" class="px-2 py-1.5 text-xs bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:ring-2 focus:ring-hub-info">
							<option value="">— add a component —</option>
							{#each Object.keys(presComps).sort() as n}<option value={n}>{n}</option>{/each}
						</select>
						<button type="button" onclick={addComponent} disabled={!addPick} class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer disabled:opacity-40">+ add</button>
					</div>

					{#if composition.length === 0}
						<div class="border border-dashed border-hub-border rounded-md py-10 text-center">
							<p class="text-sm text-hub-muted">No components yet. Add one above to start composing the document.</p>
						</div>
					{:else}
						{#each composition as entry, i (i)}
							<div class="border border-hub-border rounded-md bg-hub-card/30">
								<div class="flex items-center justify-between gap-2 px-3 py-2 border-b border-hub-border/50">
									<div class="flex items-center gap-2">
										<span class="text-[10px] font-mono text-hub-muted">{i + 1}</span>
										<h3 class="text-sm font-semibold text-hub-text">{entry.component}</h3>
									</div>
									<div class="flex items-center gap-1">
										<button type="button" onclick={() => move(i, -1)} disabled={i === 0} aria-label="move up" class="px-1.5 text-hub-muted hover:text-hub-text disabled:opacity-30 cursor-pointer">↑</button>
										<button type="button" onclick={() => move(i, 1)} disabled={i === composition.length - 1} aria-label="move down" class="px-1.5 text-hub-muted hover:text-hub-text disabled:opacity-30 cursor-pointer">↓</button>
										<button type="button" onclick={() => removeEntry(i)} aria-label="remove component" class="px-1.5 text-hub-muted hover:text-hub-danger cursor-pointer">✕</button>
									</div>
								</div>
								<div class="p-3 space-y-2">
									{#each presComps[entry.component]?.inputs ?? [] as inp (inp.name)}
										{@const b = entry.slots[inp.name]}
										{#if b}
											<div class="flex items-center gap-2 flex-wrap">
												<span class="w-32 text-xs font-mono text-hub-muted truncate" title={inp.description ?? inp.name}>{inp.name}</span>
												<!-- class radio group -->
												<div class="flex rounded-md border border-hub-border overflow-hidden text-[10px]" role="radiogroup" aria-label={`${inp.name} slot class`}>
													{#each CLASSES as cls}
														<button type="button" role="radio" aria-checked={b.class === cls}
															onclick={() => (b.class = cls)}
															class="px-2 py-1 cursor-pointer transition-colors {b.class === cls ? `bg-hub-card ${CLASS_META[cls].text}` : 'text-hub-muted hover:text-hub-text'}">
															{CLASS_META[cls].label}
														</button>
													{/each}
												</div>
												{#if b.class === 'static'}
													<input type="text" aria-label={`${inp.name} static value`} bind:value={b.value} placeholder="value…"
														class="flex-1 min-w-[140px] px-2 py-1 text-xs bg-hub-card border rounded-md text-hub-text focus:outline-none focus:ring-2 focus:ring-hub-info {b.value.trim() ? 'border-hub-border' : 'border-hub-warning/50'}" />
												{:else}
													<span class="text-[10px] text-hub-muted italic">{CLASS_META[b.class].hint}</span>
												{/if}
											</div>
										{/if}
									{/each}
								</div>
							</div>
						{/each}
					{/if}
				</section>

				<!-- summary + validation -->
				<aside class="lg:sticky lg:top-6 self-start space-y-4">
					<div class="border border-hub-border rounded-md p-4 bg-hub-card/30">
						<h2 class="text-xs font-semibold uppercase tracking-wide text-hub-muted mb-3">Slots</h2>
						<div class="space-y-1.5 text-xs">
							<div class="flex justify-between"><span class="text-hub-cta">static</span><span class="font-mono text-hub-text">{summary().static}</span></div>
							<div class="flex justify-between"><span class="text-hub-info">deterministic</span><span class="font-mono text-hub-text">{summary().deterministic}</span></div>
							<div class="flex justify-between"><span class="text-hub-purple">judgment</span><span class="font-mono text-hub-text">{summary().judgment}</span></div>
						</div>
						<div class="mt-3 pt-3 border-t border-hub-border/50 space-y-2">
							<p class="text-[10px] text-hub-muted">{composition.length} component{composition.length === 1 ? '' : 's'}</p>
							<div class="flex items-center gap-2">
								<button type="button" onclick={renderPreview} disabled={previewing}
									class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-hub-info">
									{previewing ? 'Rendering…' : previewUrl ? 'Re-render' : 'Preview'}
								</button>
								<div class="flex rounded-md border border-hub-border overflow-hidden text-[10px]">
									{#each ['en', 'ar'] as l}
										<button type="button" onclick={() => (previewLang = l as 'en' | 'ar')}
											class="px-2 py-1 cursor-pointer transition-colors {previewLang === l ? 'bg-hub-card text-hub-text' : 'text-hub-muted hover:text-hub-text'}">{l.toUpperCase()}</button>
									{/each}
								</div>
							</div>
							<div aria-live="polite">
								{#if previewError}<div class="text-[11px] text-hub-danger" role="alert">{previewError}</div>{/if}
							</div>
							<p class="text-[10px] text-hub-muted">Static slots use their value; deterministic + judgment use sample/placeholder content.</p>
						</div>
					</div>

					{#if saveChecks.length}
						<div class="border border-hub-border rounded-md p-4 bg-hub-card/30" aria-live="polite">
							<h2 class="text-xs font-semibold uppercase tracking-wide text-hub-muted mb-3">Validation</h2>
							<ul class="space-y-2">
								{#each saveChecks as c}
									<li class="text-xs">
										<div class="flex items-center justify-between gap-2">
											<span class="font-mono text-hub-muted">{c.name}</span>
											<span class={c.status === 'passed' ? 'text-hub-cta' : 'text-hub-danger'}>{c.status}</span>
										</div>
										{#if c.detail}<p class="mt-0.5 text-[10px] text-hub-muted">{c.detail}</p>{/if}
										{#each c.problems ?? [] as p}<p class="mt-0.5 text-[10px] text-hub-danger">{p}</p>{/each}
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				</aside>
			</div>

			<!-- Full-width composition render preview (CP3) -->
			{#if previewing || previewUrl}
				<div class="mt-6">
					<h2 class="text-xs font-semibold uppercase tracking-wide text-hub-muted mb-2">Render preview</h2>
					{#if previewing}
						<div class="h-[600px] rounded border border-hub-border bg-hub-card/40 flex items-center justify-center">
							<span class="inline-block w-6 h-6 rounded-full border-2 border-hub-border border-t-hub-info animate-spin motion-reduce:animate-none"></span>
						</div>
					{:else if previewUrl}
						<iframe src={previewUrl} title="document render preview" class="w-full h-[600px] rounded border border-hub-border bg-white"></iframe>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
</main>
