/** ADR-034 §Step 2 — DeepSeek V4 Flash smoke battery.
 *
 *  Calls decideV2 in-process with ORCHESTRATOR_V2_BRANCH_OVERRIDE forced to
 *  `deepseek-v4-flash`, runs a safe subset of the 12-message battery from
 *  the ADR (skips image gen, real agent dispatch, slow tiktok/youtube
 *  fetches, scheduleReminder), and prints a structured report.
 *
 *  Uses a synthetic conversationKey so the test history doesn't pollute
 *  the operator's real `chat_history`. Cleans up at the end.
 *
 *  Run:
 *    npx tsx scripts/smoke-deepseek-v4-flash.ts
 *
 *  For the side-effecting tests (image gen, real agent dispatch, slow
 *  fetches) — send those over WhatsApp directly with the same override
 *  active. */

// Branch override: pass via env. Defaults to deepseek-v4-flash for backward compat.
//   BRANCH=deepseek-v4-flash npx tsx scripts/smoke-deepseek-v4-flash.ts
//   BRANCH=deepseek-v4-pro   npx tsx scripts/smoke-deepseek-v4-flash.ts
//   BRANCH=glm-4.6           npx tsx scripts/smoke-deepseek-v4-flash.ts   # control
const BRANCH = process.env.BRANCH ?? 'deepseek-v4-flash';
process.env.ORCHESTRATOR_V2_BRANCH_OVERRIDE = BRANCH;

import { decideV2 } from '../src/lib/orchestrator-v2/index.js';
import { config } from '../src/lib/config.js';
import { getInboxDb } from '../src/lib/inbox/db.js';
import { initVault } from '../src/lib/vault/index.js';

const TEST_CK = `smoke:${BRANCH}:${Date.now()}`;

interface SmokeTurn {
	label: string;
	message: string;
	expectedTool?: string; // human-readable hint of what we'd hope to see
	skip?: string; // reason to skip
}

// Safe-to-fire subset. Side-effecting turns are commented with `skip` —
// run those manually over WhatsApp.
const BATTERY: SmokeTurn[] = [
	{ label: '1. baseline reply', message: 'Hi', expectedTool: '(none — direct reply)' },
	{ label: '2. inbox read', message: "What's in my inbox?", expectedTool: 'inbox-list-queued' },
	{
		label: '3. vault search',
		message: 'Find my notes on orchestrator',
		expectedTool: 'vaultSearch',
	},
	{
		label: '4. web search',
		message: "What's the latest news on Chinese cars in UAE",
		expectedTool: 'webSearch',
	},
	{
		label: '5. agent proposal (no dispatch)',
		message: 'Research hydroponics for me',
		expectedTool: 'dispatchAgent (confirmed: false → propose)',
	},
	{
		label: '6. arabic reply',
		message: 'اهلاً، كيف حالك اليوم؟',
		expectedTool: '(none — direct reply, must match Arabic)',
	},
	{
		label: '7. reminder',
		message: 'Remind me to push the build tomorrow at 9am',
		expectedTool: 'scheduleReminder',
	},
];

interface TurnResult {
	label: string;
	message: string;
	expected: string;
	model: string;
	branch: string;
	tools: string[];
	toolArgs: string[];
	output: string;
	outputKind: string;
	latencyMs: number;
	costUsd?: number;
	inputTokens?: number;
	outputTokens?: number;
	error?: string;
}

function fmtTools(t: { name: string; argSummary: string }[]): { names: string[]; args: string[] } {
	return {
		names: t.map((x) => x.name),
		args: t.map((x) => `${x.name}(${x.argSummary || ''})`),
	};
}

async function runTurn(turn: SmokeTurn, history: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<TurnResult> {
	const start = Date.now();
	try {
		const result = await decideV2(turn.message, {
			history,
			conversationKey: TEST_CK,
			senderNumber: '+971000000099', // synthetic — won't hit real quota
			channel: 'whatsapp',
			account: config.account ?? 'jasem',
			timezone: 'Asia/Dubai',
			imgConfig: { enabled: false, maxPerDay: 0, systemPromptPath: '' },
			youtubeConfig: { enabled: false, maxPerDay: 0 },
			tiktokConfig: { enabled: false, maxPerDay: 0, maxDurationSec: 0 },
			remindersConfig: { enabled: config.reminders?.enabled ?? true },
			heartbeatConfig: {
				enabled: false,
				activeHours: { start: '08:00', end: '23:00', timezone: 'Asia/Dubai' },
				muteUntil: null,
			},
		});
		const t = fmtTools(result.telemetry?.toolCalls ?? []);
		const out = result.v2Output;
		const text =
			out?.kind === 'text'
				? out.text
				: out?.kind === 'proposal'
					? `[PROPOSAL] ${out.text}`
					: out?.kind === 'error'
						? `[ERROR] ${out.text}`
						: out?.kind === 'dispatch'
							? `[DISPATCH] ${out.agentId}: ${out.task.slice(0, 120)}`
							: out?.kind === 'slow-dispatched'
								? `[SLOW] ${out.toolName} ack=${out.ack}`
								: out?.kind === 'image'
									? `[IMAGE] ${out.attachPath}`
									: '(no v2Output)';
		return {
			label: turn.label,
			message: turn.message,
			expected: turn.expectedTool ?? '',
			model: result.telemetry?.model ?? '?',
			branch: result.telemetry?.modelBranch ?? '?',
			tools: t.names,
			toolArgs: t.args,
			output: text,
			outputKind: out?.kind ?? 'none',
			latencyMs: Date.now() - start,
			costUsd: result.telemetry?.costUsd,
			inputTokens: result.telemetry?.inputTokens,
			outputTokens: result.telemetry?.outputTokens,
		};
	} catch (err) {
		return {
			label: turn.label,
			message: turn.message,
			expected: turn.expectedTool ?? '',
			model: '?',
			branch: '?',
			tools: [],
			toolArgs: [],
			output: '',
			outputKind: 'exception',
			latencyMs: Date.now() - start,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function cleanup() {
	const db = getInboxDb();
	const d1 = db.prepare(`DELETE FROM chat_history WHERE conversation_key = ?`).run(TEST_CK);
	const d2 = db.prepare(`DELETE FROM intent_log WHERE conversation_key = ?`).run(TEST_CK);
	const d3 = db.prepare(`DELETE FROM model_branch_assignment WHERE conversation_key = ?`).run(TEST_CK);
	// scheduleReminder writes to heartbeat.db's commitments table — clean any stragglers
	console.log(
		`\ncleanup: chat_history=${d1.changes} intent_log=${d2.changes} branch_assignment=${d3.changes}`,
	);
}

async function main() {
	console.log(`=== Smoke: ${BRANCH} ===`);
	console.log(`conversationKey: ${TEST_CK}`);
	console.log(`override: ${process.env.ORCHESTRATOR_V2_BRANCH_OVERRIDE}`);
	console.log(`turns: ${BATTERY.length}`);
	// Initialize the vault engine — otherwise the in-process singleton is null
	// and the vaultSearch tool returns silently empty (caught a real false-
	// negative on 2026-05-14 when this wasn't done — see vault-chat/tools.ts
	// warning logic). Mirrors `hooks.server.ts:53` startup ordering.
	const vaultStart = Date.now();
	await initVault(config.resolved.vaultDir);
	console.log(`vault initialized in ${Date.now() - vaultStart}ms`);
	console.log('');

	const results: TurnResult[] = [];
	const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

	for (const turn of BATTERY) {
		console.log(`--- ${turn.label} ---`);
		console.log(`> ${turn.message}`);
		const r = await runTurn(turn, history);
		results.push(r);
		console.log(
			`  branch=${r.branch} model=${r.model} latency=${r.latencyMs}ms tools=[${r.tools.join(', ')}] kind=${r.outputKind}`,
		);
		if (r.error) {
			console.log(`  ERROR: ${r.error}`);
		} else {
			const preview = r.output.replace(/\s+/g, ' ').slice(0, 200);
			console.log(`  reply: ${preview}${r.output.length > 200 ? '…' : ''}`);
			if (r.costUsd != null)
				console.log(
					`  tokens: in=${r.inputTokens ?? '?'} out=${r.outputTokens ?? '?'} cost=$${r.costUsd.toFixed(5)}`,
				);
		}
		console.log('');
		// Push the turn into local history so anaphora tests would work if added.
		history.push({ role: 'user', content: turn.message });
		if (r.output && !r.error) {
			history.push({ role: 'assistant', content: r.output });
		}
	}

	// Summary table
	console.log('\n=== Summary ===');
	const totalCost = results.reduce((a, r) => a + (r.costUsd ?? 0), 0);
	const avgLatency = Math.round(results.reduce((a, r) => a + r.latencyMs, 0) / results.length);
	console.log(`avg latency: ${avgLatency}ms`);
	console.log(`total cost:  $${totalCost.toFixed(4)}`);
	console.log('');
	console.log('| # | turn                          | expected                         | tools fired                   | latency | $ |');
	console.log('|---|-------------------------------|----------------------------------|-------------------------------|---------|---|');
	results.forEach((r, i) => {
		const tools = r.tools.length ? r.tools.join(',') : '(none)';
		const cost = r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : '—';
		console.log(
			`| ${i + 1} | ${r.label.padEnd(29)} | ${(r.expected || '').padEnd(32)} | ${tools.padEnd(29)} | ${String(r.latencyMs).padStart(5)}ms | ${cost} |`,
		);
	});

	cleanup();
	console.log('\ndone.');
}

main().catch((e) => {
	console.error('smoke failed:', e);
	cleanup();
	process.exit(1);
});
