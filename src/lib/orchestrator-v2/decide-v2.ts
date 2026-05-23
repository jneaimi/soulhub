/**
 * Tool-using orchestrator (ADR-009) — main entry point.
 *
 * Phase 1: built an `Agent` with the 6 tool stubs and ran the tool-use loop,
 * mapping the tool calls back to v1's `OrchestratorDecision` shape so the
 * inbound handler stayed unchanged.
 *
 * Phase 2: wires real handlers (web-search / vault-chat / image gen /
 * proposal write) inside the tool `execute()` bodies. After the agent
 * loop, `decideV2` walks `result.steps` and assembles a `V2Output` —
 * the inbound handler short-circuits on this so it doesn't re-dispatch
 * the side effect (e.g. doesn't run `dispatchWebSearch` a second time).
 *
 * Default model: `anthropic/claude-sonnet-4.6` via OpenRouter (preserves
 * Anthropic prompt caching when provider order is pinned, per saved
 * `feedback_soul_hub_sdk_choices` memory). Override via env
 * `ORCHESTRATOR_V2_MODEL`. Phase 5 introduces round-robin across
 * GLM-4.6 / Sonnet 4.6 / MiniMax M2.7 with a sticky-per-conversationKey
 * branch assignment.
 */

import { ToolLoopAgent, stepCountIs, NoOutputGeneratedError, type StopCondition, type ToolSet } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import { listAgents } from '../agents/store.js';
import { listChatSkills } from '../skills/index.js';
import { setPending, formatProposal } from '../orchestrator/pending-proposals.js';
import { buildOrchestratorTools, type ToolResult } from './tools/index.js';
import { buildOrchestratorSystemPrompt } from './system-prompt.js';
import { pickBranchForKey } from './branches.js';
import { getPersonaBundle, type PersonaBundle } from '../persona/loader.js';
import { config } from '../config.js';
import {
	priceTurn,
	recordTurnCost,
	isBranchOverBudget,
	BRANCH_COST_CAP_USD,
} from './branch-costs.js';
import { notifyBudgetExceeded } from './alerts.js';
import type {
	DecideResult,
	DecideV2Options,
	DecideV2Telemetry,
	OrchestratorDecision,
	OrchestratorStreamEvent,
	V2Output,
} from './types.js';

/** Legacy fixed-model override — when set, bypasses A/B branch selection
 *  entirely. Used by tests / one-off debugging. The 14-day live A/B reads
 *  the branch from `pickBranchForKey()` instead. */
const FIXED_MODEL_OVERRIDE = process.env.ORCHESTRATOR_V2_MODEL;
// 5 was too tight for V4 Pro: it iterates more aggressively than GLM-4.6
// on retrieval — one mis-routed tool call + 3-4 vaultSearches exhausts
// the budget mid-composition, shipping a half-sentence to the user.
// 8 keeps p95 latency reasonable (~80s worst case) while giving the
// model room to recover from a bad first step.
const MAX_STEPS = 8;

/** ADR-030 v2 — stop the agent loop the moment a slow tool dispatches.
 *
 *  Without this, the model sees `{kind:'slow-dispatched',ack:'🟡 …'}` as a
 *  tool result, can't tell that the actual work is now running in a
 *  background worker, and retries the same tool — observed live 2026-05-13
 *  on a TikTok turn where the model fired tiktokFetch three times in a
 *  row (each kicking off its own worker that delivered the formatted
 *  result to the user — triple bubble), then ran out of steps before
 *  ever calling vaultSave.
 *
 *  Firing this condition at the end of any step whose toolResults include
 *  a `slow-dispatched` output ends the loop cleanly. The model never
 *  composes a final text in that branch; buildV2Output finds the
 *  slow-dispatched marker in the resolved steps and returns the ack so
 *  the channel handler can morph the presence bubble. */
const hasSlowDispatched: StopCondition<ToolSet> = ({ steps }) => {
	const last = steps[steps.length - 1];
	if (!last) return false;
	for (const tr of last.toolResults ?? []) {
		const output = (tr as { output?: unknown }).output;
		if (
			output &&
			typeof output === 'object' &&
			'kind' in output &&
			(output as { kind?: string }).kind === 'slow-dispatched'
		) {
			return true;
		}
	}
	return false;
};
// 100s — must accommodate the slowest tool, which is `youtubeFetch` Tier B
// (Gemini multimodal video ingestion, 15-90s depending on length). The
// previous 25s aborted youtube turns mid-Gemini-call and surfaced a generic
// "I'm not sure what you want" reply instead of the summary.
//
// Per-tool internal timeouts (e.g. gemini.ts at 90s) must stay strictly
// LESS than this so the tool fails first with a graceful degrade rather
// than the orchestrator's nuclear abort. The ~10s buffer lets the model
// wrap a final reply after the tool returns or fails.
const TIMEOUT_MS = 100_000;

/** Public surface — same name semantics as v1's `decide()` so the inbound
 *  handler can env-flag swap. Returns the same `DecideResult` shape plus
 *  optional `v2Output` when tools produced ready-to-send payloads. */
export async function decideV2(
	userMessage: string,
	opts: DecideV2Options = {},
): Promise<DecideResult & { telemetry?: DecideV2Telemetry; v2Output?: V2Output }> {
	const startedAt = Date.now();

	const apiKey = process.env.OPENROUTER_API_KEY;

	// ADR-009 Phase 5 — pick the A/B branch for this conversation. Sticky
	// per `conversationKey`; new keys land on the least-loaded branch.
	// `ORCHESTRATOR_V2_MODEL` (legacy) fully overrides; if unset, the env
	// `ORCHESTRATOR_V2_BRANCH_OVERRIDE` (Phase 5) forces a specific branch.
	const branchKey = opts.conversationKey ?? '__no_key__';
	const branch = FIXED_MODEL_OVERRIDE
		? { name: 'fixed-override', model: FIXED_MODEL_OVERRIDE }
		: pickBranchForKey(branchKey);
	const modelId = branch.model;

	if (!apiKey) {
		return abstain(
			'OPENROUTER_API_KEY not set — orchestrator-v2 cannot run',
			startedAt,
			modelId,
			branch.name,
		);
	}

	// Build dynamic enums from current state — agents from `listAgents()`,
	// skills from the overlay registry (Phase 4d).
	const agentList = listAgents();
	const dispatchableAgentIds = agentList.agents
		.filter((a) => a.chat_dispatchable && a.health === 'ready')
		.map((a) => a.id);

	if (dispatchableAgentIds.length === 0) {
		return abstain('no chat-dispatchable agents in registry', startedAt, modelId, branch.name);
	}

	const dispatchableAgents = agentList.agents
		.filter((a) => a.chat_dispatchable && a.health === 'ready')
		.map((a) => ({ id: a.id, description: a.description }));

	// ADR-053 P3 v1 — deterministic deep-work routing. Before spending an LLM
	// turn, check for an explicit "deep review / analyze / profile / due-diligence
	// on <Entity>" intent and route it straight to an analyst PROPOSAL (behind the
	// confirm gate — analyst runs cost minutes + ~$0.65). This replaces the
	// non-deterministic inline-web-vs-agent coin-flip for the clear case; anything
	// ambiguous (no clear entity, no conversationKey, analyst not ready) falls
	// through to the LLM path below, unchanged.
	const deepWork =
		opts.conversationKey && dispatchableAgentIds.includes('analyst')
			? detectDeepWorkRoute(userMessage)
			: null;
	if (deepWork && opts.conversationKey) {
		const label = `Deep-dive: ${deepWork.entity}`.slice(0, 80);
		const task = (
			`Profile and deep-review ${deepWork.entity}: competitive intelligence, ` +
			`positioning, and the implications for a GCC operator. ` +
			`Original request: "${userMessage}".`
		).slice(0, 800);
		const proposal = setPending({
			conversationKey: opts.conversationKey,
			agentId: 'analyst',
			task,
			label,
			origin: 'natural',
			modelBranch: branch.name,
		});
		const proposalResult: ToolResult = {
			kind: 'proposal',
			text: formatProposal(proposal),
			agentId: 'analyst',
			task,
			label,
		};
		const detToolCall = {
			name: 'dispatchAgent',
			argSummary: JSON.stringify({
				agentId: 'analyst',
				task,
				proposalLabel: label,
				confirmed: false,
			}),
		};
		return {
			decision: mapToolCallsToDecision([detToolCall], ''),
			fellThrough: false,
			note: `[v2 ${branch.name}] deterministic deep-work route → analyst proposal (entity="${deepWork.entity}")`,
			telemetry: {
				model: modelId,
				modelBranch: branch.name,
				stepsUsed: 0,
				toolCalls: [detToolCall],
				durationMs: Date.now() - startedAt,
			},
			v2Output: buildV2Output([proposalResult], '', [], 0),
		};
	}

	// Phase 4d — chat-invokable skills come from the overlay registry.
	const chatSkills = listChatSkills();
	const invokableSkills = chatSkills.map((s) => ({
		name: s.name,
		description: s.chat_description.replace(/\s+/g, ' ').trim(),
	}));

	// Widen to the SDK's ToolSet so the agent infers a uniform tool set: keeps
	// StepResult/StopCondition generics consistent (a precise per-tool object
	// type makes `stopWhen` and `result.steps` mismatch on NoInfer<…>).
	const tools: ToolSet = buildOrchestratorTools({
		conversationKey: opts.conversationKey,
		senderNumber: opts.senderNumber,
		dispatchableAgentIds,
		chatSkills,
		imgConfig: opts.imgConfig,
		youtubeConfig: opts.youtubeConfig,
		tiktokConfig: opts.tiktokConfig,
		channel: opts.channel,
		remindersConfig: opts.remindersConfig,
		heartbeatConfig: opts.heartbeatConfig,
		account: opts.account,
		timezone: opts.timezone,
		modelBranch: branch.name,
		slowDispatch: opts.slowDispatch,
	});

	// ADR-033 Layer 1 — load the persona bundle from the vault. The kill
	// switch (`config.chat.persona.enabled`) flips the chat back to the
	// pre-ADR-033 prompt without a code change. When the engine isn't
	// initialised the loader returns empty strings (`hasContent: false`)
	// and the system-prompt builder falls back to the routing-only stub.
	const personaBundle: PersonaBundle | undefined = config.chat?.persona?.enabled
		? getPersonaBundle({
				soul: config.chat.persona.soulPath,
				userProfile: config.chat.persona.userProfilePath,
				boundaries: config.chat.persona.boundariesPath,
				identity: config.chat.persona.identityPath,
			})
		: undefined;

	const system = buildOrchestratorSystemPrompt({
		dispatchableAgents,
		invokableSkills,
		userTimezone: opts.timezone,
		personaBundle,
	});

	const openrouter = createOpenRouter({ apiKey });
	// ADR-028 Phase 4d — `provider.sort: 'latency'` asks OpenRouter to route
	// to whichever upstream (Anthropic, Vertex, Zhipu, etc.) currently has
	// the lowest measured TTFT for this model. Trades reproducibility (the
	// same modelId can land on different upstreams turn-to-turn) for tail
	// latency — acceptable on the chat path where a 2-3s saving beats
	// strict upstream pinning. Caching paths that need a fixed provider
	// should pass `provider.order` instead.
	const model = openrouter(modelId, { provider: { sort: 'latency' } });

	const ac = new AbortController();
	const onAbort = () => ac.abort();
	opts.signal?.addEventListener('abort', onAbort);
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

	const agent = new ToolLoopAgent({
		model,
		instructions: system,
		tools,
		stopWhen: [stepCountIs(MAX_STEPS), hasSlowDispatched],
	});

	const messages = [
		...(opts.history ?? []).map((m) => ({ role: m.role, content: m.content })),
		{ role: 'user' as const, content: userMessage },
	];

	const toolCalls: { name: string; argSummary: string }[] = [];
	const toolResults: ToolResult[] = [];
	const toolErrors: ToolError[] = [];
	let finalText = '';
	let stepsUsed = 0;
	let inputTokens: number | undefined;
	let outputTokens: number | undefined;
	let llmNote: string | undefined;

	try {
		// ADR-029 — switched from `agent.generate()` to `agent.stream()` so we
		// can emit `tool-call-start` / `tool-result` events to the channel's
		// presence layer during a long-running turn. The result shape is the
		// same (steps/text/usage are PromiseLike on StreamTextResult), so the
		// downstream walking logic below stays identical.
		const result = await agent.stream({
			messages,
			abortSignal: ac.signal,
		});

		// Drain fullStream first — emitting events as we go. Awaiting the
		// promised fields below (text/steps/usage) auto-consumes the stream
		// internally, but iterating `fullStream` explicitly is the supported
		// way to observe per-event transitions. We filter to user-meaningful
		// types only; text-delta/tool-input-delta would blow the edit budget.
		const emitEvent = (event: OrchestratorStreamEvent) => {
			if (!opts.onStreamEvent) return;
			try {
				opts.onStreamEvent(event);
			} catch (err) {
				console.warn(
					`[orchestrator-v2] onStreamEvent threw (${(err as Error).message}); continuing`,
				);
			}
		};
		const seenToolStarts = new Set<string>(); // dedup tool-input-start by id
		for await (const part of result.fullStream) {
			if (part.type === 'tool-input-start') {
				// `id` is the AI SDK's per-call id — guards against double-fire
				// when streaming variants emit start twice for the same call.
				if (seenToolStarts.has(part.id)) continue;
				seenToolStarts.add(part.id);
				emitEvent({ kind: 'tool-call-start', toolName: part.toolName });
			} else if (part.type === 'tool-result') {
				emitEvent({
					kind: 'tool-result',
					toolName: part.toolName,
					ok: true,
				});
			} else if (part.type === 'tool-error') {
				emitEvent({
					kind: 'tool-result',
					toolName: part.toolName ?? 'unknown',
					ok: false,
				});
			}
		}

		finalText = (await result.text) ?? '';
		const resolvedSteps = await result.steps;
		stepsUsed = resolvedSteps?.length ?? 0;
		const usage = await result.usage;
		inputTokens = usage?.inputTokens;
		outputTokens = usage?.outputTokens;

		for (const step of resolvedSteps ?? []) {
			for (const call of step.toolCalls ?? []) {
				toolCalls.push({
					name: call.toolName,
					argSummary: summariseArgs(call.input),
				});
			}
			for (const tr of step.toolResults ?? []) {
				const output = (tr as { output?: unknown }).output;
				if (output && typeof output === 'object' && 'kind' in (output as Record<string, unknown>)) {
					toolResults.push(output as ToolResult);
				}
			}
			// AI SDK v6 surfaces Zod-validation failures + execute() throws as
			// `tool-error` parts in `step.content` — they do NOT appear in
			// `step.toolResults`. Without this loop the orchestrator silently
			// drops the failure, falls through to an empty `finalText`, and
			// sends a 1-char reply (the bug observed 2026-05-06 23:32 — model
			// emitted dispatchAgent with a too-short task; old `min(20)` zod
			// rule rejected; user got "." back).
			for (const part of step.content ?? []) {
				const p = part as {
					type?: string;
					toolName?: string;
					error?: unknown;
					input?: unknown;
				};
				if (p.type === 'tool-error') {
					const errMsg =
						p.error instanceof Error
							? p.error.message
							: typeof p.error === 'string'
								? p.error
								: JSON.stringify(p.error);
					toolErrors.push({
						toolName: p.toolName ?? 'unknown',
						error: errMsg,
						input: p.input,
					});
					console.warn(
						`[orchestrator-v2] tool-error tool=${p.toolName ?? 'unknown'} input=${JSON.stringify(p.input ?? {}).slice(0, 500)} err=${errMsg.slice(0, 500)}`,
					);
				}
			}
		}
	} catch (err) {
		llmNote =
			err instanceof NoOutputGeneratedError
				? 'NoOutputGeneratedError — model produced no output'
				: `agent.generate failed: ${(err as Error).message}`;
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener('abort', onAbort);
	}

	// ADR-009 Phase 6 — record per-turn cost. Skip the legacy
	// `fixed-override` branch (no pricing data) and any turn where token
	// usage didn't come back from OpenRouter.
	const costUsd =
		inputTokens !== undefined && outputTokens !== undefined
			? priceTurn(branch.name, inputTokens, outputTokens)
			: 0;
	if (costUsd > 0) {
		try {
			recordTurnCost({
				branchName: branch.name,
				ymd: new Date().toISOString().slice(0, 10),
				inputTokens: inputTokens ?? 0,
				outputTokens: outputTokens ?? 0,
				costUsd,
			});
			// Fire the budget alert the first time the running total crosses
			// the cap. `isBranchOverBudget` checks the persisted aggregate
			// (not just this turn) so a single big turn that pushes the
			// running total past the cap correctly triggers.
			if (isBranchOverBudget(branch.name)) {
				// Don't await — telegram should never block chat reply.
				void notifyBudgetExceeded({
					branchName: branch.name,
					costUsd,
					capUsd: BRANCH_COST_CAP_USD,
				});
			}
		} catch (err) {
			console.warn(
				`[orchestrator-v2] recordTurnCost failed: ${(err as Error).message}`,
			);
		}
	}

	const telemetry: DecideV2Telemetry = {
		model: modelId,
		modelBranch: branch.name,
		stepsUsed,
		toolCalls,
		inputTokens,
		outputTokens,
		costUsd: costUsd > 0 ? costUsd : undefined,
		durationMs: Date.now() - startedAt,
		personaBundleHash: personaBundle?.hasContent ? personaBundle.hash : undefined,
	};

	if (llmNote) {
		return {
			decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: 0 },
			fellThrough: true,
			note: llmNote,
			telemetry,
		};
	}

	const v2Output = buildV2Output(toolResults, finalText, toolErrors, stepsUsed);
	const decision = mapToolCallsToDecision(toolCalls, finalText);
	return {
		decision,
		fellThrough: false,
		note: `[v2 ${branch.name}/${modelId}] steps=${stepsUsed} tools=${toolCalls.map((t) => t.name).join(',') || 'none'}${toolErrors.length > 0 ? ` toolErrors=${toolErrors.length}` : ''}`,
		telemetry,
		v2Output,
	};
}

/** Captured shape of a tool-error part from `step.content` — the AI SDK
 *  surfaces Zod-validation failures + `execute()` throws here, not in
 *  `step.toolResults`. */
interface ToolError {
	toolName: string;
	error: string;
	input: unknown;
}

const ABSTAIN_REPLY = "I'm not sure what you want me to do — can you rephrase?";

function abstain(
	note: string,
	startedAt: number,
	model: string,
	modelBranch: string,
): DecideResult & {
	telemetry: DecideV2Telemetry;
} {
	return {
		decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: 0 },
		fellThrough: true,
		note,
		telemetry: {
			model,
			modelBranch,
			stepsUsed: 0,
			toolCalls: [],
			durationMs: Date.now() - startedAt,
		},
	};
}

function summariseArgs(input: unknown): string {
	try {
		const s = typeof input === 'string' ? input : JSON.stringify(input);
		// 500 chars (was 100). 100 truncated past `task` and lost `confirmed`,
		// breaking dispatchAgent action-mapping when the model emitted a long
		// task before the boolean. 500 keeps the full args for any realistic
		// tool call (max task is 800 chars but most are <500).
		return s.length > 500 ? s.slice(0, 500) + '…' : s;
	} catch {
		return String(input);
	}
}

/** Treat a finalText shorter than this as "model said nothing meaningful"
 *  — surface a graceful error instead of forwarding `.` or whitespace to
 *  the user. 8 chars covers obvious junk while keeping legit short replies
 *  ("Yes!", "Got it", "👍 noted"). */
const MIN_USEFUL_FINAL_TEXT = 8;

/** Walk the tool results in order and produce the ready-to-send payload
 *  for the inbound handler. Priority order: dispatch > image > proposal
 *  > errors > text. Dispatch wins because the user explicitly confirmed
 *  a heavy run; image wins next because the file already exists on disk;
 *  proposal next because the DB row is committed.
 *
 *  `toolErrors` (Zod-validation failures + `execute()` throws) drive a
 *  fallback when there is no useful result + no useful finalText, so the
 *  user sees a helpful clarification instead of the model's empty output. */
function buildV2Output(
	results: readonly ToolResult[],
	finalText: string,
	toolErrors: readonly ToolError[],
	stepsUsed: number,
): V2Output | undefined {
	const trimmedFinal = finalText.trim();
	// When the agent loop hits the step cap mid-composition the model
	// often returns a coherent-looking prefix that ends mid-word (e.g.
	// "…items (those with the"). Treating that as the wrap-up ships a
	// fragment to the user. Detect by: (a) we burned the whole step
	// budget AND (b) the last char isn't a sentence terminator. In that
	// case fall through to the tool's verbatim text below.
	const endsCleanly = /[.!?)\]"'`»”]\s*$/.test(trimmedFinal);
	const looksTruncated = stepsUsed >= MAX_STEPS && !endsCleanly;
	if (looksTruncated) {
		console.warn(
			`[orchestrator-v2] truncated wrap-up detected (steps=${stepsUsed}/${MAX_STEPS}, tail=${JSON.stringify(trimmedFinal.slice(-40))}); falling through to tool result`,
		);
	}
	const usefulFinal =
		trimmedFinal.length >= MIN_USEFUL_FINAL_TEXT && !looksTruncated ? finalText : '';

	if (results.length === 0) {
		// No tools produced a usable result. If a tool-error happened, the
		// model tried to act but the args didn't pass schema validation —
		// surface a tool-specific clarify so the user knows to rephrase.
		if (toolErrors.length > 0 && !usefulFinal) {
			return { kind: 'error', text: toolErrorFallback(toolErrors) };
		}
		// No tools ran — fall back to LLM final text (if it's actually
		// substantive). A bare "." or whitespace turns into an error.
		if (usefulFinal) return { kind: 'text', text: usefulFinal };
		if (trimmedFinal.length > 0) {
			// Model emitted something, but it's too short to be useful —
			// don't propagate the 1-char reply.
			return { kind: 'error', text: GENERIC_RETRY };
		}
		return undefined;
	}

	// ADR-030 — slow-dispatched short-circuits the turn. The background
	// skill-worker has already started; the LLM's final reply (if any) is
	// stale because the user's question is being answered by the worker.
	const slowResult = results.find((r) => r.kind === 'slow-dispatched');
	if (slowResult && slowResult.kind === 'slow-dispatched') {
		return { kind: 'slow-dispatched', toolName: slowResult.toolName, ack: slowResult.ack };
	}

	// Confirmed dispatch is the highest-stakes action — fire it first.
	const dispatchResult = results.find((r) => r.kind === 'dispatch');
	if (dispatchResult && dispatchResult.kind === 'dispatch') {
		return { kind: 'dispatch', agentId: dispatchResult.agentId, task: dispatchResult.task };
	}
	const dispatchErr = results.find((r) => r.kind === 'dispatch-error');
	if (dispatchErr && dispatchErr.kind === 'dispatch-error') {
		return { kind: 'error', text: `Couldn't dispatch agent: ${dispatchErr.error}` };
	}

	// Image takes priority — already on disk, must be sent.
	const imageResult = results.find((r) => r.kind === 'image');
	if (imageResult && imageResult.kind === 'image') {
		return {
			kind: 'image',
			attachPath: imageResult.attachPath,
			caption: imageResult.caption,
			imagePrompt: imageResult.prompt,
			text: finalText || undefined,
		};
	}
	const imageError = results.find((r) => r.kind === 'image-error');
	if (imageError && imageError.kind === 'image-error') {
		return { kind: 'error', text: imageError.error };
	}

	// Proposal next — DB row is committed, must surface to user.
	const proposalResult = results.find((r) => r.kind === 'proposal');
	if (proposalResult && proposalResult.kind === 'proposal') {
		return { kind: 'proposal', text: proposalResult.text };
	}

	// Search errors → surface as text reply.
	const wsErr = results.find((r) => r.kind === 'web-search-error');
	if (wsErr && wsErr.kind === 'web-search-error') {
		return { kind: 'error', text: `Couldn't run a web search: ${wsErr.error}` };
	}
	const vsErr = results.find((r) => r.kind === 'vault-search-error');
	if (vsErr && vsErr.kind === 'vault-search-error') {
		return { kind: 'error', text: `Couldn't search the vault: ${vsErr.error}` };
	}
	const skillErr = results.find((r) => r.kind === 'invoke-skill-error');
	if (skillErr && skillErr.kind === 'invoke-skill-error') {
		return {
			kind: 'error',
			text: `Couldn't run skill "${skillErr.skillName}": ${skillErr.error}`,
		};
	}
	const ytErr = results.find((r) => r.kind === 'youtube-error');
	if (ytErr && ytErr.kind === 'youtube-error') {
		return {
			kind: 'error',
			text: ytErrorReply(ytErr.tier, ytErr.error),
		};
	}
	const ttErr = results.find((r) => r.kind === 'tiktok-error');
	if (ttErr && ttErr.kind === 'tiktok-error') {
		return {
			kind: 'error',
			text: ttErrorReply(ttErr.tier, ttErr.error),
		};
	}
	const vsaveErr = results.find((r) => r.kind === 'vault-save-error');
	if (vsaveErr && vsaveErr.kind === 'vault-save-error') {
		return {
			kind: 'error',
			text: `Couldn't save "${vsaveErr.title}": ${vsaveErr.error}`,
		};
	}

	// Text-shaped tool results — prefer LLM's final text (it synthesises
	// the result), fall back to the raw tool output if the LLM didn't speak
	// usefully. Junk-short finalText (1-char fallthrough) is treated as
	// silence so the tool's own text wins.
	//
	// ADR-014 — when a youtubeFetch result with a summary participated in
	// this turn, attach `youtubeContext` to the text V2Output so channel
	// adapters can render follow-up action buttons. The model's `usefulFinal`
	// is the user-facing text; the structured fields are pinned separately
	// so we don't have to parse them back out of the prose.
	const ytForButtons = results.find(
		(r): r is Extract<ToolResult, { kind: 'youtube' }> =>
			r.kind === 'youtube' && typeof r.summary === 'string' && r.summary.length > 0,
	);
	const youtubeContext = ytForButtons
		? {
				videoUrl: ytForButtons.url,
				title: ytForButtons.title,
				summary: ytForButtons.summary as string,
			}
		: undefined;

	// `verbatim` wins over `usefulFinal` — tools that return verbatim text
	// have already composed the final reply; LLM narration here only removes
	// information (e.g. list-style outputs where row ids must survive).
	const verbatimResult = results.find((r) => r.kind === 'verbatim');
	if (verbatimResult && verbatimResult.kind === 'verbatim') {
		return { kind: 'text', text: verbatimResult.text };
	}

	// Self-narration guard. V4 Pro occasionally emits a short
	// pre-action wrap-up like "Right — let me pull X from the vault." even
	// AFTER the tool has already returned a polished reply. The user gets
	// the narration, not the data. Detect by: (a) we have a substantive
	// search/reply result on hand, AND (b) `usefulFinal` is short OR
	// matches the common self-narration openers. In that case prefer the
	// tool's verbatim text (the "Relaying retrieval results" prompt rule
	// is meant to make the model do this itself; this is the safety net
	// when it doesn't).
	const richTextResult =
		results.find((r) => r.kind === 'vault-search') ??
		results.find((r) => r.kind === 'web-search') ??
		results.find((r) => r.kind === 'reply');
	const richText =
		richTextResult && 'text' in richTextResult ? (richTextResult.text as string) : '';
	const selfNarrationOpener =
		/^(?:right\b|ok\b|okay\b|sure\b|let me\b|i'?ll\b|i will\b|i'?m going to\b|i'?m about to\b|got it\b)[\s—–\-,.:!]/i;
	const wrapUpLooksLikeNarration =
		usefulFinal.length > 0 &&
		(usefulFinal.trim().length < 120 ||
			selfNarrationOpener.test(usefulFinal.trim()));
	if (richText && richText.length >= 200 && wrapUpLooksLikeNarration) {
		console.warn(
			`[orchestrator-v2] self-narration wrap-up detected (len=${usefulFinal.length} tail=${JSON.stringify(usefulFinal.slice(-40))}); preferring ${richTextResult!.kind} result`,
		);
		return { kind: 'text', text: richText };
	}

	if (usefulFinal) return { kind: 'text', text: usefulFinal, youtubeContext };

	const replyResult = results.find((r) => r.kind === 'reply');
	if (replyResult && replyResult.kind === 'reply') {
		return { kind: 'text', text: replyResult.text };
	}
	const wsResult = results.find((r) => r.kind === 'web-search');
	if (wsResult && wsResult.kind === 'web-search') {
		return { kind: 'text', text: wsResult.text };
	}
	const vsResult = results.find((r) => r.kind === 'vault-search');
	if (vsResult && vsResult.kind === 'vault-search') {
		return { kind: 'text', text: vsResult.text };
	}
	// YouTube fallback — the LLM is expected to compose a reply from the
	// structured fields. When it didn't (junk-short finalText), render a
	// minimal text reply ourselves so the user still gets the metadata.
	// Attach `youtubeContext` so the channel adapter can still render the
	// follow-up action buttons even on the fallback path.
	const ytResult = results.find((r) => r.kind === 'youtube');
	if (ytResult && ytResult.kind === 'youtube') {
		const fbContext =
			typeof ytResult.summary === 'string' && ytResult.summary.length > 0
				? {
						videoUrl: ytResult.url,
						title: ytResult.title,
						summary: ytResult.summary,
					}
				: undefined;
		return {
			kind: 'text',
			text: formatYoutubeFallback(ytResult),
			youtubeContext: fbContext,
		};
	}
	// TikTok fallback — same pattern as YouTube. Model is supposed to compose
	// a reply from the structured fields; this is the safety net for
	// short/empty finalText.
	const ttResult = results.find((r) => r.kind === 'tiktok');
	if (ttResult && ttResult.kind === 'tiktok') {
		return {
			kind: 'text',
			text: formatTiktokFallback(ttResult),
		};
	}
	// vault-save fallback — same pattern. Model usually composes a "Saved as
	// [[...]]" reply, but if it doesn't, give the user the link directly.
	const vsaveResult = results.find((r) => r.kind === 'vault-save');
	if (vsaveResult && vsaveResult.kind === 'vault-save') {
		return {
			kind: 'text',
			text: `Saved *${vsaveResult.title}* — ${vsaveResult.openUrl}`,
		};
	}

	// ADR-025 — reminder-scheduled fallback. The model is supposed to
	// compose the confirmation itself (the description tells it to), but
	// give the user a coherent reply if the LLM punted on finalText.
	const remResult = results.find((r) => r.kind === 'reminder-scheduled');
	if (remResult && remResult.kind === 'reminder-scheduled') {
		const note = remResult.cadenceNote ? ` (${remResult.cadenceNote})` : '';
		return {
			kind: 'text',
			text: `OK — I'll remind you about *${remResult.text}* around ${remResult.fireAt}${note}`,
		};
	}
	const remErr = results.find((r) => r.kind === 'reminder-error');
	if (remErr && remErr.kind === 'reminder-error') {
		const friendly =
			remErr.error === 'reminders-not-supported-on-this-channel'
				? "Reminders are WhatsApp-only today — let me know if you want them on Telegram and I'll flag it."
				: remErr.error === 'reminders-disabled'
					? "Reminders are turned off in settings — flip the toggle to enable."
					: remErr.error === 'invalid-due-at'
						? `That time didn't parse cleanly${remErr.detail ? ` (${remErr.detail})` : ''} — try "tomorrow 11am" or a specific date.`
						: "I couldn't schedule that reminder. Try rephrasing the time.";
		return { kind: 'text', text: friendly };
	}

	// project-phases ADR-003 — projectShipSlice fallback. Same pattern as
	// vault-save: the model usually composes a "Marked ADR-007 S5 shipped"
	// reply itself, but if not, give the operator a coherent confirmation.
	const shipResult = results.find((r) => r.kind === 'project-ship-slice');
	if (shipResult && shipResult.kind === 'project-ship-slice') {
		const verb = shipResult.applied ? `marked` : `would mark (dry-run)`;
		const commitFragment = shipResult.commit ? ` at \`${shipResult.commit}\`` : '';
		return {
			kind: 'text',
			text: `${verb} *${shipResult.sliceId}* as ${shipResult.status} in ${shipResult.project}${commitFragment}.`,
		};
	}
	const shipErr = results.find((r) => r.kind === 'project-ship-slice-error');
	if (shipErr && shipErr.kind === 'project-ship-slice-error') {
		const rollbackNote = shipErr.rollbackAttempted
			? shipErr.rollbackOk
				? ' (rolled back the ADR write cleanly)'
				: ' — ADR rollback FAILED, please check the file manually'
			: '';
		return {
			kind: 'text',
			text: `Couldn't ship *${shipErr.sliceId}* on ${shipErr.adr}: ${shipErr.error}${rollbackNote}`,
		};
	}

	return undefined;
}

/** Map tool calls + final text to a v1 `OrchestratorDecision` so legacy
 *  callers (and analytics) keep working. The inbound handler prefers
 *  `v2Output` when present and only falls back to this for telemetry. */
function mapToolCallsToDecision(
	toolCalls: { name: string; argSummary: string }[],
	finalText: string,
): OrchestratorDecision {
	const last = toolCalls[toolCalls.length - 1];

	if (!last) {
		return finalText
			? { action: 'reply', reply: finalText, confidence: 0.9 }
			: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: 0 };
	}

	switch (last.name) {
		case 'reply':
			return { action: 'reply', reply: finalText || extractText(last.argSummary), confidence: 0.95 };
		case 'webSearch':
			return {
				action: 'web-search',
				webQuery: extractField(last.argSummary, 'query'),
				reply: finalText,
				confidence: 0.9,
			};
		case 'vaultSearch':
			return {
				action: 'vault-search',
				reply: finalText,
				confidence: 0.9,
			};
		case 'generateImage':
			return {
				action: 'generate-image',
				imagePrompt: extractField(last.argSummary, 'prompt'),
				confidence: 0.9,
			};
		case 'dispatchAgent': {
			// Match both `"confirmed":true` (real boolean) and `"confirmed":"true"`
			// (string from GLM-4.6) so the action mapping stays in sync with the
			// preprocess in tools/index.ts. Anything else (omitted, false, "false")
			// is propose-dispatch.
			const confirmed = /"confirmed"\s*:\s*(?:true|"true")/.test(last.argSummary);
			return {
				action: confirmed ? 'dispatch' : 'propose-dispatch',
				agent: extractField(last.argSummary, 'agentId'),
				task: extractField(last.argSummary, 'task'),
				proposalLabel: extractField(last.argSummary, 'proposalLabel') || undefined,
				reply: finalText,
				confidence: confirmed ? 0.9 : 0.85,
			};
		}
		case 'invokeSkill':
			return { action: 'reply', reply: finalText, confidence: 0.8 };
		case 'youtubeFetch':
			return { action: 'reply', reply: finalText, confidence: 0.85 };
		case 'tiktokFetch':
			return { action: 'reply', reply: finalText, confidence: 0.85 };
		case 'vaultSave':
			return { action: 'reply', reply: finalText, confidence: 0.9 };
		case 'scheduleReminder':
			return { action: 'reply', reply: finalText, confidence: 0.9 };
		case 'projectShipSlice':
			return { action: 'reply', reply: finalText, confidence: 0.9 };
		default:
			return { action: 'reply', reply: finalText, confidence: 0.7 };
	}
}

function extractField(jsonish: string, field: string): string {
	const m = jsonish.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
	return m ? m[1].replace(/\\"/g, '"') : '';
}

/** ADR-053 P3 v1 — deterministic deep-work routing.
 *
 *  An explicit "deep review / analyze / profile / due-diligence on <Entity>"
 *  is a predictable intent that the LLM otherwise coin-flips between `webSearch`
 *  (answer inline) and `dispatchAgent(analyst)` — observed flipping turn-to-turn
 *  on 2026-05-20. This detector recognises that intent so `decideV2` can route
 *  it deterministically to an analyst PROPOSAL (behind the confirm gate).
 *
 *  Conservative by design: it fires ONLY when a deep-work verb is paired with a
 *  CLEAR entity — a quoted name, or a capitalised proper-noun phrase after the
 *  verb / a connecting preposition. Quick factual questions, lowercase phrasings
 *  ("analyze this data"), and verb-without-entity all return null and fall
 *  through to the LLM, so the override never removes existing behaviour, it only
 *  makes the clear case predictable. */
const DEEP_WORK_VERB =
	'deep[\\s-]?(?:dive|review)|due[\\s-]?diligence|background\\s+check|profile|analy[sz]e|research|investigate|vet';
// Verb match is case-insensitive (catches a sentence-initial "Research …").
const DEEP_WORK_VERB_RE = new RegExp(`\\b(?:${DEEP_WORK_VERB})\\b`, 'i');
// Entity match runs on the text AFTER the verb and is case-SENSITIVE: it
// requires a capitalised proper-noun phrase (optionally via a connector), so
// "analyze this data" (lowercase object) correctly yields no entity.
const DEEP_WORK_ENTITY_RE =
	/^\s+(?:on|of|into|about|the\s+company|company)?\s*([A-Z][\w&.\-]*(?:\s+[A-Z][\w&.\-]*){0,4})/;

export function detectDeepWorkRoute(message: string): { entity: string } | null {
	const m = message.trim();
	const verbMatch = DEEP_WORK_VERB_RE.exec(m);
	if (!verbMatch) return null;

	// 1) An explicitly quoted name is the strongest signal.
	const quoted = m.match(/["'“]([^"'”]{2,60})["'”]/);
	let entity = quoted ? quoted[1].trim() : '';

	// 2) Otherwise a capitalised proper-noun phrase right after the verb.
	if (!entity) {
		const rest = m.slice(verbMatch.index + verbMatch[0].length);
		const after = rest.match(DEEP_WORK_ENTITY_RE);
		if (after) entity = after[1].trim();
	}

	if (entity.length < 2) return null;
	return { entity };
}

function extractText(jsonish: string): string {
	return extractField(jsonish, 'text') || jsonish;
}

const GENERIC_RETRY =
	"I'm not sure how to handle that — could you rephrase or give a bit more detail?";

/** Pick a tool-specific clarify when the model tried to call a tool but
 *  the args didn't pass schema validation. Picks the most-recent error so
 *  multi-error chains surface the failure that actually stopped progress. */
function toolErrorFallback(errors: readonly ToolError[]): string {
	const last = errors[errors.length - 1];
	switch (last.toolName) {
		case 'dispatchAgent':
			return 'I almost picked an agent for that, but I need a bit more detail — what specifically would you like me to do?';
		case 'invokeSkill':
			return "I tried to run a skill but the input wasn't quite right — can you say it differently?";
		case 'generateImage':
			return 'I tried to generate an image but the prompt was too vague — describe what you want to see (subject, style, setting).';
		case 'webSearch':
		case 'vaultSearch':
			return 'I tried to search but the query was too short — give me a few words to look for.';
		case 'youtubeFetch':
			return 'I tried to fetch the YouTube video but the link looks off — can you paste the full URL?';
		case 'tiktokFetch':
			return 'I tried to fetch the TikTok but the link looks off — can you paste the full URL?';
		case 'vaultSave':
			return "I tried to save that but the title or content didn't pass — can you say what you want me to save?";
		case 'projectShipSlice':
			return "I tried to mark that slice as shipped but the input wasn't quite right — give me the project slug, ADR slug, slice label (S<N> / CP<N> / Phase <N>), and the commit short-SHA.";
		default:
			return GENERIC_RETRY;
	}
}

/** Format a graceful error reply when the YouTube fetch failed entirely.
 *  Tier-aware so the user knows whether the link itself was bad or whether
 *  YouTube/Gemini misbehaved. */
function ytErrorReply(tier: 'oembed' | 'gemini' | 'url', error: string): string {
	switch (tier) {
		case 'url':
			return `That doesn't look like a YouTube link I can read. Could you paste the full URL?`;
		case 'oembed':
			return `Couldn't pull that YouTube video — it might be private or the link is wrong (${error.slice(0, 80)}).`;
		case 'gemini':
			return `Got the video info, but couldn't analyze it this turn (${error.slice(0, 80)}). Try again, or share a different video.`;
	}
}

/** Render a minimal text reply from a youtube tool result when the LLM
 *  didn't compose one itself. The model is *supposed* to write the reply
 *  using the structured fields; this is the safety net for short/empty
 *  finalText. */
function formatYoutubeFallback(r: {
	url: string;
	title: string;
	channel: string;
	durationSec?: number;
	summary?: string;
	transcript?: string;
	transcriptSource: 'gemini' | 'none';
	note?: string;
}): string {
	const lines = [`*${r.title}* — ${r.channel}`];
	if (r.durationSec !== undefined) {
		lines.push(`Duration: ${formatDuration(r.durationSec)}`);
	}
	if (r.summary) {
		lines.push('', r.summary);
	} else if (r.transcript) {
		lines.push('', r.transcript.slice(0, 2_000));
	}
	if (r.note === 'transcript-quota-exceeded') {
		lines.push('', `(Hit today's transcript budget — only saved title and link.)`);
	} else if (r.note === 'gemini-failed') {
		lines.push('', `(Couldn't analyze the video this turn — only got title and link.)`);
	} else if (r.note === 'transcript-disabled') {
		lines.push('', `(Transcript fetch is disabled — only got title and link.)`);
	}
	lines.push('', r.url);
	return lines.join('\n');
}

function formatDuration(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format a graceful error reply when the TikTok fetch failed entirely.
 *  Tier-aware so the user knows whether the link itself was bad, the
 *  network call failed, or whisper/Gemini misbehaved (ADR-024). */
function ttErrorReply(
	tier: 'url' | 'metadata' | 'download' | 'whisper' | 'gemini',
	error: string,
): string {
	switch (tier) {
		case 'url':
			return `That doesn't look like a TikTok link I can read. Could you paste the full URL?`;
		case 'metadata':
			return `Couldn't pull that TikTok — it might be private, region-locked, or the link is wrong (${error.slice(0, 80)}).`;
		case 'download':
			return `Couldn't download the TikTok audio — TikTok may be rate-limiting this server right now (${error.slice(0, 80)}). Try again in a minute.`;
		case 'whisper':
			return `Got the TikTok info, but couldn't transcribe it locally (${error.slice(0, 80)}).`;
		case 'gemini':
			return `Got the TikTok info, but couldn't summarize it this turn (${error.slice(0, 80)}).`;
	}
}

/** Render a minimal text reply from a tiktok tool result when the LLM
 *  didn't compose one itself. Mirrors `formatYoutubeFallback` (ADR-024). */
function formatTiktokFallback(r: {
	url: string;
	author: string;
	caption: string;
	durationSec: number;
	views?: number;
	likes?: number;
	transcript?: string;
	summary?: string;
	transcriptSource: 'whisper-cpp' | 'gemini' | 'none';
	isPhotoPost: boolean;
	note?: string;
}): string {
	const lines: string[] = [];
	const head = r.author ? `*@${r.author}* — TikTok` : '*TikTok*';
	lines.push(head);
	if (!r.isPhotoPost && r.durationSec > 0) {
		lines.push(`Duration: ${formatDuration(r.durationSec)}`);
	}
	if (r.caption) {
		lines.push('', r.caption);
	}
	if (r.summary) {
		lines.push('', r.summary);
	} else if (r.transcript) {
		lines.push('', r.transcript.slice(0, 2_000));
	}
	if (r.note === 'summary-quota-exceeded') {
		lines.push('', `(Hit today's TikTok summary budget — saved transcript only.)`);
	} else if (r.note === 'gemini-failed') {
		lines.push('', `(Couldn't summarize this turn — only got metadata and transcript.)`);
	} else if (r.note === 'whisper-failed' || r.note === 'whisper-not-installed') {
		lines.push('', `(Couldn't transcribe this turn — only got the metadata and caption.)`);
	} else if (r.note === 'duration-cap-exceeded') {
		lines.push('', `(Clip is too long to transcribe — only got the metadata and caption.)`);
	} else if (r.note === 'photo-post-no-audio') {
		lines.push('', `(Photo carousel — no spoken content to transcribe.)`);
	} else if (r.note === 'transcript-disabled') {
		lines.push('', `(TikTok transcript fetch is disabled in settings.)`);
	}
	lines.push('', r.url);
	return lines.join('\n');
}
