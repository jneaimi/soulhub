/** HEARTBEAT_OK token contract — replaces the v1 condition language.
 *
 *  The agent decides if anything's worth surfacing. If the reply is
 *  effectively just the OK acknowledgment (token at start or end + the
 *  remaining content is below `ackMaxChars`), we suppress delivery and
 *  log the run as `ack`.
 *
 *  Token in the middle of a message is left alone — it's almost certainly
 *  the model quoting itself rather than acking.
 *
 *  Slice 5 extension — the token may carry a list of commitment IDs the
 *  agent wants explicitly dismissed: `HEARTBEAT_OK 3 5` or `HEARTBEAT_OK
 *  3,5`. The IDs round-trip back to the runner so it can mark only those
 *  rows as dismissed. */

export const HEARTBEAT_OK_TOKEN = 'HEARTBEAT_OK';

export interface StripResult {
	/** True when the run should be treated as an OK ack — no delivery. */
	shouldSkip: boolean;
	/** Text minus the token; what gets delivered when `shouldSkip` is false. */
	cleanText: string;
	/** Commitment IDs the agent explicitly dismissed via `HEARTBEAT_OK <ids>`.
	 *  Empty when the token had no ID list — in that case the runner may
	 *  apply its own default policy (typically: dismiss all included). */
	dismissedIds: number[];
}

export interface StripOptions {
	/** Max chars of non-token content allowed for ack-only suppression. */
	ackMaxChars: number;
}

/** Detect and strip the HEARTBEAT_OK token (and any trailing ID list). */
export function stripHeartbeatToken(rawInput: string | undefined, opts: StripOptions): StripResult {
	const text = (rawInput ?? '').trim();
	if (!text) {
		// Empty model output is treated as an ack — nothing to deliver anyway.
		return { shouldSkip: true, cleanText: '', dismissedIds: [] };
	}

	const max = Math.max(0, Math.floor(opts.ackMaxChars));

	// Capture optional ID list after the token: digits separated by spaces or
	// commas. `\d+(?:[\s,]+\d+)*` keeps it tight so a stray "HEARTBEAT_OK 1234"
	// in chat content can't accidentally swallow trailing prose.
	const idListPattern = '\\d+(?:[\\s,]+\\d+)*';
	const leadingRe = new RegExp(`^${HEARTBEAT_OK_TOKEN}\\b(?:[\\s,]+(${idListPattern}))?[\\s.:,!\\-]*`);
	const trailingRe = new RegExp(`[\\s.:,!\\-]*\\b${HEARTBEAT_OK_TOKEN}\\b(?:[\\s,]+(${idListPattern}))?\\s*$`);

	let stripped = text;
	let foundLeading = false;
	let foundTrailing = false;
	let idGroup: string | undefined;

	const leadingMatch = stripped.match(leadingRe);
	if (leadingMatch) {
		idGroup = leadingMatch[1] ?? idGroup;
		stripped = stripped.replace(leadingRe, '').trim();
		foundLeading = true;
	}
	const trailingMatch = stripped.match(trailingRe);
	if (trailingMatch) {
		idGroup = trailingMatch[1] ?? idGroup;
		stripped = stripped.replace(trailingRe, '').trim();
		foundTrailing = true;
	}

	const dismissedIds = idGroup
		? Array.from(new Set(idGroup.split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n > 0)))
		: [];

	if (!foundLeading && !foundTrailing) {
		// Token absent (or only mid-message — which we don't strip).
		return { shouldSkip: false, cleanText: text, dismissedIds: [] };
	}

	// Token present at boundary. Suppress when remaining content fits the
	// ack ceiling — otherwise treat as a real reply that happened to bracket
	// itself with the token.
	if (stripped.length <= max) {
		return { shouldSkip: true, cleanText: '', dismissedIds };
	}
	return { shouldSkip: false, cleanText: stripped, dismissedIds };
}
