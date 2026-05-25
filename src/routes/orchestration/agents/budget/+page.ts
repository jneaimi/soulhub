import type { PageLoad } from './$types';

export interface Approval {
	runId: string;
	agentId: string;
	spentUsd: number;
	turns: number;
	ceilingUsd: number | null;
	ceilingTurns: number | null;
	reason: 'max_usd' | 'max_turns' | null;
	softUsd: number | null;
	errorMessage: string | null;
	ttlMs: number;
	actionable: boolean;
	bumps: { addUsd: number[]; addTurns: number[] };
}

/** ADR-007 — initial server-side load of the paused-run list. The page polls
 *  the same endpoint every 30s client-side to stay live. */
export const load: PageLoad = async ({ fetch }) => {
	try {
		const res = await fetch('/api/agents/budget-approvals');
		if (!res.ok) {
			const j = await res.json().catch(() => ({}));
			return { approvals: [] as Approval[], error: j.error ?? `HTTP ${res.status}` };
		}
		const data = await res.json();
		return { approvals: (data.approvals ?? []) as Approval[], error: '' };
	} catch (e) {
		return { approvals: [] as Approval[], error: e instanceof Error ? e.message : 'Failed to load' };
	}
};
