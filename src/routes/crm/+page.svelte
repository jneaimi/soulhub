<script lang="ts">
	/**
	 * /crm — first-class CRM browser (Stage E per ADR
	 * 2026-05-11-crm-local-sqlite-transition).
	 *
	 * Three-zone layout matching the inbox page conventions: sidebar (search +
	 * stage filter + add-contact), list (filtered contacts), detail (selected
	 * contact + tabs for interactions / notes / stage history / recent inbox).
	 *
	 * Single-file by design — mirrors src/routes/inbox/+page.svelte structure
	 * so the codebase stays consistent. Drives `/api/crm/*` (Stage D
	 * endpoints) for everything; no direct DB access here.
	 */

	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	type Stage = 'Lead' | 'Contacted' | 'In Conversation' | 'Proposal' | 'Won' | 'Lost';
	const STAGES: Stage[] = ['Lead', 'Contacted', 'In Conversation', 'Proposal', 'Won', 'Lost'];

	const STAGE_COLORS: Record<Stage, string> = {
		Lead: 'bg-hub-info/20 text-hub-info',
		Contacted: 'bg-hub-purple/20 text-hub-purple',
		'In Conversation': 'bg-amber-500/20 text-amber-300',
		Proposal: 'bg-emerald-500/20 text-emerald-300',
		Won: 'bg-hub-cta/20 text-hub-cta',
		Lost: 'bg-hub-danger/15 text-hub-danger',
	};

	const STAGE_DOT_COLORS: Record<Stage, string> = {
		Lead: 'bg-hub-info',
		Contacted: 'bg-hub-purple',
		'In Conversation': 'bg-amber-400',
		Proposal: 'bg-emerald-400',
		Won: 'bg-hub-cta',
		Lost: 'bg-hub-danger',
	};

	const SOURCES = ['Website', 'LinkedIn', 'Twitter', 'Email', 'Referral', 'Speaking'] as const;
	const CHANNELS = ['email', 'call', 'meeting', 'social', 'whatsapp', 'other'] as const;

	type ContactEmailDto = {
		contactId: string;
		email: string;
		label: string | null;
		isPrimary: boolean;
		createdAt: number;
	};

	type ContactPhoneDto = {
		contactId: string;
		phone: string;
		label: string | null;
		isPrimary: boolean;
		createdAt: number;
	};

	type ContactDto = {
		id: string;
		displayName: string;
		company: string | null;
		role: string | null;
		source: string | null;
		stage: Stage;
		dealType: string | null;
		dealValue: number | null;
		dealCurrency: string | null;
		notes: string | null;
		vaultNotePath: string | null;
		nextFollowupAt: number | null;
		lastInteractionAt: number | null;
		createdAt: number;
		updatedAt: number;
		emails: ContactEmailDto[];
		phones: ContactPhoneDto[];
	};

	type DetailResponse = {
		contact: ContactDto;
		emails: ContactEmailDto[];
		phones: ContactPhoneDto[];
		tags: { id: number; name: string }[];
		interactions: {
			id: number; contactId: string; timestamp: number; channel: string;
			direction: string; summary: string; messageId: number | null; createdAt: number;
		}[];
		stageHistory: {
			id: number; fromStage: Stage; toStage: Stage; movedAt: number; reason: string | null;
		}[];
		notes: {
			id: number; vaultPath: string; kind: string; label: string | null;
			sourceUrl: string | null; attachedAt: number;
		}[];
		recentInbox: {
			id: number; subject: string; fromAddress: string; dateReceived: number;
			processStatus: string;
		}[];
	};

	type FollowupsResponse = {
		overdue: ContactDto[];
		upcoming: ContactDto[];
	};

	// ─── state ──────────────────────────────────────────────────────────────

	let contacts = $state<ContactDto[]>([]);
	let total = $state(0);
	let mode = $state<'list' | 'search'>('list');
	let searchWarning = $state<string | null>(null);
	let stageFilter = $state<Stage | null>(null);
	let search = $state('');
	let loading = $state(true);
	let selectedId = $state<string | null>(null);
	let detail = $state<DetailResponse | null>(null);
	let detailLoading = $state(false);
	let detailError = $state<string | null>(null);
	let followups = $state<FollowupsResponse>({ overdue: [], upcoming: [] });
	let flashMessage = $state<string | null>(null);
	let flashType = $state<'info' | 'error'>('info');
	let showAddContact = $state(false);
	let showSidebar = $state(false);
	let detailTab = $state<'interactions' | 'notes' | 'history' | 'inbox'>('interactions');

	// Detail-panel inline edit / add sub-forms
	let editingMeta = $state(false);
	let editForm = $state({ displayName: '', company: '', role: '', notes: '', source: '' });
	let addEmailForm = $state({ email: '', label: '', isPrimary: false });
	let showAddEmail = $state(false);
	let addPhoneForm = $state({ phone: '', label: '', isPrimary: false });
	let showAddPhone = $state(false);
	let addInteractionForm = $state({ channel: 'email' as string, direction: 'outbound' as string, summary: '' });
	let showAddInteraction = $state(false);
	let followupInput = $state(''); // yyyy-mm-dd
	let showFollowupForm = $state(false);

	// Add-contact modal state
	let addForm = $state({
		displayName: '',
		emails: [{ email: '', label: '', isPrimary: true }],
		phones: [{ phone: '', label: '', isPrimary: true }],
		company: '',
		role: '',
		source: '' as string,
		stage: 'Lead' as Stage,
	});

	// ─── derived ────────────────────────────────────────────────────────────

	const followupBadge = $derived.by(() => {
		const o = followups.overdue.length;
		const u = followups.upcoming.length;
		if (o === 0 && u === 0) return null;
		if (o > 0) return `${o} overdue · ${u} upcoming`;
		return `${u} upcoming`;
	});

	// ─── lifecycle ──────────────────────────────────────────────────────────

	onMount(() => {
		const initialId = $page.url.searchParams.get('id');
		loadContacts();
		loadFollowups();
		if (initialId) {
			selectedId = initialId;
			loadDetail(initialId);
		}
	});

	// ─── data fetchers ──────────────────────────────────────────────────────

	let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	function onSearchInput() {
		if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
		searchDebounceTimer = setTimeout(() => loadContacts(), 220);
	}

	async function loadContacts() {
		loading = true;
		searchWarning = null;
		const params = new URLSearchParams();
		if (search.trim().length > 0) {
			params.set('search', search.trim());
		} else if (stageFilter) {
			params.set('stage', stageFilter);
		}
		try {
			const res = await fetch(`/api/crm/contacts?${params.toString()}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			contacts = data.contacts ?? [];
			total = data.total ?? contacts.length;
			mode = data.mode ?? 'list';
			searchWarning = data.warning ?? null;
		} catch (err) {
			flash(`Failed to load contacts: ${errMsg(err)}`, 'error');
			contacts = [];
			total = 0;
		} finally {
			loading = false;
		}
	}

	async function loadDetail(id: string) {
		detailLoading = true;
		detailError = null;
		try {
			const res = await fetch(`/api/crm/contacts/${encodeURIComponent(id)}`);
			if (res.status === 404) {
				detailError = `Contact ${id} not found`;
				detail = null;
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			detail = (await res.json()) as DetailResponse;
			seedEditForm(detail.contact);
		} catch (err) {
			detailError = errMsg(err);
		} finally {
			detailLoading = false;
		}
	}

	async function loadFollowups() {
		try {
			const res = await fetch('/api/crm/followups?upcomingWindowDays=7');
			if (!res.ok) return;
			followups = (await res.json()) as FollowupsResponse;
		} catch {
			// best-effort — sidebar badge can stay empty on failure
		}
	}

	async function selectContact(id: string) {
		selectedId = id;
		// Keep the URL in sync so refresh and share-links preserve the
		// selection. `replaceState` so the back-button still exits /crm
		// rather than walking through every visited contact.
		const url = new URL(window.location.href);
		url.searchParams.set('id', id);
		await goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
		await loadDetail(id);
	}

	function clearSelection() {
		selectedId = null;
		detail = null;
		const url = new URL(window.location.href);
		url.searchParams.delete('id');
		goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
	}

	function setStageFilter(s: Stage | null) {
		stageFilter = s;
		search = '';
		searchWarning = null;
		loadContacts();
		showSidebar = false;
	}

	function seedEditForm(c: ContactDto) {
		editForm = {
			displayName: c.displayName,
			company: c.company ?? '',
			role: c.role ?? '',
			notes: c.notes ?? '',
			source: c.source ?? '',
		};
	}

	// ─── mutations ──────────────────────────────────────────────────────────

	async function moveStage(newStage: Stage) {
		if (!detail) return;
		if (detail.contact.stage === newStage) return;
		try {
			const res = await fetch(`/api/crm/contacts/${detail.contact.id}/stage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ stage: newStage }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			flash(`Moved to ${newStage}`);
			await Promise.all([loadDetail(detail.contact.id), loadContacts(), loadFollowups()]);
		} catch (err) {
			flash(`Stage move failed: ${errMsg(err)}`, 'error');
		}
	}

	async function saveMetaEdits() {
		if (!detail) return;
		const payload: Record<string, unknown> = {};
		const c = detail.contact;
		if (editForm.displayName.trim().length > 0 && editForm.displayName !== c.displayName) {
			payload.displayName = editForm.displayName.trim();
		}
		const fields: Array<['company' | 'role' | 'notes' | 'source', keyof typeof editForm]> = [
			['company', 'company'], ['role', 'role'], ['notes', 'notes'], ['source', 'source'],
		];
		for (const [api, local] of fields) {
			const v = editForm[local] ?? '';
			const current = (c as unknown as Record<string, string | null>)[api] ?? '';
			const norm = v.trim().length === 0 ? null : v.trim();
			if (norm !== (current === '' ? null : current)) payload[api] = norm;
		}
		if (Object.keys(payload).length === 0) {
			editingMeta = false;
			return;
		}
		try {
			const res = await fetch(`/api/crm/contacts/${c.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (!res.ok) {
				const errBody = await res.json().catch(() => ({}));
				throw new Error(errBody.error ?? `HTTP ${res.status}`);
			}
			flash('Contact updated');
			editingMeta = false;
			await Promise.all([loadDetail(c.id), loadContacts()]);
		} catch (err) {
			flash(`Update failed: ${errMsg(err)}`, 'error');
		}
	}

	async function addEmail() {
		if (!detail) return;
		const e = addEmailForm.email.trim();
		if (!e) return;
		try {
			const res = await fetch(`/api/crm/contacts/${detail.contact.id}/emails`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: e,
					label: addEmailForm.label.trim() || undefined,
					isPrimary: addEmailForm.isPrimary,
				}),
			});
			if (res.status === 409) {
				flash('Email already attached to a contact', 'error');
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			flash('Email added');
			addEmailForm = { email: '', label: '', isPrimary: false };
			showAddEmail = false;
			await loadDetail(detail.contact.id);
		} catch (err) {
			flash(`Add email failed: ${errMsg(err)}`, 'error');
		}
	}

	async function promoteEmail(email: string) {
		if (!detail) return;
		try {
			const res = await fetch(`/api/crm/contacts/${detail.contact.id}/emails`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, makePrimary: true }),
			});
			if (!res.ok) {
				const errBody = await res.json().catch(() => ({}));
				throw new Error(errBody.error ?? `HTTP ${res.status}`);
			}
			flash(`Promoted ${email} to primary`);
			await loadDetail(detail.contact.id);
		} catch (err) {
			flash(`Promote failed: ${errMsg(err)}`, 'error');
		}
	}

	async function removeEmail(email: string) {
		if (!detail) return;
		if (!confirm(`Remove ${email}?`)) return;
		try {
			const res = await fetch(
				`/api/crm/contacts/${detail.contact.id}/emails?email=${encodeURIComponent(email)}`,
				{ method: 'DELETE' },
			);
			if (res.status === 422) {
				flash('Cannot remove the last email on a contact', 'error');
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			flash('Email removed');
			await loadDetail(detail.contact.id);
		} catch (err) {
			flash(`Remove failed: ${errMsg(err)}`, 'error');
		}
	}

	async function addPhone() {
		if (!detail) return;
		const p = addPhoneForm.phone.trim();
		if (!p) return;
		try {
			const res = await fetch(`/api/crm/contacts/${detail.contact.id}/phones`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					phone: p,
					label: addPhoneForm.label.trim() || undefined,
					isPrimary: addPhoneForm.isPrimary,
				}),
			});
			if (res.status === 409) {
				flash('Phone already attached to a contact', 'error');
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			flash('Phone added');
			addPhoneForm = { phone: '', label: '', isPrimary: false };
			showAddPhone = false;
			await loadDetail(detail.contact.id);
		} catch (err) {
			flash(`Add phone failed: ${errMsg(err)}`, 'error');
		}
	}

	async function promotePhone(phone: string) {
		if (!detail) return;
		try {
			const res = await fetch(`/api/crm/contacts/${detail.contact.id}/phones`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ phone, makePrimary: true }),
			});
			if (!res.ok) {
				const errBody = await res.json().catch(() => ({}));
				throw new Error(errBody.error ?? `HTTP ${res.status}`);
			}
			flash(`Promoted ${phone} to primary`);
			await loadDetail(detail.contact.id);
		} catch (err) {
			flash(`Promote failed: ${errMsg(err)}`, 'error');
		}
	}

	async function removePhone(phone: string) {
		if (!detail) return;
		if (!confirm(`Remove ${phone}?`)) return;
		try {
			const res = await fetch(
				`/api/crm/contacts/${detail.contact.id}/phones?phone=${encodeURIComponent(phone)}`,
				{ method: 'DELETE' },
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			flash('Phone removed');
			await loadDetail(detail.contact.id);
		} catch (err) {
			flash(`Remove failed: ${errMsg(err)}`, 'error');
		}
	}

	async function addInteraction() {
		if (!detail) return;
		const summary = addInteractionForm.summary.trim();
		if (!summary) return;
		try {
			const res = await fetch(`/api/crm/contacts/${detail.contact.id}/interactions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					channel: addInteractionForm.channel,
					direction: addInteractionForm.direction,
					summary,
				}),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			flash('Interaction logged');
			addInteractionForm = { channel: 'email', direction: 'outbound', summary: '' };
			showAddInteraction = false;
			await loadDetail(detail.contact.id);
		} catch (err) {
			flash(`Add interaction failed: ${errMsg(err)}`, 'error');
		}
	}

	async function setFollowup(action: 'set' | 'clear') {
		if (!detail) return;
		let dueAt: number | null;
		if (action === 'clear') {
			dueAt = null;
		} else {
			if (!followupInput) return;
			const parsed = new Date(followupInput + 'T09:00:00');
			if (Number.isNaN(parsed.getTime())) {
				flash('Invalid date', 'error');
				return;
			}
			dueAt = parsed.getTime();
		}
		try {
			const res = await fetch(`/api/crm/contacts/${detail.contact.id}/followup`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ dueAt }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			flash(action === 'clear' ? 'Follow-up cleared' : 'Follow-up set');
			showFollowupForm = false;
			followupInput = '';
			await Promise.all([loadDetail(detail.contact.id), loadFollowups()]);
		} catch (err) {
			flash(`Follow-up failed: ${errMsg(err)}`, 'error');
		}
	}

	async function submitAddContact() {
		const name = addForm.displayName.trim();
		if (!name) {
			flash('Display name required', 'error');
			return;
		}
		const emails = addForm.emails
			.map((e) => ({ ...e, email: e.email.trim() }))
			.filter((e) => e.email.length > 0)
			.map((e) => ({
				email: e.email,
				label: e.label.trim() || null,
				isPrimary: e.isPrimary,
			}));
		const phones = addForm.phones
			.map((p) => ({ ...p, phone: p.phone.trim() }))
			.filter((p) => p.phone.length > 0)
			.map((p) => ({
				phone: p.phone,
				label: p.label.trim() || null,
				isPrimary: p.isPrimary,
			}));
		const payload: Record<string, unknown> = {
			displayName: name,
			emails,
			phones,
			stage: addForm.stage,
		};
		if (addForm.company.trim()) payload.company = addForm.company.trim();
		if (addForm.role.trim()) payload.role = addForm.role.trim();
		if (addForm.source) payload.source = addForm.source;
		try {
			const res = await fetch('/api/crm/contacts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (res.status === 409) {
				const errBody = await res.json().catch(() => ({}));
				flash(errBody.error ?? 'Duplicate email or phone — already attached to a contact', 'error');
				return;
			}
			if (!res.ok) {
				const errBody = await res.json().catch(() => ({}));
				throw new Error(errBody.error ?? `HTTP ${res.status}`);
			}
			const created = await res.json();
			flash(`Created ${created.displayName}`);
			showAddContact = false;
			addForm = {
				displayName: '',
				emails: [{ email: '', label: '', isPrimary: true }],
				phones: [{ phone: '', label: '', isPrimary: true }],
				company: '', role: '', source: '', stage: 'Lead',
			};
			await loadContacts();
			await selectContact(created.id);
		} catch (err) {
			flash(`Add failed: ${errMsg(err)}`, 'error');
		}
	}

	async function deleteContact() {
		if (!detail) return;
		if (!confirm(`Delete ${detail.contact.displayName}? Vault note will be kept (archived).`)) return;
		try {
			const res = await fetch(`/api/crm/contacts/${detail.contact.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			flash('Contact deleted');
			clearSelection();
			await Promise.all([loadContacts(), loadFollowups()]);
		} catch (err) {
			flash(`Delete failed: ${errMsg(err)}`, 'error');
		}
	}

	// ─── helpers ────────────────────────────────────────────────────────────

	function timeAgo(ms: number): string {
		const diff = Date.now() - ms;
		const sec = Math.floor(diff / 1000);
		if (sec < 60) return `${sec}s ago`;
		const min = Math.floor(sec / 60);
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const days = Math.floor(hr / 24);
		if (days < 30) return `${days}d ago`;
		const months = Math.floor(days / 30);
		if (months < 12) return `${months}mo ago`;
		return new Date(ms).toISOString().slice(0, 10);
	}

	function dueLabel(ms: number | null): { label: string; tone: 'overdue' | 'soon' | 'later' } | null {
		if (ms === null) return null;
		const diff = ms - Date.now();
		const days = Math.round(diff / (24 * 60 * 60 * 1000));
		if (days < 0) return { label: `${-days}d overdue`, tone: 'overdue' };
		if (days === 0) return { label: 'due today', tone: 'soon' };
		if (days <= 3) return { label: `in ${days}d`, tone: 'soon' };
		return { label: `in ${days}d`, tone: 'later' };
	}

	function primaryEmail(emails: ContactEmailDto[]): string | null {
		if (emails.length === 0) return null;
		const p = emails.find((e) => e.isPrimary);
		return p?.email ?? emails[0].email;
	}

	function flash(msg: string, type: 'info' | 'error' = 'info') {
		flashMessage = msg;
		flashType = type;
		setTimeout(() => {
			if (flashMessage === msg) flashMessage = null;
		}, 3000);
	}

	function errMsg(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}

	function formatDateTime(ms: number): string {
		return new Date(ms).toLocaleString(undefined, {
			year: 'numeric', month: 'short', day: 'numeric',
			hour: '2-digit', minute: '2-digit',
		});
	}

	function formatDate(ms: number): string {
		return new Date(ms).toLocaleDateString(undefined, {
			year: 'numeric', month: 'short', day: 'numeric',
		});
	}

	function addEmailRow() {
		addForm.emails = [...addForm.emails, { email: '', label: '', isPrimary: false }];
	}

	function removeEmailRow(idx: number) {
		if (addForm.emails.length === 1) return;
		addForm.emails = addForm.emails.filter((_, i) => i !== idx);
		if (!addForm.emails.some((e) => e.isPrimary) && addForm.emails.length > 0) {
			addForm.emails[0].isPrimary = true;
		}
	}

	function setAddFormPrimary(idx: number) {
		addForm.emails = addForm.emails.map((e, i) => ({ ...e, isPrimary: i === idx }));
	}

	function addPhoneRow() {
		addForm.phones = [...addForm.phones, { phone: '', label: '', isPrimary: false }];
	}

	function removePhoneRow(idx: number) {
		if (addForm.phones.length === 1) return;
		addForm.phones = addForm.phones.filter((_, i) => i !== idx);
		if (!addForm.phones.some((p) => p.isPrimary) && addForm.phones.length > 0) {
			addForm.phones[0].isPrimary = true;
		}
	}

	function setAddFormPrimaryPhone(idx: number) {
		addForm.phones = addForm.phones.map((p, i) => ({ ...p, isPrimary: i === idx }));
	}
</script>

<svelte:head>
	<title>CRM — Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	{#if flashMessage}
		<div class="px-4 py-2 text-sm text-center {flashType === 'error' ? 'bg-hub-danger/10 text-hub-danger' : 'bg-emerald-500/10 text-emerald-400'}">
			{flashMessage}
		</div>
	{/if}

	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-6xl mx-auto flex items-center justify-between">
			<div class="flex items-center gap-3">
				<button
					onclick={() => { showSidebar = !showSidebar; }}
					class="lg:hidden p-1 rounded text-hub-dim hover:text-hub-muted cursor-pointer"
					aria-label={showSidebar ? 'Close sidebar' : 'Open sidebar'}
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
				</button>
				<div class="flex items-center gap-2">
					<svg class="w-5 h-5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
						<circle cx="9" cy="7" r="4"/>
						<path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
						<path d="M16 3.13a4 4 0 0 1 0 7.75"/>
					</svg>
					<h1 class="text-lg font-bold text-hub-text">CRM</h1>
				</div>
				{#if total > 0}
					<span class="hidden sm:inline-block text-xs text-hub-dim px-2 py-0.5 rounded bg-hub-surface">{total} contacts</span>
				{/if}
				{#if followupBadge}
					<span class="text-xs text-hub-warning px-2 py-0.5 rounded bg-hub-warning/10">{followupBadge}</span>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				<button
					onclick={() => { showAddContact = true; }}
					class="px-4 py-2 sm:py-1.5 rounded-lg bg-hub-cta text-hub-bg text-sm font-medium hover:bg-hub-cta-hover transition-colors cursor-pointer"
				>
					<span class="hidden sm:inline">+ Add Contact</span>
					<span class="sm:hidden">+ Add</span>
				</button>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-hidden flex max-w-6xl mx-auto w-full">
		<!-- Sidebar: search + stage filter -->
		{#if showSidebar}
			<button
				type="button"
				onclick={() => { showSidebar = false; }}
				aria-label="Close sidebar"
				class="fixed inset-0 bg-black/30 z-10 lg:hidden cursor-default"
			></button>
		{/if}
		<aside class="w-56 flex-shrink-0 border-r border-hub-border p-3 overflow-y-auto {showSidebar ? 'fixed inset-y-0 left-0 z-20 bg-hub-bg' : 'hidden'} lg:block lg:static lg:z-auto">
			<div class="mb-4 relative">
				<input
					type="text"
					placeholder="Search name, company, notes..."
					bind:value={search}
					oninput={onSearchInput}
					class="w-full px-3 py-1.5 rounded-lg bg-hub-surface border border-hub-border text-sm text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 {search ? 'pr-7' : ''}"
				/>
				{#if search}
					<button
						onclick={() => { search = ''; loadContacts(); }}
						class="absolute right-2 top-1/2 -translate-y-1/2 text-hub-dim hover:text-hub-muted cursor-pointer"
						aria-label="Clear search"
					>
						<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
					</button>
				{/if}
			</div>

			{#if searchWarning}
				<p class="text-[10px] text-hub-warning px-1 -mt-3 mb-3">{searchWarning}</p>
			{/if}

			<div class="mb-4">
				<p class="text-[10px] text-hub-dim uppercase tracking-wider mb-2 px-1">Stage</p>
				<button
					type="button"
					onclick={() => setStageFilter(null)}
					aria-pressed={stageFilter === null}
					class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors text-left {stageFilter === null ? 'bg-hub-surface text-hub-text' : 'text-hub-muted hover:bg-hub-surface/50'}"
				>
					<span class="text-xs">All</span>
				</button>
				{#each STAGES as s (s)}
					<button
						type="button"
						onclick={() => setStageFilter(s)}
						aria-pressed={stageFilter === s}
						class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors text-left {stageFilter === s ? 'bg-hub-surface text-hub-text' : 'text-hub-muted hover:bg-hub-surface/50'}"
					>
						<span class="w-1.5 h-1.5 rounded-full flex-shrink-0 {STAGE_DOT_COLORS[s]}"></span>
						<span class="text-xs">{s}</span>
					</button>
				{/each}
			</div>

			<!-- Follow-up summary -->
			<div class="mt-6 pt-4 border-t border-hub-border/50">
				<p class="text-[10px] text-hub-dim uppercase tracking-wider mb-2 px-1">Follow-ups</p>
				{#if followups.overdue.length === 0 && followups.upcoming.length === 0}
					<p class="text-xs text-hub-dim px-1">None scheduled</p>
				{:else}
					{#if followups.overdue.length > 0}
						<p class="text-[11px] text-hub-danger px-1 mb-1">{followups.overdue.length} overdue</p>
						{#each followups.overdue.slice(0, 5) as c (c.id)}
							<button
								type="button"
								onclick={() => selectContact(c.id)}
								class="block w-full text-left px-2 py-1 rounded hover:bg-hub-surface/50 text-xs text-hub-text"
							>
								{c.displayName}
							</button>
						{/each}
					{/if}
					{#if followups.upcoming.length > 0}
						<p class="text-[11px] text-hub-warning px-1 mt-2 mb-1">{followups.upcoming.length} upcoming</p>
						{#each followups.upcoming.slice(0, 5) as c (c.id)}
							<button
								type="button"
								onclick={() => selectContact(c.id)}
								class="block w-full text-left px-2 py-1 rounded hover:bg-hub-surface/50 text-xs text-hub-text"
							>
								{c.displayName}
							</button>
						{/each}
					{/if}
				{/if}
			</div>
		</aside>

		<!-- Contact list -->
		<main class="{selectedId ? 'hidden sm:block' : 'block'} w-full sm:w-72 lg:w-80 flex-shrink-0 border-r border-hub-border overflow-y-auto">
			{#if loading}
				<p class="text-xs text-hub-dim px-4 py-6 text-center">Loading…</p>
			{:else if contacts.length === 0}
				<div class="px-4 py-12 text-center">
					<p class="text-sm text-hub-muted">No contacts {mode === 'search' ? 'match this search' : stageFilter ? `in ${stageFilter}` : 'yet'}.</p>
					<button
						onclick={() => { showAddContact = true; }}
						class="mt-3 text-xs text-hub-cta hover:underline cursor-pointer"
					>
						+ Add your first contact
					</button>
				</div>
			{:else}
				<ul>
					{#each contacts as c (c.id)}
						{@const pe = primaryEmail(c.emails)}
						{@const due = dueLabel(c.nextFollowupAt)}
						<li>
							<button
								type="button"
								onclick={() => selectContact(c.id)}
								aria-pressed={selectedId === c.id}
								class="w-full text-left px-4 py-3 border-b border-hub-border/50 hover:bg-hub-surface/40 cursor-pointer transition-colors {selectedId === c.id ? 'bg-hub-surface' : ''}"
							>
								<div class="flex items-center justify-between gap-2 mb-1">
									<span class="text-sm font-medium text-hub-text truncate">{c.displayName}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded {STAGE_COLORS[c.stage]} flex-shrink-0">{c.stage}</span>
								</div>
								{#if c.company}
									<p class="text-xs text-hub-muted truncate">{c.company}</p>
								{/if}
								{#if pe}
									<p class="text-[11px] text-hub-dim truncate font-mono">{pe}</p>
								{/if}
								<div class="flex items-center gap-2 mt-1">
									{#if due}
										<span class="text-[10px] {due.tone === 'overdue' ? 'text-hub-danger' : due.tone === 'soon' ? 'text-hub-warning' : 'text-hub-dim'}">↻ {due.label}</span>
									{/if}
									{#if c.lastInteractionAt}
										<span class="text-[10px] text-hub-dim">· last {timeAgo(c.lastInteractionAt)}</span>
									{/if}
								</div>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</main>

		<!-- Detail panel — visibility flips between list and detail on mobile so the
		     two share the same content area (under the AppHeader). No fixed positioning;
		     the parent layout's flex column already bounds the content correctly. -->
		<section
			class="{selectedId ? 'flex' : 'hidden'} sm:flex flex-1 flex-col overflow-hidden min-w-0"
		>
			{#if !selectedId}
				<div class="flex-1 flex items-center justify-center text-sm text-hub-dim">
					Select a contact
				</div>
			{:else if detailLoading}
				<p class="text-xs text-hub-dim px-4 py-6 text-center">Loading…</p>
			{:else if detailError}
				<p class="text-sm text-hub-danger px-4 py-6">{detailError}</p>
			{:else if detail}
				{@const c = detail.contact}
				{@const due = dueLabel(c.nextFollowupAt)}
				<!-- Detail header -->
				<div class="px-4 sm:px-6 py-4 border-b border-hub-border">
					<!-- Mobile back button — drills back to the list -->
					<button
						type="button"
						onclick={clearSelection}
						class="sm:hidden flex items-center gap-1 -ml-1 mb-2 px-2 py-2 text-sm text-hub-muted hover:text-hub-text cursor-pointer"
						aria-label="Back to contacts"
					>
						<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="15 18 9 12 15 6"/>
						</svg>
						<span>Contacts</span>
					</button>
					<div class="flex items-start justify-between gap-4">
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2 mb-1 flex-wrap">
								<h2 class="text-lg font-semibold text-hub-text truncate">{c.displayName}</h2>
								<span class="text-xs text-hub-dim">{c.id}</span>
							</div>
							{#if c.company || c.role}
								<p class="text-sm text-hub-muted">
									{c.role ?? ''}{c.role && c.company ? ' · ' : ''}{c.company ?? ''}
								</p>
							{/if}
							{#if c.source}
								<p class="text-[11px] text-hub-dim mt-0.5">source: {c.source}</p>
							{/if}
						</div>
						<div class="flex items-center gap-2 flex-shrink-0">
							<button
								onclick={() => { editingMeta = !editingMeta; if (editingMeta) seedEditForm(c); }}
								class="text-xs px-3 py-2 sm:py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text cursor-pointer"
							>
								{editingMeta ? 'Cancel' : 'Edit'}
							</button>
							<button
								onclick={deleteContact}
								class="text-xs px-3 py-2 sm:py-1 rounded border border-hub-border text-hub-danger/80 hover:text-hub-danger cursor-pointer"
							>
								Delete
							</button>
						</div>
					</div>

					<!-- Stage selector -->
					<div class="mt-3 flex items-center gap-2 flex-wrap">
						<span class="text-[10px] text-hub-dim uppercase tracking-wider w-full sm:w-auto">Stage:</span>
						{#each STAGES as s (s)}
							<button
								type="button"
								onclick={() => moveStage(s)}
								class="text-xs sm:text-[11px] px-2.5 py-1.5 sm:py-0.5 rounded transition-colors cursor-pointer {c.stage === s ? STAGE_COLORS[s] + ' ring-1 ring-current' : 'text-hub-dim hover:text-hub-text bg-hub-surface'}"
							>
								{s}
							</button>
						{/each}
					</div>

					<!-- Follow-up controls -->
					<div class="mt-3 flex items-center gap-2 flex-wrap">
						<span class="text-[10px] text-hub-dim uppercase tracking-wider w-full sm:w-auto">Follow-up:</span>
						{#if c.nextFollowupAt}
							<span class="text-xs {due?.tone === 'overdue' ? 'text-hub-danger' : due?.tone === 'soon' ? 'text-hub-warning' : 'text-hub-text'}">
								{formatDate(c.nextFollowupAt)} {due ? `(${due.label})` : ''}
							</span>
							<button
								onclick={() => setFollowup('clear')}
								class="text-xs sm:text-[11px] px-3 py-1.5 sm:py-0.5 rounded text-hub-dim hover:text-hub-danger cursor-pointer"
							>
								Clear
							</button>
						{:else}
							<span class="text-xs text-hub-dim">None</span>
						{/if}
						{#if showFollowupForm}
							<input
								type="date"
								bind:value={followupInput}
								class="px-2 py-1.5 sm:py-0.5 text-sm sm:text-xs rounded bg-hub-surface border border-hub-border text-hub-text"
							/>
							<button
								onclick={() => setFollowup('set')}
								class="text-xs sm:text-[11px] px-3 py-1.5 sm:py-0.5 rounded bg-hub-cta text-hub-bg cursor-pointer"
							>
								Set
							</button>
							<button
								onclick={() => { showFollowupForm = false; followupInput = ''; }}
								class="text-xs sm:text-[11px] px-3 py-1.5 sm:py-0.5 rounded text-hub-dim hover:text-hub-text cursor-pointer"
							>
								Cancel
							</button>
						{:else}
							<button
								onclick={() => { showFollowupForm = true; }}
								class="text-xs sm:text-[11px] px-3 py-1.5 sm:py-0.5 rounded text-hub-cta hover:underline cursor-pointer"
							>
								{c.nextFollowupAt ? 'Reschedule' : '+ Set'}
							</button>
						{/if}
					</div>
				</div>

				<!-- Inline edit form -->
				{#if editingMeta}
					<div class="px-4 sm:px-6 py-4 border-b border-hub-border bg-hub-surface/30">
						<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
							<label class="col-span-2 text-xs">
								<span class="text-hub-dim">Display name</span>
								<input
									bind:value={editForm.displayName}
									class="w-full mt-1 px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-sm text-hub-text focus:outline-none focus:border-hub-cta/50"
								/>
							</label>
							<label class="text-xs">
								<span class="text-hub-dim">Company</span>
								<input bind:value={editForm.company} class="w-full mt-1 px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-sm text-hub-text focus:outline-none" />
							</label>
							<label class="text-xs">
								<span class="text-hub-dim">Role</span>
								<input bind:value={editForm.role} class="w-full mt-1 px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-sm text-hub-text focus:outline-none" />
							</label>
							<label class="text-xs">
								<span class="text-hub-dim">Source</span>
								<select bind:value={editForm.source} class="w-full mt-1 px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-sm text-hub-text focus:outline-none">
									<option value="">(unset)</option>
									{#each SOURCES as s (s)}<option value={s}>{s}</option>{/each}
								</select>
							</label>
							<label class="col-span-2 text-xs">
								<span class="text-hub-dim">Notes</span>
								<textarea
									bind:value={editForm.notes}
									rows="3"
									class="w-full mt-1 px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-sm text-hub-text focus:outline-none font-mono"
								></textarea>
							</label>
						</div>
						<div class="mt-3 flex items-center gap-2">
							<button onclick={saveMetaEdits} class="px-3 py-1 rounded bg-hub-cta text-hub-bg text-sm cursor-pointer">Save</button>
							<button onclick={() => { editingMeta = false; }} class="px-3 py-1 rounded text-hub-muted hover:text-hub-text text-sm cursor-pointer">Cancel</button>
						</div>
					</div>
				{/if}

				<!-- Emails section -->
				<div class="px-4 sm:px-6 py-4 border-b border-hub-border">
					<div class="flex items-center justify-between mb-2">
						<p class="text-[10px] text-hub-dim uppercase tracking-wider">Emails ({detail.emails.length})</p>
						<button
							onclick={() => { showAddEmail = !showAddEmail; }}
							class="text-xs sm:text-[11px] px-2 py-1 sm:p-0 text-hub-cta hover:underline cursor-pointer"
						>
							{showAddEmail ? 'Cancel' : '+ Add'}
						</button>
					</div>
					{#each detail.emails as e (e.email)}
						<div class="flex items-center gap-2 py-1.5 text-sm flex-wrap">
							<span class="font-mono text-hub-text break-all">{e.email}</span>
							{#if e.isPrimary}
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-cta/20 text-hub-cta">primary</span>
							{/if}
							{#if e.label}
								<span class="text-[10px] text-hub-dim">{e.label}</span>
							{/if}
							<div class="ml-auto flex items-center gap-1">
								{#if !e.isPrimary}
									<button
										onclick={() => promoteEmail(e.email)}
										class="text-xs sm:text-[11px] px-2 py-1.5 sm:py-0 text-hub-dim hover:text-hub-text cursor-pointer"
									>
										make primary
									</button>
								{/if}
								<button
									onclick={() => removeEmail(e.email)}
									class="text-xs sm:text-[11px] px-2 py-1.5 sm:py-0 text-hub-dim hover:text-hub-danger cursor-pointer"
								>
									remove
								</button>
							</div>
						</div>
					{/each}
					{#if showAddEmail}
						<div class="mt-2 flex flex-col sm:flex-row sm:items-center gap-2">
							<input
								type="email"
								placeholder="email@domain"
								bind:value={addEmailForm.email}
								class="w-full sm:flex-1 px-2 py-1.5 sm:py-1 text-sm rounded bg-hub-surface border border-hub-border text-hub-text"
							/>
							<input
								type="text"
								placeholder="label"
								bind:value={addEmailForm.label}
								class="w-full sm:w-24 px-2 py-1.5 sm:py-1 text-sm rounded bg-hub-surface border border-hub-border text-hub-text"
							/>
							<div class="flex items-center justify-between gap-2">
								<label class="text-xs text-hub-muted flex items-center gap-1.5 cursor-pointer">
									<input type="checkbox" bind:checked={addEmailForm.isPrimary} class="w-4 h-4" />
									primary
								</label>
								<button onclick={addEmail} class="px-4 py-1.5 sm:py-1 rounded bg-hub-cta text-hub-bg text-sm cursor-pointer">Add</button>
							</div>
						</div>
					{/if}
				</div>

				<!-- Phones section — mirrors Emails section above. -->
				<div class="px-4 sm:px-6 py-4 border-b border-hub-border">
					<div class="flex items-center justify-between mb-2">
						<p class="text-[10px] text-hub-dim uppercase tracking-wider">Phones ({detail.phones.length})</p>
						<button
							onclick={() => { showAddPhone = !showAddPhone; }}
							class="text-xs sm:text-[11px] px-2 py-1 sm:p-0 text-hub-cta hover:underline cursor-pointer"
						>
							{showAddPhone ? 'Cancel' : '+ Add'}
						</button>
					</div>
					{#if detail.phones.length === 0 && !showAddPhone}
						<p class="text-xs text-hub-dim italic">No phone numbers on file.</p>
					{/if}
					{#each detail.phones as p (p.phone)}
						<div class="flex items-center gap-2 py-1.5 text-sm flex-wrap">
							<a href="tel:{p.phone}" class="font-mono text-hub-text hover:text-hub-cta break-all">{p.phone}</a>
							{#if p.isPrimary}
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-cta/20 text-hub-cta">primary</span>
							{/if}
							{#if p.label}
								<span class="text-[10px] text-hub-dim">{p.label}</span>
							{/if}
							<div class="ml-auto flex items-center gap-1">
								{#if !p.isPrimary}
									<button
										onclick={() => promotePhone(p.phone)}
										class="text-xs sm:text-[11px] px-2 py-1.5 sm:py-0 text-hub-dim hover:text-hub-text cursor-pointer"
									>
										make primary
									</button>
								{/if}
								<button
									onclick={() => removePhone(p.phone)}
									class="text-xs sm:text-[11px] px-2 py-1.5 sm:py-0 text-hub-dim hover:text-hub-danger cursor-pointer"
								>
									remove
								</button>
							</div>
						</div>
					{/each}
					{#if showAddPhone}
						<div class="mt-2 flex flex-col sm:flex-row sm:items-center gap-2">
							<input
								type="tel"
								placeholder="+971 5X XXX XXXX"
								bind:value={addPhoneForm.phone}
								class="w-full sm:flex-1 px-2 py-1.5 sm:py-1 text-sm rounded bg-hub-surface border border-hub-border text-hub-text"
							/>
							<input
								type="text"
								placeholder="label (mobile, work)"
								bind:value={addPhoneForm.label}
								class="w-full sm:w-32 px-2 py-1.5 sm:py-1 text-sm rounded bg-hub-surface border border-hub-border text-hub-text"
							/>
							<div class="flex items-center justify-between gap-2">
								<label class="text-xs text-hub-muted flex items-center gap-1.5 cursor-pointer">
									<input type="checkbox" bind:checked={addPhoneForm.isPrimary} class="w-4 h-4" />
									primary
								</label>
								<button onclick={addPhone} class="px-4 py-1.5 sm:py-1 rounded bg-hub-cta text-hub-bg text-sm cursor-pointer">Add</button>
							</div>
						</div>
					{/if}
				</div>

				<!-- Tabs -->
				<div class="px-4 sm:px-6 pt-3 flex items-center gap-1 border-b border-hub-border overflow-x-auto scrollbar-thin">
					{#each [
						{ key: 'interactions' as const, label: `Interactions (${detail.interactions.length})` },
						{ key: 'notes' as const, label: `Notes (${detail.notes.length})` },
						{ key: 'history' as const, label: `History (${detail.stageHistory.length})` },
						{ key: 'inbox' as const, label: `Inbox (${detail.recentInbox.length})` },
					] as t (t.key)}
						<button
							type="button"
							onclick={() => { detailTab = t.key; }}
							aria-pressed={detailTab === t.key}
							class="text-xs px-3 py-2.5 sm:py-1.5 rounded-t cursor-pointer transition-colors whitespace-nowrap flex-shrink-0 {detailTab === t.key ? 'text-hub-text border-b-2 border-hub-cta -mb-px' : 'text-hub-muted hover:text-hub-text'}"
						>
							{t.label}
						</button>
					{/each}
				</div>

				<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
					{#if detailTab === 'interactions'}
						<div class="flex items-center justify-between mb-3">
							<p class="text-[10px] text-hub-dim uppercase tracking-wider">Interaction log</p>
							<button
								onclick={() => { showAddInteraction = !showAddInteraction; }}
								class="text-xs sm:text-[11px] px-2 py-1 sm:p-0 text-hub-cta hover:underline cursor-pointer"
							>
								{showAddInteraction ? 'Cancel' : '+ Log interaction'}
							</button>
						</div>
						{#if showAddInteraction}
							<div class="mb-4 p-3 rounded bg-hub-surface/40 border border-hub-border">
								<div class="flex items-center gap-2 mb-2 flex-wrap">
									<select bind:value={addInteractionForm.channel} class="px-2 py-1.5 sm:py-1 text-sm sm:text-xs rounded bg-hub-bg border border-hub-border text-hub-text">
										{#each CHANNELS as ch (ch)}<option value={ch}>{ch}</option>{/each}
									</select>
									<select bind:value={addInteractionForm.direction} class="px-2 py-1.5 sm:py-1 text-sm sm:text-xs rounded bg-hub-bg border border-hub-border text-hub-text">
										<option value="outbound">outbound</option>
										<option value="inbound">inbound</option>
									</select>
								</div>
								<textarea
									bind:value={addInteractionForm.summary}
									placeholder="Summary…"
									rows="3"
									class="w-full px-2 py-1.5 text-sm rounded bg-hub-bg border border-hub-border text-hub-text"
								></textarea>
								<div class="mt-2 flex items-center gap-2">
									<button onclick={addInteraction} class="px-4 py-2 sm:py-1 rounded bg-hub-cta text-hub-bg text-sm cursor-pointer">Log</button>
								</div>
							</div>
						{/if}
						{#if detail.interactions.length === 0}
							<p class="text-xs text-hub-dim italic">No interactions logged.</p>
						{:else}
							<ul class="space-y-3">
								{#each detail.interactions as ix (ix.id)}
									<li class="border-l-2 border-hub-border/60 pl-3">
										<div class="flex items-center gap-2 text-[11px] text-hub-dim">
											<span class="px-1.5 py-0.5 rounded bg-hub-surface">{ix.channel}</span>
											<span>{ix.direction}</span>
											<span>·</span>
											<span>{formatDateTime(ix.timestamp)}</span>
										</div>
										<p class="text-sm text-hub-text mt-0.5 whitespace-pre-wrap">{ix.summary}</p>
									</li>
								{/each}
							</ul>
						{/if}
					{:else if detailTab === 'notes'}
						{#if detail.notes.length === 0}
							<p class="text-xs text-hub-dim italic">No notes attached. Use the chat tool <span class="font-mono">crm-attach-note</span> to link a vault note.</p>
						{:else}
							<ul class="space-y-2">
								{#each detail.notes as n (n.id)}
									<li class="flex items-start gap-2 text-sm">
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-surface text-hub-dim flex-shrink-0 mt-0.5">{n.kind}</span>
										<div class="flex-1 min-w-0">
											<a href="/vault?path={encodeURIComponent(n.vaultPath)}" class="text-hub-text hover:text-hub-cta underline-offset-2 hover:underline truncate block" target="_blank" rel="noopener">{n.label ?? n.vaultPath}</a>
											<p class="text-[10px] text-hub-dim">{formatDateTime(n.attachedAt)} · {n.vaultPath}</p>
										</div>
									</li>
								{/each}
							</ul>
						{/if}
					{:else if detailTab === 'history'}
						{#if detail.stageHistory.length === 0}
							<p class="text-xs text-hub-dim italic">No stage moves yet.</p>
						{:else}
							<ul class="space-y-2">
								{#each detail.stageHistory as h (h.id)}
									<li class="flex items-start gap-3 text-sm">
										<span class="text-[11px] text-hub-dim w-32 flex-shrink-0">{formatDateTime(h.movedAt)}</span>
										<div>
											<p class="text-hub-text">
												<span class="text-[10px] px-1.5 py-0.5 rounded {STAGE_COLORS[h.fromStage]}">{h.fromStage}</span>
												<span class="text-hub-dim">→</span>
												<span class="text-[10px] px-1.5 py-0.5 rounded {STAGE_COLORS[h.toStage]}">{h.toStage}</span>
											</p>
											{#if h.reason}
												<p class="text-xs text-hub-muted mt-0.5">{h.reason}</p>
											{/if}
										</div>
									</li>
								{/each}
							</ul>
						{/if}
					{:else if detailTab === 'inbox'}
						{#if detail.recentInbox.length === 0}
							<p class="text-xs text-hub-dim italic">No recent emails from this contact's addresses.</p>
						{:else}
							<ul class="space-y-2">
								{#each detail.recentInbox as m (m.id)}
									<li class="text-sm border-l-2 border-hub-border/60 pl-3">
										<a href="/inbox?messageId={m.id}" class="text-hub-text hover:text-hub-cta" target="_blank" rel="noopener">
											{m.subject || '(no subject)'}
										</a>
										<p class="text-[11px] text-hub-dim mt-0.5">
											{formatDateTime(m.dateReceived)} · {m.fromAddress} · {m.processStatus}
										</p>
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
				</div>
			{/if}
		</section>
	</div>
</div>

<!-- Add Contact modal -->
{#if showAddContact}
	<button
		type="button"
		onclick={() => { showAddContact = false; }}
		aria-label="Close add contact modal"
		class="fixed inset-0 bg-black/60 z-30 cursor-default"
	></button>
	<div class="fixed inset-0 z-40 flex items-end sm:items-center justify-center sm:p-4 pointer-events-none">
		<div class="bg-hub-surface border border-hub-border rounded-t-2xl sm:rounded-xl w-full max-w-lg p-5 pointer-events-auto shadow-xl max-h-[92vh] sm:max-h-[90vh] overflow-y-auto self-end sm:self-auto">
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-sm font-semibold text-hub-text">Add Contact</h2>
				<button
					onclick={() => { showAddContact = false; }}
					class="p-2 -mr-2 text-hub-dim hover:text-hub-text cursor-pointer"
					aria-label="Close"
				>
					<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
				</button>
			</div>
			<div class="space-y-3">
				<label class="block text-xs">
					<span class="text-hub-dim">Display name *</span>
					<input
						bind:value={addForm.displayName}
						class="w-full mt-1 px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-sm text-hub-text focus:outline-none focus:border-hub-cta/50"
					/>
				</label>
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<label class="text-xs">
						<span class="text-hub-dim">Company</span>
						<input bind:value={addForm.company} class="w-full mt-1 px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-sm text-hub-text" />
					</label>
					<label class="text-xs">
						<span class="text-hub-dim">Role</span>
						<input bind:value={addForm.role} class="w-full mt-1 px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-sm text-hub-text" />
					</label>
					<label class="text-xs">
						<span class="text-hub-dim">Source</span>
						<select bind:value={addForm.source} class="w-full mt-1 px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-sm text-hub-text">
							<option value="">(unset)</option>
							{#each SOURCES as s (s)}<option value={s}>{s}</option>{/each}
						</select>
					</label>
					<label class="text-xs">
						<span class="text-hub-dim">Stage</span>
						<select bind:value={addForm.stage} class="w-full mt-1 px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-sm text-hub-text">
							{#each STAGES as s (s)}<option value={s}>{s}</option>{/each}
						</select>
					</label>
				</div>
				<div>
					<div class="flex items-center justify-between mb-1">
						<span class="text-xs text-hub-dim">Emails</span>
						<button onclick={addEmailRow} class="text-[11px] text-hub-cta hover:underline cursor-pointer">+ Add another</button>
					</div>
					{#each addForm.emails as e, i (i)}
						<div class="flex items-center gap-2 mb-1.5">
							<input
								type="email"
								placeholder="email@domain"
								bind:value={addForm.emails[i].email}
								class="flex-1 px-2 py-1 text-sm rounded bg-hub-bg border border-hub-border text-hub-text"
							/>
							<input
								type="text"
								placeholder="label"
								bind:value={addForm.emails[i].label}
								class="w-20 px-2 py-1 text-sm rounded bg-hub-bg border border-hub-border text-hub-text"
							/>
							<button
								type="button"
								onclick={() => setAddFormPrimary(i)}
								title="Make primary"
								class="text-[11px] px-2 py-1 rounded {e.isPrimary ? 'bg-hub-cta/20 text-hub-cta' : 'text-hub-dim hover:text-hub-text'} cursor-pointer"
							>
								{e.isPrimary ? '★' : '☆'}
							</button>
							{#if addForm.emails.length > 1}
								<button
									type="button"
									onclick={() => removeEmailRow(i)}
									class="text-[11px] text-hub-dim hover:text-hub-danger cursor-pointer"
									aria-label="Remove email row"
								>
									x
								</button>
							{/if}
						</div>
					{/each}
				</div>
				<div>
					<div class="flex items-center justify-between mb-1">
						<span class="text-xs text-hub-dim">Phones</span>
						<button onclick={addPhoneRow} class="text-[11px] text-hub-cta hover:underline cursor-pointer">+ Add another</button>
					</div>
					{#each addForm.phones as p, i (i)}
						<div class="flex items-center gap-2 mb-1.5">
							<input
								type="tel"
								placeholder="+971 5X XXX XXXX"
								bind:value={addForm.phones[i].phone}
								class="flex-1 px-2 py-1 text-sm rounded bg-hub-bg border border-hub-border text-hub-text"
							/>
							<input
								type="text"
								placeholder="label"
								bind:value={addForm.phones[i].label}
								class="w-20 px-2 py-1 text-sm rounded bg-hub-bg border border-hub-border text-hub-text"
							/>
							<button
								type="button"
								onclick={() => setAddFormPrimaryPhone(i)}
								title="Make primary"
								class="text-[11px] px-2 py-1 rounded {p.isPrimary ? 'bg-hub-cta/20 text-hub-cta' : 'text-hub-dim hover:text-hub-text'} cursor-pointer"
							>
								{p.isPrimary ? '★' : '☆'}
							</button>
							{#if addForm.phones.length > 1}
								<button
									type="button"
									onclick={() => removePhoneRow(i)}
									class="text-[11px] text-hub-dim hover:text-hub-danger cursor-pointer"
									aria-label="Remove phone row"
								>
									x
								</button>
							{/if}
						</div>
					{/each}
				</div>
			</div>
			<div class="mt-4 flex items-center justify-end gap-2">
				<button onclick={() => { showAddContact = false; }} class="px-3 py-1.5 rounded text-sm text-hub-muted hover:text-hub-text cursor-pointer">Cancel</button>
				<button onclick={submitAddContact} class="px-4 py-1.5 rounded bg-hub-cta text-hub-bg text-sm font-medium cursor-pointer">Create</button>
			</div>
		</div>
	</div>
{/if}
