<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';

	const slug = $page.params.slug;

	// Known brand token keys (from the doc-render base tokens) for the add-color datalist.
	const KNOWN_TOKENS = [
		'page_bg', 'text', 'text_secondary', 'text_tertiary', 'accent', 'accent_2', 'accent_on',
		'border', 'border_strong', 'tag_bg', 'tag_fg', 'code_bg', 'code_fg',
		'callout_info_bg', 'callout_info_accent', 'callout_warn_bg', 'callout_warn_accent',
		'callout_danger_bg', 'callout_danger_accent', 'callout_tip_bg', 'callout_tip_accent',
		'step_circle_bg', 'step_circle_fg',
	];

	type FontStack = { primary: string; display: string; mono: string; fallback: string };
	const emptyFont = (): FontStack => ({ primary: '', display: '', mono: '', fallback: '' });

	let loading = $state(true);
	let isNew = $state(false);
	let loadError = $state<string | null>(null);

	let nameEn = $state('');
	let nameAr = $state('');
	let colors = $state<{ key: string; value: string }[]>([]);
	let fontsEn = $state<FontStack>(emptyFont());
	let fontsAr = $state<FontStack>(emptyFont());
	let identity = $state({ author_name: '', author_name_ar: '', email: '' });
	let logoPrimary = $state<string | null>(null);
	let logoMaxHeight = $state(18);
	let logoThumbUrl = $state<string | null>(null); // client-side object URL for preview

	let newColorKey = $state('');

	let saving = $state(false);
	let saveStatus = $state<'idle' | 'passed' | 'failed'>('idle');
	let saveChecks = $state<{ name: string; status: string; detail?: string; errors?: unknown[] }[]>([]);
	let saveMessage = $state<string | null>(null);
	let logoUploading = $state(false);
	let logoError = $state<string | null>(null);

	// Live PDF preview (CP3)
	let previewing = $state(false);
	let previewUrl = $state<string | null>(null);
	let previewError = $state<string | null>(null);
	let previewLang = $state<'en' | 'ar'>('en');

	// CSS-color whitelist — mirrors render_core/tokens.py + the Zod guard.
	const COLOR_RES = [
		/^#[0-9a-fA-F]{3,8}$/,
		/^rgba?\(\s*[\d.,\s%/]+\s*\)$/,
		/^hsla?\(\s*[\d.,\s%/deg]+\s*\)$/,
		/^[a-zA-Z][a-zA-Z0-9-]*$/,
	];
	const isValidColor = (v: string) => v.trim() !== '' && COLOR_RES.some((re) => re.test(v.trim()));

	function nonEmpty<T extends Record<string, unknown>>(o: T): Partial<T> {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(o)) if (typeof v === 'string' ? v.trim() : v) out[k] = v;
		return out as Partial<T>;
	}

	async function load() {
		loading = true;
		try {
			const res = await fetch(`/api/brands/${slug}`);
			if (res.status === 404) {
				isNew = true;
				// Sensible starter palette for a new brand.
				colors = [
					{ key: 'accent', value: '#1F3A68' },
					{ key: 'accent_2', value: '#D4A437' },
					{ key: 'text', value: '#141414' },
				];
				loadError = null;
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const { profile } = (await res.json()) as { profile: Record<string, any> };
			hydrate(profile);
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	function hydrate(p: Record<string, any>) {
		const name = p.name;
		if (typeof name === 'string') nameEn = name;
		else if (name && typeof name === 'object') {
			nameEn = name.en ?? '';
			nameAr = name.ar ?? '';
		}
		colors = Object.entries(p.colors ?? {}).map(([key, value]) => ({ key, value: String(value) }));
		fontsEn = { ...emptyFont(), ...(p.fonts?.en ?? {}) };
		fontsAr = { ...emptyFont(), ...(p.fonts?.ar ?? {}) };
		identity = {
			author_name: p.identity?.author_name ?? '',
			author_name_ar: p.identity?.author_name_ar ?? '',
			email: p.identity?.email ?? '',
		};
		logoPrimary = p.logo?.primary ?? null;
		logoMaxHeight = p.logo?.max_height_mm ?? 18;
	}

	function addColor() {
		const key = newColorKey.trim();
		if (!key || colors.some((c) => c.key === key)) return;
		colors = [...colors, { key, value: '#000000' }];
		newColorKey = '';
	}
	function removeColor(i: number) {
		colors = colors.filter((_, idx) => idx !== i);
	}

	function assembleProfile(): Record<string, unknown> {
		const colorObj: Record<string, string> = {};
		for (const { key, value } of colors) if (key.trim() && value.trim()) colorObj[key.trim()] = value.trim();

		const name: Record<string, string> = { en: nameEn.trim() };
		if (nameAr.trim()) name.ar = nameAr.trim();

		const fonts: Record<string, unknown> = {};
		const fe = nonEmpty(fontsEn);
		const fa = nonEmpty(fontsAr);
		if (Object.keys(fe).length) fonts.en = fe;
		if (Object.keys(fa).length) fonts.ar = fa;

		const profile: Record<string, unknown> = { name };
		if (Object.keys(colorObj).length) profile.colors = colorObj;
		if (Object.keys(fonts).length) profile.fonts = fonts;
		const id = nonEmpty(identity);
		if (Object.keys(id).length) profile.identity = id;
		if (logoPrimary) profile.logo = { primary: logoPrimary, max_height_mm: logoMaxHeight };
		return profile;
	}

	async function save() {
		if (!nameEn.trim()) {
			saveStatus = 'failed';
			saveMessage = 'Brand name (EN) is required.';
			saveChecks = [];
			return;
		}
		const badColor = colors.find((c) => c.value.trim() && !isValidColor(c.value));
		if (badColor) {
			saveStatus = 'failed';
			saveMessage = `"${badColor.key}" is not a valid CSS color — fix it before saving.`;
			saveChecks = [];
			return;
		}
		saving = true;
		saveMessage = null;
		try {
			const res = await fetch(`/api/brands/${slug}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(assembleProfile()),
			});
			const data = await res.json();
			saveChecks = data.checks ?? [];
			if (res.ok) {
				saveStatus = 'passed';
				saveMessage = isNew ? `Brand "${slug}" created.` : `Saved.`;
				isNew = false;
			} else {
				saveStatus = 'failed';
				saveMessage = data.error ?? 'Validation failed — nothing was written.';
			}
		} catch (err) {
			saveStatus = 'failed';
			saveMessage = (err as Error).message;
		} finally {
			saving = false;
		}
	}

	async function onLogoSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		logoUploading = true;
		logoError = null;
		try {
			const fd = new FormData();
			fd.append('logo', file);
			const res = await fetch(`/api/brands/${slug}/logo`, { method: 'POST', body: fd });
			const data = await res.json();
			if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
			logoPrimary = data.logoPath;
			logoThumbUrl = URL.createObjectURL(file);
		} catch (err) {
			logoError = (err as Error).message;
		} finally {
			logoUploading = false;
			input.value = '';
		}
	}

	function clearLogo() {
		logoPrimary = null;
		logoThumbUrl = null;
	}

	async function renderPreview() {
		const badColor = colors.find((c) => c.value.trim() && !isValidColor(c.value));
		if (badColor) {
			previewError = `Fix "${badColor.key}" — not a valid CSS color — before previewing.`;
			return;
		}
		previewing = true;
		previewError = null;
		try {
			const res = await fetch(`/api/brands/${slug}/preview`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ profile: assembleProfile(), lang: previewLang }),
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

<svelte:head>
	<title>{slug} — Brands — Naseej</title>
</svelte:head>

<main class="h-full overflow-y-auto">
	<div class="max-w-6xl mx-auto w-full px-4 sm:px-6 py-6">
		<header class="mb-6 flex items-start justify-between gap-4 flex-wrap">
			<div>
				<div class="flex items-center gap-2">
					<a href="/naseej/brands" class="text-xs text-hub-muted hover:text-hub-text">← Brands</a>
				</div>
				<h1 class="mt-1 text-2xl font-semibold tracking-tight text-hub-text">
					{nameEn || slug}
					{#if isNew}<span class="ml-2 text-xs font-normal text-hub-cta">new</span>{/if}
				</h1>
				<p class="mt-1 text-sm text-hub-muted font-mono">{slug}</p>
			</div>
			<button
				onclick={save}
				disabled={saving || loading}
				class="px-4 py-2 text-sm rounded-md bg-hub-cta hover:bg-hub-cta-hover text-hub-bg font-medium transition-colors cursor-pointer disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-hub-info"
			>
				{saving ? 'Saving…' : isNew ? 'Create brand' : 'Save'}
			</button>
		</header>

		{#if loadError}
			<div class="mb-4 px-4 py-3 border border-hub-danger/30 bg-hub-danger/10 text-hub-danger text-sm rounded-md" role="alert">
				{loadError}
			</div>
		{/if}

		<!-- save status -->
		<div aria-live="polite">
			{#if saveStatus === 'passed' && saveMessage}
				<div class="mb-4 px-4 py-2 border border-hub-cta/30 bg-hub-cta/10 text-hub-cta text-sm rounded-md">
					{saveMessage}
				</div>
			{:else if saveStatus === 'failed' && saveMessage}
				<div class="mb-4 px-4 py-2 border border-hub-danger/30 bg-hub-danger/10 text-hub-danger text-sm rounded-md" role="alert">
					{saveMessage}
				</div>
			{/if}
		</div>

		{#if loading}
			<div class="text-sm text-hub-muted py-12 text-center">Loading…</div>
		{:else}
			<div class="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
				<!-- ── form ── -->
				<form class="space-y-6" onsubmit={(e) => { e.preventDefault(); save(); }}>
					<!-- Name -->
					<section class="space-y-2">
						<h2 class="text-xs font-semibold uppercase tracking-wide text-hub-muted">Name</h2>
						<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
							<div class="flex flex-col gap-1">
								<label for="name-en" class="text-xs text-hub-muted">Name (EN)</label>
								<input id="name-en" type="text" bind:value={nameEn}
									class="px-3 py-1.5 text-sm bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:ring-2 focus:ring-hub-info" />
							</div>
							<div class="flex flex-col gap-1">
								<label for="name-ar" class="text-xs text-hub-muted">Name (AR)</label>
								<input id="name-ar" type="text" dir="rtl" bind:value={nameAr}
									class="px-3 py-1.5 text-sm bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:ring-2 focus:ring-hub-info" />
							</div>
						</div>
					</section>

					<!-- Colors -->
					<section class="space-y-2">
						<h2 class="text-xs font-semibold uppercase tracking-wide text-hub-muted">Color tokens</h2>
						<div class="space-y-1.5">
							{#each colors as color, i (color.key)}
								<div class="flex items-center gap-2">
									<span class="w-8 h-8 rounded border shrink-0 {isValidColor(color.value) ? 'border-hub-border' : 'border-hub-danger'}"
										style={isValidColor(color.value) ? `background:${color.value}` : 'background:repeating-linear-gradient(45deg,#334155,#334155 4px,#1E293B 4px,#1E293B 8px)'}
										title={isValidColor(color.value) ? color.value : 'invalid color'}></span>
									<span class="w-44 text-xs font-mono text-hub-muted truncate" title={color.key}>{color.key}</span>
									<input type="text" aria-label={`${color.key} value`} bind:value={color.value}
										class="flex-1 px-2 py-1 text-xs font-mono bg-hub-card border rounded-md text-hub-text focus:outline-none focus:ring-2 focus:ring-hub-info {isValidColor(color.value) ? 'border-hub-border' : 'border-hub-danger'}" />
									{#if !isValidColor(color.value)}<span class="text-[10px] text-hub-danger shrink-0">invalid</span>{/if}
									<button type="button" onclick={() => removeColor(i)} aria-label={`remove ${color.key}`}
										class="text-hub-muted hover:text-hub-danger text-xs px-1 cursor-pointer">✕</button>
								</div>
							{/each}
						</div>
						<div class="flex items-center gap-2 pt-1">
							<input list="token-keys" placeholder="add token (e.g. accent)" bind:value={newColorKey}
								onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addColor())}
								class="w-56 px-2 py-1 text-xs font-mono bg-hub-card border border-hub-border rounded-md text-hub-text placeholder:text-hub-muted/40 focus:outline-none focus:ring-2 focus:ring-hub-info" />
							<datalist id="token-keys">
								{#each KNOWN_TOKENS as t}<option value={t}></option>{/each}
							</datalist>
							<button type="button" onclick={addColor}
								class="px-2 py-1 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer">+ token</button>
						</div>
					</section>

					<!-- Fonts -->
					<section class="space-y-2">
						<h2 class="text-xs font-semibold uppercase tracking-wide text-hub-muted">Fonts</h2>
						<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
							{#each [{ label: 'EN', stack: fontsEn }, { label: 'AR', stack: fontsAr }] as group}
								<fieldset class="space-y-1.5 border border-hub-border/50 rounded-md p-3">
									<legend class="text-xs text-hub-muted px-1">{group.label}</legend>
									{#each ['primary', 'display', 'mono', 'fallback'] as f}
										<div class="flex items-center gap-2">
											<label for={`font-${group.label}-${f}`} class="w-16 text-[11px] text-hub-muted">{f}</label>
											<input id={`font-${group.label}-${f}`} type="text" bind:value={group.stack[f as keyof FontStack]}
												class="flex-1 px-2 py-1 text-xs bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:ring-2 focus:ring-hub-info" />
										</div>
									{/each}
								</fieldset>
							{/each}
						</div>
					</section>

					<!-- Identity -->
					<section class="space-y-2">
						<h2 class="text-xs font-semibold uppercase tracking-wide text-hub-muted">Identity</h2>
						<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
							<div class="flex flex-col gap-1">
								<label for="id-author" class="text-xs text-hub-muted">Author name (EN)</label>
								<input id="id-author" type="text" bind:value={identity.author_name}
									class="px-3 py-1.5 text-sm bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:ring-2 focus:ring-hub-info" />
							</div>
							<div class="flex flex-col gap-1">
								<label for="id-author-ar" class="text-xs text-hub-muted">Author name (AR)</label>
								<input id="id-author-ar" type="text" dir="rtl" bind:value={identity.author_name_ar}
									class="px-3 py-1.5 text-sm bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:ring-2 focus:ring-hub-info" />
							</div>
							<div class="flex flex-col gap-1">
								<label for="id-email" class="text-xs text-hub-muted">Email</label>
								<input id="id-email" type="email" bind:value={identity.email}
									class="px-3 py-1.5 text-sm bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:ring-2 focus:ring-hub-info" />
							</div>
						</div>
					</section>

					<!-- Logo -->
					<section class="space-y-2">
						<h2 class="text-xs font-semibold uppercase tracking-wide text-hub-muted">Logo</h2>
						<div class="flex items-center gap-3">
							<div class="w-16 h-16 rounded-md border border-hub-border bg-hub-card flex items-center justify-center overflow-hidden shrink-0">
								{#if logoThumbUrl}
									<img src={logoThumbUrl} alt="logo preview" class="max-w-full max-h-full" />
								{:else if logoPrimary}
									<span class="text-[10px] font-mono text-hub-muted text-center px-1">{logoPrimary}</span>
								{:else}
									<span class="text-[10px] text-hub-muted">none</span>
								{/if}
							</div>
							<div class="flex flex-col gap-1.5">
								<label for="logo-file" class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer w-fit">
									{logoUploading ? 'Uploading…' : 'Upload logo'}
								</label>
								<input id="logo-file" type="file" accept=".png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml" class="sr-only" onchange={onLogoSelected} />
								{#if logoPrimary}
									<button type="button" onclick={clearLogo} class="text-[11px] text-hub-muted hover:text-hub-danger w-fit cursor-pointer">Clear</button>
								{/if}
								{#if logoError}<span class="text-[11px] text-hub-danger" role="alert">{logoError}</span>{/if}
							</div>
							<div class="flex flex-col gap-1">
								<label for="logo-h" class="text-[11px] text-hub-muted">Max height (mm)</label>
								<input id="logo-h" type="number" min="1" max="200" bind:value={logoMaxHeight}
									class="w-20 px-2 py-1 text-xs bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:ring-2 focus:ring-hub-info" />
							</div>
						</div>
					</section>
				</form>

				<!-- ── preview / validation pane ── -->
				<aside class="lg:sticky lg:top-6 self-start space-y-4">
					<div class="border border-hub-border rounded-md p-4 bg-hub-card/30">
						<h2 class="text-xs font-semibold uppercase tracking-wide text-hub-muted mb-3">Preview</h2>
						<div class="grid grid-cols-2 gap-2">
							{#each colors.filter((c) => isValidColor(c.value)) as c (c.key)}
								<div class="flex items-center gap-2">
									<span class="w-6 h-6 rounded border border-hub-border shrink-0" style={`background:${c.value}`}></span>
									<span class="text-[10px] font-mono text-hub-muted truncate" title={c.key}>{c.key}</span>
								</div>
							{/each}
						</div>

						<!-- Live PDF render preview (CP3) -->
						<div class="mt-3 pt-3 border-t border-hub-border/50 space-y-2">
							<div class="flex items-center gap-2">
								<button
									type="button"
									onclick={renderPreview}
									disabled={previewing}
									class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-hub-info"
								>
									{previewing ? 'Rendering…' : previewUrl ? 'Re-render' : 'Render preview'}
								</button>
								<div class="flex rounded-md border border-hub-border overflow-hidden text-[10px]">
									{#each ['en', 'ar'] as l}
										<button
											type="button"
											onclick={() => (previewLang = l as 'en' | 'ar')}
											class="px-2 py-1 cursor-pointer transition-colors {previewLang === l ? 'bg-hub-card text-hub-text' : 'text-hub-muted hover:text-hub-text'}"
										>
											{l.toUpperCase()}
										</button>
									{/each}
								</div>
							</div>

							<div aria-live="polite">
								{#if previewError}
									<div class="text-[11px] text-hub-danger" role="alert">{previewError}</div>
								{/if}
							</div>

							{#if previewing}
								<div class="h-72 rounded border border-hub-border bg-hub-card/40 flex items-center justify-center">
									<span class="inline-block w-5 h-5 rounded-full border-2 border-hub-border border-t-hub-info animate-spin motion-reduce:animate-none"></span>
								</div>
							{:else if previewUrl}
								<iframe src={previewUrl} title="brand render preview" class="w-full h-72 rounded border border-hub-border bg-white"></iframe>
							{:else}
								<p class="text-[10px] text-hub-muted">
									Render a sample document (cover + module + callout) with the current, unsaved brand.
								</p>
							{/if}
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
											<span class={c.status === 'passed' ? 'text-hub-cta' : c.status === 'failed' ? 'text-hub-danger' : 'text-hub-muted'}>
												{c.status}
											</span>
										</div>
										{#if c.detail}<p class="mt-0.5 text-[10px] text-hub-muted">{c.detail}</p>{/if}
										{#if c.errors}<pre class="mt-1 text-[10px] text-hub-danger whitespace-pre-wrap">{JSON.stringify(c.errors, null, 1)}</pre>{/if}
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				</aside>
			</div>
		{/if}
	</div>
</main>
