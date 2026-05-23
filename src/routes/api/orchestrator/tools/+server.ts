/**
 * GET /api/orchestrator/tools
 *
 * Returns the live tools manifest plus runtime stats (last-invoked
 * timestamp, recent-call count from the in-memory ring buffer).
 * Powers `/orchestrator/tools`.
 *
 * Two manifest entries are enriched with their downstream live registry
 * data so the page closes the loop without extra fetches:
 *   - invokeSkill   → live_skills[] from listChatSkills()
 *   - dispatchAgent → live_agents[] filtered to chat_dispatchable + ready
 *
 * Read-only. No POST/PUT/DELETE today — tools are always-on (per
 * ADR-015 Phase A). Phase B will add a per-tool overlay when there's
 * a real need to disable individual tools at runtime.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listTools, listRecentToolCalls } from '$lib/orchestrator-v2/tools/registry.js';
import { getLatencyStats } from '$lib/orchestrator-v2/tools/latency-tracker.js';
import { listChatSkills } from '$lib/skills/index.js';
import { listAgents } from '$lib/agents/store.js';

export const GET: RequestHandler = async () => {
	const baseTools = listTools();

	const liveSkills = listChatSkills().map((s) => ({
		name: s.name,
		description: s.chat_description,
	}));

	const agentResult = listAgents();
	const liveAgents = agentResult.agents
		.filter((a) => a.chat_dispatchable && a.health === 'ready')
		.map((a) => ({
			id: a.id,
			description: a.description,
		}));

	const tools = baseTools.map((t) => {
		// ADR-030 v2 — surface the rolling latency stats + auto-class
		// suggestion alongside the manifest's explicit class. The page
		// renders a small badge per tool and a "→ suggest slow (p95
		// 8.2s)" hint when the suggestion disagrees with the manifest.
		const stats = getLatencyStats(t.name);
		const explicitClass = t.latencyClass ?? 'auto';
		const enriched = {
			...t,
			latency: {
				explicit_class: explicitClass,
				samples: stats.samples,
				p95_ms: stats.p95Ms,
				suggested_class: stats.suggestedClass,
				suggestion_disagrees:
					stats.suggestedClass !== null && stats.suggestedClass !== explicitClass,
			},
		};
		if (enriched.name === 'invokeSkill') return { ...enriched, live_skills: liveSkills };
		if (enriched.name === 'dispatchAgent') return { ...enriched, live_agents: liveAgents };
		return enriched;
	});

	return json({
		tools,
		recent_calls: listRecentToolCalls(20),
		count: tools.length,
	});
};
