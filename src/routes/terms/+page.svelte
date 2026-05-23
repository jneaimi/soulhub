<script lang="ts">
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	const lastUpdated = '2026-05-18';
</script>

<svelte:head>
	<title>Terms of Service — Soul Hub</title>
	<meta name="description" content="Terms of service for Soul Hub, a self-hosted personal productivity application operated by {data.operatorName}." />
</svelte:head>

<div class="h-full overflow-y-auto bg-hub-bg text-hub-text">
	<article class="max-w-3xl mx-auto px-6 py-12 leading-relaxed">
		<header class="mb-10 pb-6 border-b border-hub-border/60">
			<h1 class="text-3xl font-semibold mb-2">Terms of Service</h1>
			<p class="text-sm text-hub-dim">Last updated: {lastUpdated}</p>
		</header>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">1. Scope</h2>
			<p>
				Soul Hub is personal-use software operated by {data.operatorName} (the &ldquo;Operator&rdquo;)
				on his own infrastructure for his own productivity. It is not offered as a service to
				the public.
			</p>
			<p>
				No third parties are authorised to create accounts, connect mailboxes, or otherwise use
				Soul Hub.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">2. Authorised users</h2>
			<p>
				The only authorised user is the Operator. Soul Hub does not provision accounts, does not
				accept sign-ups, and does not expose any user-facing registration flow.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">3. Acceptable use</h2>
			<p>
				The Operator agrees to use Soul Hub in compliance with the terms of every connected
				third-party service, including Google&rsquo;s
				<a class="underline" href="https://developers.google.com/terms/api-services-user-data-policy">
					API Services User Data Policy
				</a>, Apple&rsquo;s iCloud terms, and any other provider whose APIs are accessed through
				the application.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">4. No warranty</h2>
			<p>
				Soul Hub is provided &ldquo;as is&rdquo; without warranty of any kind, express or implied.
				The Operator makes no representations regarding fitness for any particular purpose,
				reliability, or availability, and disclaims any obligation to maintain, support, update,
				or backfill data within Soul Hub.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">5. No liability</h2>
			<p>
				Because Soul Hub processes only the Operator&rsquo;s own data on his own infrastructure,
				no liability is owed to any external party. To the extent any liability could exist, it
				is disclaimed to the maximum extent permitted by law.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">6. Discontinuation</h2>
			<p>
				The Operator may modify, suspend, or shut down Soul Hub at any time without notice. The
				Operator may also disconnect mailbox accounts and delete locally stored data at any time.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">7. Privacy</h2>
			<p>
				Data handling is described in the
				<a class="underline" href="/privacy">Privacy Policy</a>.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">8. Governing law</h2>
			<p>
				These terms are governed by the laws of the United Arab Emirates. Any dispute arising
				from the operation of Soul Hub falls under the exclusive jurisdiction of the courts of
				Dubai, UAE.
			</p>
		</section>

		<section class="space-y-4">
			<h2 class="text-xl font-semibold">9. Contact</h2>
			<p>
				{data.operatorName}{#if data.operatorEmail} &mdash; <a class="underline" href="mailto:{data.operatorEmail}">{data.operatorEmail}</a>{/if}
			</p>
		</section>
	</article>
</div>
