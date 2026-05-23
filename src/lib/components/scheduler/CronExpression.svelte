<script lang="ts">
	import cronstrue from 'cronstrue';
	import { CronExpressionParser } from 'cron-parser';

	interface Props {
		value: string;
		timezone?: string | null;
		mode?: 'full' | 'compact';
	}

	const { value, timezone, mode = 'compact' }: Props = $props();

	function isCronValid(expr: string): boolean {
		if (!expr) return false;
		try {
			CronExpressionParser.parse(expr);
			return true;
		} catch {
			return false;
		}
	}

	const isValid = $derived(isCronValid(value));
	const human = $derived.by(() => {
		if (!isValid) return null;
		try {
			return cronstrue.toString(value);
		} catch {
			return null;
		}
	});
</script>

{#if mode === 'compact'}
	<div class="flex flex-col gap-0.5">
		{#if human}
			<span class="text-xs text-hub-text">{human}</span>
		{/if}
		<div class="flex items-center gap-1.5">
			<code class="text-[11px] font-mono text-hub-muted">{value}</code>
			{#if timezone}
				<span class="text-[10px] text-hub-dim">({timezone})</span>
			{/if}
		</div>
	</div>
{:else}
	<div class="flex flex-col gap-1.5">
		<div class="flex items-center gap-2">
			<code class="text-sm font-mono text-hub-text">{value}</code>
			{#if timezone}
				<span class="text-xs text-hub-muted px-1.5 py-0.5 rounded bg-hub-bg border border-hub-border">{timezone}</span>
			{/if}
		</div>
		{#if human}
			<span class="text-sm text-hub-muted">{human}</span>
		{:else if value}
			<span class="text-sm text-hub-danger">Invalid expression</span>
		{/if}
	</div>
{/if}
