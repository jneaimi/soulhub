/**
 * Public registry surface for orchestrator-v2 tools (ADR-015).
 *
 * `listTools()` returns the manifest list with any runtime-derived
 * fields layered on (last-invoked timestamp, recent-call count). The
 * runtime fields are kept in a small in-memory ring buffer fed by
 * `recordToolCall()` from the tool factory's logToolCall path —
 * persistence to a `tool_invocations` table is deferred to Phase B.
 */

import {
	TOOL_MANIFESTS,
	getToolManifest,
	CATEGORY_ORDER,
	CATEGORY_LABEL,
	type ToolCategory,
	type ToolManifest,
} from './manifest.js';

export type { ToolManifest, ToolCategory } from './manifest.js';
export { getToolManifest, CATEGORY_ORDER, CATEGORY_LABEL };

/** Ring buffer of recent tool invocations. Newest first. Bounded to
 *  keep memory predictable across long-lived PM2 processes. Restart-loss
 *  is acceptable — this is observability, not audit. */
interface RecentCallEntry {
	name: string;
	at: number; // epoch ms
	argPreview: string;
}

const RECENT_BUFFER_MAX = 50;
const recentCalls: RecentCallEntry[] = [];

export function recordToolCall(name: string, argPreview: string): void {
	recentCalls.unshift({ name, at: Date.now(), argPreview });
	if (recentCalls.length > RECENT_BUFFER_MAX) {
		recentCalls.length = RECENT_BUFFER_MAX;
	}
}

/** Per-tool runtime stats derived from the in-memory buffer. */
export interface ToolRuntime {
	last_invoked_at?: number;
	recent_calls: number; // count within RECENT_BUFFER_MAX window
}

export function getToolRuntime(name: string): ToolRuntime {
	let last: number | undefined;
	let count = 0;
	for (const c of recentCalls) {
		if (c.name === name) {
			if (last === undefined) last = c.at;
			count += 1;
		}
	}
	return { last_invoked_at: last, recent_calls: count };
}

/** Public listing — manifest + runtime, in canonical category order. */
export interface ToolListing extends ToolManifest, ToolRuntime {}

export function listTools(): ToolListing[] {
	const out: ToolListing[] = [];
	const byCat = new Map<ToolCategory, ToolManifest[]>();
	for (const m of TOOL_MANIFESTS) {
		if (!byCat.has(m.category)) byCat.set(m.category, []);
		byCat.get(m.category)!.push(m);
	}
	for (const cat of CATEGORY_ORDER) {
		const list = byCat.get(cat) ?? [];
		list.sort((a, b) => a.name.localeCompare(b.name));
		for (const m of list) {
			out.push({ ...m, ...getToolRuntime(m.name) });
		}
	}
	return out;
}

/** Latest N invocations across all tools, newest first. */
export function listRecentToolCalls(limit = 20): RecentCallEntry[] {
	return recentCalls.slice(0, Math.max(0, Math.min(limit, RECENT_BUFFER_MAX)));
}

/** Drift assertion. Called once on first orchestrator dispatch. Warns
 *  (does not throw) when the live tool factory keys diverge from the
 *  manifest list — V1 trust model is "developer notices the warning
 *  and updates whichever side is wrong." */
let parityChecked = false;
export function assertManifestParity(toolKeys: readonly string[]): void {
	if (parityChecked) return;
	parityChecked = true;
	const manifestNames = new Set(TOOL_MANIFESTS.map((m) => m.name));
	const liveNames = new Set(toolKeys);
	const missingFromManifest = [...liveNames].filter((k) => !manifestNames.has(k));
	const missingFromLive = [...manifestNames].filter((k) => !liveNames.has(k));
	if (missingFromManifest.length > 0) {
		console.warn(
			`[orchestrator-v2] tools manifest drift: live tool(s) without manifest entries: ${missingFromManifest.join(', ')}`,
		);
	}
	if (missingFromLive.length > 0) {
		console.warn(
			`[orchestrator-v2] tools manifest drift: manifest entries without live tools: ${missingFromLive.join(', ')}`,
		);
	}
}
