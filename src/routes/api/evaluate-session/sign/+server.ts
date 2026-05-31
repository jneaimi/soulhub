/** GET /api/evaluate-session/sign?project=<slug>
 *
 *  ADR-045 P2 — mints a per-conversation signed URL for the ElevenLabs
 *  Conversational AI widget, **with a per-session scenario override**.
 *
 *  Flow:
 *    1. Resolve scenario note for the requested project (most recent note
 *       in `projects/<slug>/` tagged `scenario` + `evaluate-session`).
 *    2. Splice scenario body into the universal prompt template at
 *       `<<<SCENARIO_INJECTION_POINT>>>` (see agent-template.ts).
 *    3. Request a signed URL from ElevenLabs's `/convai/conversation/
 *       get_signed_url` endpoint for the configured agent.
 *    4. Return `{ ok, signedUrl, overrides: { agent: { prompt: { prompt }, first_message? } } }`
 *       — the face widget passes `overrides` to the @elevenlabs/client
 *       SDK at `conversation.startSession({ overrides })` so the agent
 *       runs that conversation with the spliced scenario active.
 *
 *  Same-origin guard: an Origin header (if present) must match the
 *  request's own host. Cross-site callers are rejected with 403.
 *
 *  Project param defaults to `coffee-ops-sandiego` (the v0.2 falsifier
 *  project). Future per-customer deployments override via face's
 *  `PUBLIC_EVALUATE_PROJECT` env or per-URL launcher.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getVaultEngine } from '$lib/vault/index.js';
import { EVALUATE_AGENT_PROMPT_TEMPLATE, SCENARIO_INJECTION_MARKER } from '$lib/evaluate-session/agent-template.js';

const ELEVENLABS_API = 'https://api.elevenlabs.io/v1';
const DEFAULT_PROJECT = 'coffee-ops-sandiego';

/** Find the most recent scenario note for a project. Convention:
 *  - lives under `projects/<slug>/`
 *  - tags include both `scenario` and `evaluate-session`
 *  - sorted by `created` (YYYY-MM-DD string compare; lex-sort matches date-sort)
 *  Returns null when no scenario is found. */
function findScenarioNote(projectSlug: string): { path: string; body: string; meta: Record<string, unknown> } | null {
	const engine = getVaultEngine();
	if (!engine) return null;
	const results = engine.getNotes({
		project: projectSlug,
		tags: ['scenario', 'evaluate-session'],
		limit: 50,
	});
	if (results.length === 0) return null;
	// Most recent first by path (filenames are YYYY-MM-DD-prefixed by
	// convention, so lex-sort on path matches date-sort on created).
	// SearchResult doesn't carry frontmatter; fetching each note's meta
	// just to sort would be wasteful when the filename already encodes it.
	results.sort((a, b) => b.path.localeCompare(a.path));
	const top = results[0];
	const note = engine.getNote(top.path);
	if (!note) return null;
	return {
		path: note.path,
		body: note.content ?? '',
		meta: (note.meta ?? {}) as Record<string, unknown>,
	};
}

/** Strip the leading H1 (`# Title`) from a scenario body so the splice
 *  doesn't introduce a redundant heading mid-prompt. Idempotent — bodies
 *  without an H1 pass through unchanged. */
function stripLeadingH1(body: string): string {
	return body.replace(/^#\s+[^\n]*\n+/, '');
}

export const GET: RequestHandler = async ({ request, url }) => {
	// ── Same-origin guard ────────────────────────────────────────────────────
	const origin = request.headers.get('origin');
	if (origin) {
		const allowed = `${url.protocol}//${url.host}`;
		if (origin !== allowed) {
			return json({ ok: false, error: 'Forbidden' }, { status: 403 });
		}
	}

	// ── Credentials ──────────────────────────────────────────────────────────
	const agentId = env.ELEVENLABS_EVALUATE_AGENT_ID;
	const apiKey = env.ELEVENLABS_API_KEY;
	if (!agentId || !apiKey) {
		return json(
			{ ok: false, error: 'ElevenLabs credentials not configured (set ELEVENLABS_EVALUATE_AGENT_ID + ELEVENLABS_API_KEY)' },
			{ status: 503 },
		);
	}

	// ── Resolve scenario for the requested project ───────────────────────────
	const projectSlug = (url.searchParams.get('project') ?? DEFAULT_PROJECT).trim();
	if (!/^[a-z0-9][a-z0-9-]*$/i.test(projectSlug)) {
		return json({ ok: false, error: 'Invalid project slug' }, { status: 400 });
	}
	const scenario = findScenarioNote(projectSlug);
	if (!scenario) {
		return json(
			{
				ok: false,
				error: `No scenario found for project '${projectSlug}'. Author a note under projects/${projectSlug}/ tagged \`scenario\` + \`evaluate-session\`.`,
			},
			{ status: 404 },
		);
	}

	// ── Splice scenario into the universal template ─────────────────────────
	if (!EVALUATE_AGENT_PROMPT_TEMPLATE.includes(SCENARIO_INJECTION_MARKER)) {
		return json(
			{ ok: false, error: `Template missing injection marker '${SCENARIO_INJECTION_MARKER}'` },
			{ status: 500 },
		);
	}
	const scenarioBody = stripLeadingH1(scenario.body).trim();
	const splicedPrompt = EVALUATE_AGENT_PROMPT_TEMPLATE.replace(SCENARIO_INJECTION_MARKER, scenarioBody);

	// ── Optional per-scenario first_message override ────────────────────────
	const firstMessage = typeof scenario.meta.first_message === 'string'
		? scenario.meta.first_message
		: undefined;

	// ── Mint signed URL from ElevenLabs ──────────────────────────────────────
	let resp: Response;
	try {
		resp = await fetch(
			`${ELEVENLABS_API}/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`,
			{ headers: { 'xi-api-key': apiKey } },
		);
	} catch (err) {
		return json(
			{ ok: false, error: err instanceof Error ? err.message : 'ElevenLabs unreachable' },
			{ status: 502 },
		);
	}
	if (!resp.ok) {
		const detail = await resp.text().catch(() => '');
		return json(
			{ ok: false, error: `ElevenLabs API error ${resp.status}: ${detail.slice(0, 200)}` },
			{ status: 502 },
		);
	}
	const data = (await resp.json()) as { signed_url?: string };
	if (!data.signed_url) {
		return json({ ok: false, error: 'No signed_url in ElevenLabs response' }, { status: 502 });
	}

	// ── Compose the per-session override payload ─────────────────────────────
	// The face widget passes this through to `@elevenlabs/client`'s
	// `conversation.startSession({ overrides })`. ElevenLabs applies these
	// for that one conversation only; the stored agent config is untouched.
	const overrides = {
		agent: {
			prompt: { prompt: splicedPrompt },
			...(firstMessage ? { first_message: firstMessage } : {}),
		},
	};

	return json({
		ok: true,
		signedUrl: data.signed_url,
		overrides,
		scenarioPath: scenario.path,
		// Surface the agent id so the face widget can confirm it matches the
		// configured target (sanity check, no auth purpose).
		agentId,
	});
};
