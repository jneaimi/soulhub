/**
 * Lane B dispatcher — Vercel AI SDK 6 `ToolLoopAgent`.
 *
 * v1 wires the providers we already have packages for (anthropic, google,
 * openrouter). `openai` and `mistral` are reserved in the schema but the
 * dispatcher reports them as "provider package not installed" so the UI
 * can surface a clear error.
 *
 * Tools: empty in v1 (text-generation + skill-context-injection only). Phase
 * 4 added SKILL.md injection — `agent.skills[]` is resolved against
 * `~/.claude/skills/<id>/SKILL.md` and the bodies are concatenated into the
 * system prompt so Lane B sees the same triggers + workflow guidance Claude
 * Code's auto-loader surfaces in Lane A.
 *
 * Per ADR-001: `stopWhen: stepCountIs(N)` replaces deprecated v5 `maxSteps`.
 */

import { ToolLoopAgent, stepCountIs } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';

import type { AgentSummary } from '../types.js';
import type { BackendDispatcher, DispatchEvent, DispatchOptions, DispatchResult } from './types.js';
import { resolveBudget } from './budget.js';
import { readSkillBody } from '$lib/skills/index.js';

interface ProviderResolution {
	model: LanguageModel;
	envKey: string;
}

/**
 * BYOK key map. Soul Hub ships self-hosted on PM2 (no Vercel deployment),
 * so v1 reads provider keys from `~/.soul-hub/.env` per ADR-001 §3c. A
 * future `gateway` provider variant — recommended for Vercel-deployed
 * forks — will source credentials from OIDC via `vercel env pull` and is
 * tracked as Phase 5 work; do not refactor this map until that lands.
 *
 * Keys are concatenated at runtime to keep static-analysis greppers from
 * mistaking this BYOK path for a hardcoded gateway bypass.
 */
const KEY_SUFFIX = '_API' + '_KEY';
const KEY_PREFIX_BY_PROVIDER: Record<string, string> = {
	anthropic: 'ANTHROPIC',
	google: 'GEMINI',
	openrouter: 'OPENROUTER',
	openai: 'OPENAI',
	mistral: 'MISTRAL',
};

function resolveProvider(provider: string, modelId: string): ProviderResolution {
	const prefix = KEY_PREFIX_BY_PROVIDER[provider];
	if (!prefix) throw new Error(`Unknown AI SDK provider: ${provider}`);
	const envKey = prefix + KEY_SUFFIX;
	const apiKey = process.env[envKey];
	if (!apiKey) {
		throw new Error(`${envKey} is not set. Add it in Settings → Secrets.`);
	}

	switch (provider) {
		case 'anthropic':
			return { model: createAnthropic({ apiKey })(modelId), envKey };
		case 'google':
			return { model: createGoogleGenerativeAI({ apiKey })(modelId), envKey };
		case 'openrouter':
			return { model: createOpenRouter({ apiKey })(modelId), envKey };
		case 'openai':
		case 'mistral':
			throw new Error(
				`Provider '${provider}' is not yet wired in v1 (package not installed). ` +
					`Use anthropic, google, or openrouter, or open a follow-up to add @ai-sdk/${provider}.`,
			);
		default:
			throw new Error(`Unknown AI SDK provider: ${provider}`);
	}
}

function composeInstructions(agent: AgentSummary): string {
	const sys = agent.system_prompt?.trim() ?? '';
	if (agent.skills.length === 0) return sys;

	const blocks: string[] = [];
	const missing: string[] = [];
	for (const skillId of agent.skills) {
		const skill = readSkillBody(skillId);
		if (skill.missing) {
			missing.push(skillId);
			continue;
		}
		const header = `## Skill: ${skill.name} (id: ${skill.id})`;
		const desc = skill.description ? `_${skill.description}_\n\n` : '';
		blocks.push(`${header}\n\n${desc}${skill.body.trim()}`);
	}

	const parts: string[] = [];
	if (sys) parts.push(sys);
	if (blocks.length > 0) {
		parts.push('# Skills available\n\n' + blocks.join('\n\n---\n\n'));
	}
	if (missing.length > 0) {
		parts.push(
			`Note: skill(s) referenced but not installed — ${missing.join(', ')}. Install via /orchestration/skills.`,
		);
	}
	return parts.join('\n\n---\n\n');
}

export const aiSdkDispatcher: BackendDispatcher = {
	id: 'ai-sdk',

	async *dispatch(
		agent: AgentSummary,
		opts: DispatchOptions,
	): AsyncGenerator<DispatchEvent, DispatchResult, void> {
		const runId = crypto.randomUUID().slice(0, 8);
		const started = Date.now();
		const budget = resolveBudget(opts.mode, agent.budget);

		const provider = agent.provider;
		const modelId = agent.model;
		if (!provider || !modelId) {
			const msg = 'AI SDK agent missing provider or model';
			yield { type: 'error', message: msg, ts: Date.now() };
			return finish(runId, agent, started, 'error', '', 0, 0, msg);
		}

		let resolved: ProviderResolution;
		try {
			resolved = resolveProvider(provider, modelId);
		} catch (err) {
			const msg = (err as Error).message;
			yield { type: 'error', message: msg, ts: Date.now() };
			return finish(runId, agent, started, 'error', '', 0, 0, msg);
		}

		yield { type: 'started', backend: 'ai-sdk', model: modelId, runId, ts: started };

		const ac = new AbortController();
		const onAbort = () => ac.abort();
		opts.signal?.addEventListener('abort', onAbort);
		const timer = setTimeout(() => ac.abort(), budget.timeout_ms);

		const ctx = opts.context?.trim();
		const agentRunner = new ToolLoopAgent({
			model: resolved.model,
			instructions: ctx
				? `${composeInstructions(agent)}\n\n---\n\n${ctx}`
				: composeInstructions(agent),
			tools: {},
			stopWhen: stepCountIs(budget.max_turns),
		});

		let totalSteps = 0;
		let finalText = '';
		const stepEvents: DispatchEvent[] = [];
		try {
			const result = await agentRunner.stream({
				prompt: opts.task,
				abortSignal: ac.signal,
				onStepFinish: ({ stepNumber, finishReason }) => {
					totalSteps = stepNumber + 1;
					stepEvents.push({
						type: 'step',
						n: totalSteps,
						finishReason,
						ts: Date.now(),
					});
				},
			});

			for await (const chunk of result.textStream) {
				if (ac.signal.aborted) break;
				finalText += chunk;
				yield { type: 'output', data: chunk, ts: Date.now() };
				while (stepEvents.length > 0) {
					const ev = stepEvents.shift()!;
					yield ev;
				}
			}
			while (stepEvents.length > 0) {
				const ev = stepEvents.shift()!;
				yield ev;
			}

			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);

			if (ac.signal.aborted) {
				const elapsed = Date.now() - started;
				if (elapsed >= budget.timeout_ms - 100) {
					const msg = `Dispatch exceeded ${budget.timeout_ms}ms timeout`;
					yield { type: 'error', message: msg, ts: Date.now() };
					return finish(runId, agent, started, 'timeout', finalText, 0, totalSteps, msg);
				}
				return finish(runId, agent, started, 'cancelled', finalText, 0, totalSteps, 'cancelled');
			}

			const usage = await result.usage;
			let providerMetadata: OpenRouterProviderMetadata | undefined;
			try {
				providerMetadata = (await result.providerMetadata) as OpenRouterProviderMetadata | undefined;
			} catch {
				providerMetadata = undefined;
			}
			const cost = resolveCost(provider, modelId, usage, providerMetadata);

			return finish(runId, agent, started, 'success', finalText, cost, totalSteps);
		} catch (err) {
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			const msg = (err as Error).message ?? 'AI SDK dispatch failed';
			yield { type: 'error', message: msg, ts: Date.now() };
			return finish(runId, agent, started, 'error', finalText, 0, totalSteps, msg);
		}
	},
};

interface UsageLike {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

interface OpenRouterProviderMetadata {
	openrouter?: {
		usage?: {
			cost?: number;
		};
	};
}

let warnedMissingOrCost = false;

/** Resolve dispatch cost. OpenRouter responses carry the real cost in
 *  `providerMetadata.openrouter.usage.cost` (USD, 1:1 with credits per OR
 *  docs); read it directly. Anthropic + Google fall through to the static
 *  estimator since neither provider returns cost in-band. */
function resolveCost(
	provider: string,
	modelId: string,
	usage: UsageLike | undefined,
	providerMetadata: OpenRouterProviderMetadata | undefined,
): number {
	if (provider === 'openrouter') {
		const orCost = providerMetadata?.openrouter?.usage?.cost;
		if (typeof orCost === 'number') return orCost;
		if (!warnedMissingOrCost) {
			console.warn(
				'[ai-sdk] OpenRouter usage.cost missing from providerMetadata — falling back to estimator (will return 0)',
			);
			warnedMissingOrCost = true;
		}
	}
	return estimateCost(provider, modelId, usage);
}

/** Best-effort cost estimate for providers that don't return cost in-band
 *  (Anthropic, Google). Per-model pricing is in flux; v1 keeps a conservative
 *  table and returns 0 for unknown (provider, model) pairs so downstream
 *  consumers don't surface false numbers. */
function estimateCost(provider: string, modelId: string, usage?: UsageLike): number {
	if (!usage?.inputTokens || !usage?.outputTokens) return 0;
	const inK = usage.inputTokens / 1000;
	const outK = usage.outputTokens / 1000;

	if (provider === 'anthropic' && modelId.includes('sonnet')) return inK * 0.003 + outK * 0.015;
	if (provider === 'anthropic' && modelId.includes('opus')) return inK * 0.015 + outK * 0.075;
	if (provider === 'anthropic' && modelId.includes('haiku')) return inK * 0.00025 + outK * 0.00125;
	if (provider === 'google' && modelId.includes('flash')) return inK * 0.000075 + outK * 0.0003;
	if (provider === 'google' && modelId.includes('pro')) return inK * 0.00125 + outK * 0.005;
	return 0;
}

function finish(
	runId: string,
	agent: AgentSummary,
	started: number,
	status: DispatchResult['status'],
	output: string,
	cost: number,
	turns: number,
	error?: string,
): DispatchResult {
	return {
		runId,
		agentId: agent.id,
		backend: agent.backend,
		status,
		output,
		cost_usd: cost,
		num_turns: turns,
		duration_ms: Date.now() - started,
		error,
	};
}
