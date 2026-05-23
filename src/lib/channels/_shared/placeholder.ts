/** Route → placeholder text mapping. Per ADR-022 Layer B.
 *
 *  v0: route name + a couple of context flags drive the text. ADR-023 will
 *  add a `placeholder_text` column to `intent_patterns` so pattern-routed
 *  dispatches get topic-specific text ("Pulling up your Wed draft now…")
 *  instead of the generic route default. Until then the dispatcher passes
 *  `patternText` through if it has one; we use it verbatim. */

export interface PlaceholderOpts {
	/** When the route is `vault-chat` and the user message matched the
	 *  focus-query regex (per `vault-chat/selector.ts:isFocusQuery`),
	 *  swap the generic "looking through your vault" text for the more
	 *  precise "pulling up the latest one". */
	isFocusQuery?: boolean;
	/** When the user attached an image / video / document, signal that
	 *  the bubble is acknowledging media specifically. */
	hasMedia?: boolean;
	/** Agent dispatch — surfaces the agent name in the bubble. */
	agentId?: string;
	/** ADR-023 hook — when a pattern fires deterministically, the
	 *  pattern's own placeholder text wins over the route default. */
	patternText?: string;
}

const ROUTE_DEFAULTS: Record<string, string> = {
	// `vault-chat` is the catch-all route for free-form messages handled by
	// the orchestrator-v2 LLM. The orchestrator may pick ANY tool (vault,
	// web, inbox, agent dispatch, etc.) or simply reply — so the initial
	// bubble must NOT pre-commit to vault. ADR-029's stream events morph
	// this to the specific tool placeholder within ~1-2s when a tool fires.
	// Reply-only turns ("Hi") stay at this generic text until the final
	// reply text replaces the bubble — which is correct: the model IS
	// just thinking.
	'vault-chat': '🟡 Thinking…',
	'vault-find': '🟡 Searching for matches…',
	'vault-recent': '🟡 Fetching recent notes…',
	'vault-save-note': '🟡 Saving to vault…',
	img: '🟡 Generating the image…',
};

// Strong content-signal overrides for `vault-chat` — when the message
// explicitly asks for the latest/newest of something OR carries media,
// the orchestrator is overwhelmingly likely to read the vault / read the
// attachment, so a vault-flavoured placeholder is accurate.
const VAULT_CHAT_FOCUS = '🟡 Pulling up the latest one…';
const VAULT_CHAT_MULTIMODAL = '🟡 Reading what you sent…';
const FALLBACK = '🟡 Working on it…';

export function placeholderTextForRoute(
	route: string,
	opts: PlaceholderOpts = {},
): string {
	if (opts.patternText) return opts.patternText;

	if (opts.agentId) {
		return `🟡 Running *${opts.agentId}*…`;
	}

	if (route === 'vault-chat') {
		if (opts.hasMedia) return VAULT_CHAT_MULTIMODAL;
		if (opts.isFocusQuery) return VAULT_CHAT_FOCUS;
	}

	return ROUTE_DEFAULTS[route] ?? FALLBACK;
}

/** Detect "focus" queries — mirrors `vault-chat/selector.ts:isFocusQuery`
 *  but lives here so the placeholder helper has no dependency on the
 *  selector module (avoids circular imports during early routing).
 *  Pattern: "the/my/this/that" + "latest/newest/most recent/last" +
 *  singular content noun. */
export function isFocusQuery(message: string): boolean {
	const lower = message.toLowerCase();
	return /\b(?:the|my|that|this)\s+(?:latest|newest|most\s+recent|last)\s+(?:draft|post|note|decision|writeup|writup|adr|entry|capture|save|article|reference|learning|debug|debugging|research|recipe|pattern|snippet)\b/.test(
		lower,
	);
}
