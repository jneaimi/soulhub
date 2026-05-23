<script lang="ts">
	import type { ClaudeEvent } from '$lib/sessions/types.js';

	interface Props {
		events: ClaudeEvent[];
		toolBreakdown: Record<string, number>;
	}

	let { events, toolBreakdown }: Props = $props();

	// Build a flat ordered list of tool_use + matching tool_result pairs
	interface Call {
		idx: number;
		tool: string;
		args: Record<string, unknown> | undefined;
		toolUseId?: string;
		timestamp?: string;
		status?: 'ok' | 'error';
		resultPreview?: string;
	}

	const calls = $derived.by((): Call[] => {
		const out: Call[] = [];
		const resultsByToolUseId = new Map<string, ClaudeEvent>();
		for (const e of events) {
			if (e.type !== 'user') continue;
			const c = e.message?.content;
			if (!Array.isArray(c)) continue;
			for (const block of c) {
				if (block?.type === 'tool_result' && block.tool_use_id) {
					resultsByToolUseId.set(block.tool_use_id, e);
				}
			}
		}
		let idx = 0;
		for (const e of events) {
			if (e.type !== 'assistant') continue;
			const c = e.message?.content;
			if (!Array.isArray(c)) continue;
			for (const block of c) {
				if (block?.type !== 'tool_use' || !block.name) continue;
				const tuid = block.id;
				const result = tuid ? resultsByToolUseId.get(tuid) : undefined;
				let resultPreview: string | undefined;
				let status: 'ok' | 'error' = 'ok';
				if (result) {
					const rc = result.message?.content;
					if (Array.isArray(rc)) {
						for (const rb of rc) {
							if (rb?.type === 'tool_result') {
								if (rb.is_error) status = 'error';
								if (typeof rb.content === 'string') {
									resultPreview = rb.content.slice(0, 200);
								} else if (Array.isArray(rb.content)) {
									const text = rb.content.find((x: { type?: string }) => x?.type === 'text');
									if (text && typeof (text as { text?: unknown }).text === 'string') {
										resultPreview = ((text as { text: string }).text).slice(0, 200);
									}
								}
								break;
							}
						}
					}
				}
				out.push({
					idx: idx++,
					tool: block.name,
					args: block.input,
					toolUseId: tuid,
					timestamp: e.timestamp,
					status,
					resultPreview,
				});
			}
		}
		return out;
	});

	let expanded = $state<Set<number>>(new Set());
	function toggle(i: number) {
		const next = new Set(expanded);
		if (next.has(i)) next.delete(i); else next.add(i);
		expanded = next;
	}

	function summarizeArgs(tool: string, args: Record<string, unknown> | undefined): string {
		if (!args) return '';
		if (typeof args.file_path === 'string') return args.file_path;
		if (typeof args.command === 'string') return args.command.slice(0, 80);
		if (typeof args.pattern === 'string') return args.pattern;
		if (typeof args.query === 'string') return args.query.slice(0, 80);
		if (typeof args.description === 'string') return args.description;
		return JSON.stringify(args).slice(0, 80);
	}

	const toolList = $derived(
		Object.entries(toolBreakdown).sort((a, b) => b[1] - a[1])
	);
</script>

{#if calls.length === 0}
	<p class="text-xs text-hub-dim py-6 text-center">No tool calls in this session.</p>
{:else}
	<div class="space-y-3">
		<div class="flex flex-wrap gap-1.5 mb-2">
			{#each toolList as [name, count]}
				<span class="text-[10px] px-2 py-0.5 rounded-full bg-hub-bg text-hub-muted border border-hub-border/40">
					{name} <span class="text-hub-dim">·{count}</span>
				</span>
			{/each}
		</div>
		<div class="divide-y divide-hub-border/30">
			{#each calls as call (call.idx)}
				<div class="py-1.5">
					<button
						onclick={() => toggle(call.idx)}
						class="w-full text-left flex items-start gap-2 hover:bg-hub-surface/40 rounded px-2 py-1 transition-colors cursor-pointer"
					>
						<span class="flex-shrink-0 w-1.5 h-1.5 rounded-full mt-1.5 {call.status === 'error' ? 'bg-hub-danger' : 'bg-hub-cta/60'}"></span>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="text-xs font-mono text-hub-text">{call.tool}</span>
								{#if call.timestamp}
									<span class="text-[10px] text-hub-dim">{new Date(call.timestamp).toLocaleTimeString()}</span>
								{/if}
							</div>
							<div class="text-[11px] text-hub-muted truncate font-mono">{summarizeArgs(call.tool, call.args)}</div>
						</div>
					</button>
					{#if expanded.has(call.idx)}
						<div class="ml-5 mt-1 space-y-1 text-[11px]">
							<div>
								<div class="text-hub-dim mb-0.5">args</div>
								<pre class="bg-hub-bg rounded p-2 text-hub-muted overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(call.args, null, 2)}</pre>
							</div>
							{#if call.resultPreview}
								<div>
									<div class="text-hub-dim mb-0.5">result {call.status === 'error' ? '(error)' : ''}</div>
									<pre class="bg-hub-bg rounded p-2 text-hub-muted overflow-x-auto whitespace-pre-wrap">{call.resultPreview}</pre>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
{/if}
