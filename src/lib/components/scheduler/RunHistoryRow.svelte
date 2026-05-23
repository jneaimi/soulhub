<script lang="ts">
	import StatusPill from './StatusPill.svelte';

	export interface RunRow {
		id: number;
		taskId: string;
		scheduledFor: string;
		startedAt: string;
		finishedAt: string | null;
		status: string;
		durationMs: number | null;
		errorMessage: string | null;
		outputSummary: string | null;
	}

	interface Props {
		row: RunRow;
	}

	const { row }: Props = $props();

	function pillState(s: string) {
		if (s === 'success') return 'success' as const;
		if (s === 'error') return 'failed' as const;
		if (s === 'started') return 'running' as const;
		if (s === 'overlap-skipped') return 'missed' as const;
		return 'disabled' as const;
	}

	function fmtTime(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleString('en-GB', {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false,
		});
	}

	function fmtDuration(ms: number | null): string {
		if (ms === null) return '—';
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${(ms / 60_000).toFixed(1)}m`;
	}

	const summaryExcerpt = $derived.by(() => {
		if (row.errorMessage) return row.errorMessage.slice(0, 120);
		if (!row.outputSummary) return '';
		try {
			const parsed = JSON.parse(row.outputSummary);
			if (typeof parsed === 'object' && parsed) {
				if (parsed.stdoutTail) return String(parsed.stdoutTail).trim().slice(0, 120);
				if (parsed.outputPath) return `→ ${parsed.outputPath}`;
				const firstKey = Object.keys(parsed)[0];
				if (firstKey) return `${firstKey}: ${JSON.stringify(parsed[firstKey])}`.slice(0, 120);
			}
			return String(parsed).slice(0, 120);
		} catch {
			return row.outputSummary.slice(0, 120);
		}
	});
</script>

<div class="grid grid-cols-[80px_180px_80px_1fr] gap-3 items-start py-1.5 px-3 border-b border-hub-border/40 last:border-0 text-[11px]">
	<div class="pt-0.5">
		<StatusPill state={pillState(row.status)} size="sm" label={row.status} />
	</div>
	<div class="text-hub-muted font-mono">{fmtTime(row.startedAt)}</div>
	<div class="text-hub-muted font-mono">{fmtDuration(row.durationMs)}</div>
	<div class="text-hub-dim truncate" title={summaryExcerpt}>{summaryExcerpt}</div>
</div>
