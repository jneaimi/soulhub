/** ADR-029 — per-tool progress placeholder text registry.
 *
 *  Single source of truth for what the bubble says while a tool is
 *  executing. Maps internal tool names (as registered in the orchestrator-v2
 *  tools manifest) to short, user-friendly verbs.
 *
 *  Two paths render this:
 *
 *    - `tool-input-start` stream event → "🟡 Reading your inbox…"
 *      (the tool is *running*; user sees forward progress)
 *    - `tool-result` stream event → "🟡 Inbox read — composing…"
 *      (the tool *finished*; user sees the orchestrator is wrapping up)
 *
 *  Missing tools fall back to a generic "🟡 Running <name>…" so an
 *  un-registered tool degrades to the verbose surface rather than no
 *  signal at all. That's deliberate — better the user sees an awkward
 *  internal name than a stuck "🟡 Looking through your vault…" for 60s.
 *
 *  Keep the values short. WhatsApp bubble rendering chops at ~80 chars.
 */

/** Tool name (as registered in `buildOrchestratorTools()`) → in-progress
 *  text. Exported for tests + the optional `/orchestration/tools` page
 *  enrichment. */
export const TOOL_PROGRESS: Record<string, string> = {
	reply: '🟡 Composing reply…',
	// Read
	webSearch: '🟡 Searching the web…',
	vaultSearch: '🟡 Searching your vault…',
	youtubeFetch: '🟡 Reading that video…',
	tiktokFetch: '🟡 Reading that TikTok…',
	fetchPage: '🟡 Fetching that page…',
	// Write
	generateImage: '🟡 Generating image…',
	vaultSave: '🟡 Saving to vault…',
	// Heavy dispatch
	dispatchAgent: '🟡 Lining up an agent…',
	invokeSkill: '🟡 Running skill…',
	scheduleReminder: '🟡 Setting reminder…',
	// Inbox
	'inbox-list-queued': '🟡 Reading your inbox…',
	'inbox-read-body': '🟡 Fetching message body…',
	'inbox-drill-down': '🟡 Looking up that message…',
	'inbox-extract-data': '🟡 Extracting transaction details…',
	'inbox-mark-processed': '🟡 Marking as processed…',
	'inbox-correct-classification': '🟡 Re-classifying…',
	// CRM
	'crm-add-contact': '🟡 Adding contact…',
	'crm-find-contact': '🟡 Looking up contact…',
	'crm-log-interaction': '🟡 Logging interaction…',
	'crm-update-stage': '🟡 Updating pipeline stage…',
	'crm-set-followup': '🟡 Setting follow-up…',
	'crm-list-followups': '🟡 Listing follow-ups…',
	'crm-add-email': '🟡 Saving email…',
	'crm-add-phone': '🟡 Saving phone…',
	'crm-attach-note': '🟡 Attaching note…',
	'crm-find-website-leads': '🟡 Scanning website leads…',
};

/** Lookup helper — `progressTextForTool('inbox-list-queued')` returns the
 *  registry text or a generic fallback. Always returns a non-empty string. */
export function progressTextForTool(name: string): string {
	return TOOL_PROGRESS[name] ?? `🟡 Running ${name}…`;
}

/** Friendly name for the `tool-result` post-execute placeholder. Strips
 *  the leading "🟡 " emoji + verb suffix so we don't double-emoji the
 *  composing line. */
function prettyToolName(name: string): string {
	const registry = TOOL_PROGRESS[name];
	if (!registry) return name;
	// Strip leading emoji + trailing ellipsis: "🟡 Reading your inbox…" → "Reading your inbox"
	return registry.replace(/^🟡\s*/, '').replace(/[.…]+$/, '').trim();
}

/** Text for the brief "composing" stage between `tool-result` and the
 *  final reply landing. Mirrors the same friendly verb as the in-progress
 *  text so the user sees a coherent stage progression. */
export function composingTextForTool(name: string): string {
	const verb = prettyToolName(name);
	return `🟡 ${verb} — composing…`;
}
