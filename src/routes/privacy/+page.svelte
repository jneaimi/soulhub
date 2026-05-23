<script lang="ts">
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	const lastUpdated = '2026-05-18';
</script>

<svelte:head>
	<title>Privacy Policy — Soul Hub</title>
	<meta name="description" content="Privacy policy for Soul Hub, a self-hosted personal productivity application operated by {data.operatorName}." />
</svelte:head>

<div class="h-full overflow-y-auto bg-hub-bg text-hub-text">
	<article class="max-w-3xl mx-auto px-6 py-12 leading-relaxed">
		<header class="mb-10 pb-6 border-b border-hub-border/60">
			<h1 class="text-3xl font-semibold mb-2">Privacy Policy</h1>
			<p class="text-sm text-hub-dim">Last updated: {lastUpdated}</p>
		</header>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">1. What Soul Hub is</h2>
			<p>
				Soul Hub is a self-hosted personal productivity application operated by {data.operatorName}
				(the &ldquo;Operator&rdquo;). It aggregates email, notes, contacts, and scheduling for the
				Operator&rsquo;s personal use.
			</p>
			<p>
				Soul Hub has <strong>no other users</strong>. It is not offered as a service to the public,
				to organisations, or to family or friends. The OAuth client registered with Google,
				Apple, and Microsoft is configured for the Operator&rsquo;s own mailboxes only.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">2. Whose data is processed</h2>
			<p>
				Only the Operator&rsquo;s own personal data is processed by Soul Hub: emails from his own
				mailboxes, his own calendar, his own contacts, and his own notes. No third-party user
				accounts are ever connected. No external user data is collected, stored, or processed.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">3. What Google account data is accessed</h2>
			<p>
				When the Operator authorises a Gmail account, Soul Hub requests the following scope:
			</p>
			<ul class="list-disc pl-6 space-y-1">
				<li><code class="text-sm bg-hub-bg-elevated px-1.5 py-0.5 rounded">https://mail.google.com/</code> &mdash; read messages over IMAP</li>
			</ul>
			<p>
				Messages are fetched over IMAP, parsed, and stored in an encrypted SQLite database on the
				Operator&rsquo;s own server. OAuth refresh tokens are encrypted at rest using
				application-managed keys.
			</p>
			<p>
				Soul Hub does <strong>not</strong> send messages, modify mailbox state, delete messages,
				or change Gmail settings.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">4. Where data is stored</h2>
			<p>
				All data is stored locally on the Operator&rsquo;s self-hosted infrastructure. The
				database files live under <code class="text-sm bg-hub-bg-elevated px-1.5 py-0.5 rounded">~/.soul-hub/data/</code>
				on a server controlled solely by the Operator. There is no cloud-hosted backend, no
				multi-tenant database, and no shared storage.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">5. Third-party processors</h2>
			<p>
				The Operator occasionally uses commercial AI APIs to process his own data for personal
				productivity tasks (summarisation, drafting replies, voice transcription). When such a
				call is made, only the content needed for that task is sent. The following providers
				may receive content fragments under their own privacy terms:
			</p>
			<ul class="list-disc pl-6 space-y-1">
				<li>Google (Gemini API)</li>
				<li>OpenRouter (routing to OpenAI, Anthropic, DeepSeek, Z.ai)</li>
				<li>ElevenLabs (text-to-speech)</li>
				<li>Resend (outbound email delivery for newsletter sends)</li>
			</ul>
			<p>
				No bulk export of mailbox content is sent to any third party. AI processing is
				per-request, scoped to the task at hand.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">6. Sharing and disclosure</h2>
			<p>
				Soul Hub does not sell, rent, share, or otherwise disclose data to any party. It has no
				advertising network, no analytics tracker, and no telemetry endpoint. Crash logs stay
				local.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">7. Retention and deletion</h2>
			<p>
				Per-account retention is configurable. Default retention is 30&ndash;90 days, after which
				messages are pruned from the local database. The Operator may delete any account at any
				time, which removes the stored credentials and locally cached messages.
			</p>
			<p>
				Connected mailbox accounts may be revoked at any time at
				<a class="underline" href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">8. Security</h2>
			<p>
				The application runs behind Cloudflare Access. OAuth credentials and message bodies are
				encrypted at rest. The host operating system, infrastructure, and SSH keys are managed
				exclusively by the Operator.
			</p>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">9. Limited Use disclosure</h2>
			<p>
				Soul Hub&rsquo;s use and transfer of information received from Google APIs to any other
				app will adhere to the
				<a class="underline" href="https://developers.google.com/terms/api-services-user-data-policy">
					Google API Services User Data Policy
				</a>, including the Limited Use requirements. Specifically:
			</p>
			<ul class="list-disc pl-6 space-y-1">
				<li>Data is used only to provide the Operator&rsquo;s personal productivity features.</li>
				<li>Data is not transferred to others except as needed to provide those features.</li>
				<li>Data is not used or transferred for advertising, including retargeted advertising.</li>
				<li>Humans do not read the data unless the Operator has given explicit consent for specific messages, the data is necessary for security purposes, or the data is aggregated and used for internal operations in accordance with applicable laws.</li>
			</ul>
		</section>

		<section class="space-y-4 mb-8">
			<h2 class="text-xl font-semibold">10. Changes</h2>
			<p>
				The Operator may revise this policy. Material changes will be reflected by an updated
				&ldquo;Last updated&rdquo; date at the top of this page.
			</p>
		</section>

		<section class="space-y-4">
			<h2 class="text-xl font-semibold">11. Contact</h2>
			<p>
				{data.operatorName}{#if data.operatorEmail} &mdash; <a class="underline" href="mailto:{data.operatorEmail}">{data.operatorEmail}</a>{/if}
			</p>
		</section>
	</article>
</div>
