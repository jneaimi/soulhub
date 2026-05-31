/**
 * ADR-004 P2 — Post-call analyst gates for the Evaluate Session brief.
 *
 * Three rules per the ADR Decision:
 *   1. looksConcrete(pull_out_trigger) — rejects vague trip-wires
 *      (hedging stems / missing quantity-duration-event anchor).
 *   2. verbatimAnchorOk(verdict_reason, transcript) — verdict_reason
 *      must contain a single-quoted phrase that actually appears
 *      (case-insensitive, light normalization) in an SME transcript turn.
 *   3. scanBannedLexicon(brief) — scans every brief field for the five
 *      register categories from ADR-004 §1 (compliance / AI-spec /
 *      vague-quantifier / therapist / consultant).
 *
 * `runAllGates(brief, transcript)` is the single entry point: returns
 * whether the brief passes + an array of failures.  The post-call route
 * uses the failures to override `brief.verdict = "back-to-draft"` with
 * structured reasons; this is the mechanical safety net that catches
 * what the live-LLM Iron Rule pressure (template) lets slip.
 *
 * Pure functions; no I/O.  Lives outside the route so it can be
 * unit-tested + reused if the analyst pipeline grows.
 */

import type { Brief } from './index.js';

export interface GateResult {
	rule: string;
	pass: boolean;
	severity: 'high' | 'medium';
	message: string;
	field?: keyof Brief;
}

export interface TranscriptTurn {
	role: 'agent' | 'user';
	message: string;
}

/** ADR-004 §2 — heuristic concrete-trip-wire check. */
const HEDGING_RE = /\b(based on|as needed|if (quality|performance|results)|over time|eventually)\b/i;
const QUANTITY_RE = /\d+/;
const DURATION_RE = /\b(week|month|cycle|by|within)\b/i;
const EVENT_RE = /\b(customer|complaint|refund|miss|hire)\b/i;

export function looksConcrete(trigger: string | undefined | null): GateResult {
	const t = (trigger ?? '').trim();
	if (!t) {
		return {
			rule: 'looks-concrete:empty',
			pass: false,
			severity: 'high',
			field: 'pull_out_trigger',
			message: 'pull_out_trigger is empty — the session never landed a concrete trip-wire.',
		};
	}
	if (HEDGING_RE.test(t)) {
		return {
			rule: 'looks-concrete:hedging',
			pass: false,
			severity: 'high',
			field: 'pull_out_trigger',
			message: `pull_out_trigger contains hedging language ("${t.match(HEDGING_RE)?.[0]}") — not a concrete trip-wire.`,
		};
	}
	const hasAnchor = QUANTITY_RE.test(t) || DURATION_RE.test(t) || EVENT_RE.test(t);
	if (!hasAnchor) {
		return {
			rule: 'looks-concrete:no-anchor',
			pass: false,
			severity: 'high',
			field: 'pull_out_trigger',
			message: 'pull_out_trigger lacks at least one of: quantity (\\d+), duration (week/month/cycle/by/within), or observable event (customer/complaint/refund/miss/hire).',
		};
	}
	return { rule: 'looks-concrete', pass: true, severity: 'high', field: 'pull_out_trigger', message: 'pass' };
}

/** Light normalization for case-insensitive verbatim matching:
 *  collapse runs of whitespace, strip leading/trailing punctuation,
 *  lowercase. Preserves the semantic content while tolerating common
 *  transcription artifacts. */
function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/[\s]+/g, ' ')
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
		.trim();
}

/** ADR-004 §3 + ADR-008 §3 — verdict_reason must contain a single-quoted
 *  phrase, AND that phrase must actually appear in an SME (user) turn from
 *  the transcript. */
const SINGLE_QUOTED_RE = /'([^']{4,})'/g;

export function verbatimAnchorOk(
	verdictReason: string | undefined | null,
	transcript: TranscriptTurn[],
): GateResult {
	const r = (verdictReason ?? '').trim();
	if (!r) {
		return {
			rule: 'verbatim-anchor:empty',
			pass: false,
			severity: 'high',
			field: 'verdict_reason',
			message: 'verdict_reason is empty.',
		};
	}
	const quotes = [...r.matchAll(SINGLE_QUOTED_RE)].map((m) => m[1]);
	if (quotes.length === 0) {
		return {
			rule: 'verbatim-anchor:no-quote',
			pass: false,
			severity: 'high',
			field: 'verdict_reason',
			message: 'verdict_reason has no single-quoted verbatim phrase. The contract requires at least one phrase the SME actually said, in single quotes.',
		};
	}
	// Build a corpus from SME (user) turns only — the agent's words don't count.
	const corpus = transcript
		.filter((t) => t.role === 'user')
		.map((t) => normalize(t.message))
		.join(' \n ');
	for (const quote of quotes) {
		const needle = normalize(quote);
		if (!needle) continue;
		if (corpus.includes(needle)) {
			return { rule: 'verbatim-anchor', pass: true, severity: 'high', field: 'verdict_reason', message: 'pass' };
		}
	}
	return {
		rule: 'verbatim-anchor:not-in-transcript',
		pass: false,
		severity: 'high',
		field: 'verdict_reason',
		message: `verdict_reason cites ${quotes.length} verbatim phrase${quotes.length === 1 ? '' : 's'} but none appear (normalized) in any SME turn. The 'his-authored' claim is structurally false.`,
	};
}

/** ADR-004 §1 + ADR-008 — Banned Lexicon scan. The five registers + their
 *  phrases. Each tuple is [category, regex]. The regex matches a substring
 *  of a brief-field string. Case-insensitive. */
const BANNED_LEXICON: Array<[string, RegExp]> = [
	// Compliance register
	['compliance', /\bensuring [^.,;]{0,40}(?:practices?|standards?)\b/i],
	['compliance', /\bcompliance with\b/i],
	['compliance', /\bregulatory\b/i],
	['compliance', /\balignment with\b/i],
	['compliance', /\bbest practices\b/i],
	['compliance', /\bgovernance\b/i],
	['compliance', /\bstakeholders?\b/i],
	// AI-spec register
	['ai-spec', /\bquantifying [a-z][^.,;]{0,40}\b/i],
	['ai-spec', /\bstructured data extraction\b/i],
	['ai-spec', /\bleveraging\b/i],
	['ai-spec', /\boptimizing\b/i],
	['ai-spec', /\benabling\b/i],
	['ai-spec', /\bfacilitating\b/i],
	['ai-spec', /\bautomating [a-z]+\b/i],
	// Vague-quantifier register
	['vague-quantifier', /\bsignificant\b/i],
	['vague-quantifier', /\bsubstantial\b/i],
	['vague-quantifier', /\bapproximately\b/i],
	['vague-quantifier', /\bmultiple\b/i],
	['vague-quantifier', /\bvarious\b/i],
	['vague-quantifier', /\ba number of\b/i],
	// Therapist register
	['therapist', /\bI hear you\b/i],
	['therapist', /\bthat sounds challenging\b/i],
	['therapist', /\blet's unpack that\b/i],
	['therapist', /\bwhat I'm hearing is\b/i],
	// Consultant register
	['consultant', /\blet's drill down\b/i],
	['consultant', /\blet's circle back\b/i],
	['consultant', /\bat the end of the day\b/i],
	['consultant', /\bfrom a strategic perspective\b/i],
	['consultant', /\bholistic\b/i],
];

/** Fields scanned for banned lexicon. Verbatim-anchor (single-quoted) and
 *  the verdict itself ("candidate" / "back-to-draft") are excluded — quotes
 *  are SME utterances and shouldn't be filtered, and the verdict is a
 *  closed vocabulary. */
const SCANNED_FIELDS: Array<keyof Brief> = [
	'title',
	'problem_statement',
	'roi_baseline',
	'roi_target',
	'scope_ai',
	'scope_human',
	'success_markers',
	'risks',
	'pull_out_trigger',
	'verdict_reason',
];

export function scanBannedLexicon(brief: Brief): GateResult[] {
	const findings: GateResult[] = [];
	for (const field of SCANNED_FIELDS) {
		const value = brief[field];
		if (typeof value !== 'string' || !value.trim()) continue;
		// For verdict_reason, strip the single-quoted SME phrases before scanning —
		// those are SME words and shouldn't be policed by the lexicon.
		const scannable = field === 'verdict_reason'
			? value.replace(SINGLE_QUOTED_RE, ' ')
			: value;
		for (const [category, re] of BANNED_LEXICON) {
			const m = re.exec(scannable);
			if (m) {
				findings.push({
					rule: `banned-lexicon:${category}`,
					pass: false,
					severity: 'medium',
					field,
					message: `${field} contains banned ${category}-register phrase: "${m[0]}". Per ADR-004 §1, the brief carries the SME's register, not the AI's.`,
				});
			}
		}
	}
	return findings;
}

export interface GateRunReport {
	pass: boolean;
	findings: GateResult[];
}

/** Run all gates against a brief + its source transcript.  Returns
 *  overall pass/fail + the list of findings (one entry per failed gate,
 *  one per banned-lexicon hit). Failed gates of severity 'high' force
 *  the overall pass to false; 'medium' findings are surfaced but don't
 *  alone reverse a verdict. */
export function runAllGates(brief: Brief, transcript: TranscriptTurn[]): GateRunReport {
	const findings: GateResult[] = [];

	const concrete = looksConcrete(brief.pull_out_trigger);
	if (!concrete.pass) findings.push(concrete);

	const anchor = verbatimAnchorOk(brief.verdict_reason, transcript);
	if (!anchor.pass) findings.push(anchor);

	const lexHits = scanBannedLexicon(brief);
	findings.push(...lexHits);

	const hasHighFailure = findings.some((f) => f.severity === 'high');
	return { pass: !hasHighFailure, findings };
}
