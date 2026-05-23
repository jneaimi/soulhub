<script lang="ts">
	type State =
		| 'success'
		| 'failed'
		| 'running'
		| 'scheduled'
		| 'disabled'
		| 'missed'
		| 'ready'
		| 'unhealthy';

	interface Props {
		state: State;
		label?: string;
		size?: 'sm' | 'md';
	}

	const { state, label, size = 'md' }: Props = $props();

	const dotClass: Record<State, string> = {
		success: 'bg-hub-cta',
		failed: 'bg-hub-danger',
		running: 'bg-cyan-400 motion-safe:animate-pulse',
		scheduled: 'bg-hub-info',
		disabled: 'bg-hub-dim',
		missed: 'bg-hub-warning',
		ready: 'bg-hub-cta',
		unhealthy: 'bg-hub-warning',
	};

	const textClass: Record<State, string> = {
		success: 'text-hub-cta',
		failed: 'text-hub-danger',
		running: 'text-cyan-400',
		scheduled: 'text-hub-info',
		disabled: 'text-hub-dim',
		missed: 'text-hub-warning',
		ready: 'text-hub-cta',
		unhealthy: 'text-hub-warning',
	};

	const defaultLabel: Record<State, string> = {
		success: 'Healthy',
		failed: 'Failed',
		running: 'Running',
		scheduled: 'Scheduled',
		disabled: 'Disabled',
		missed: 'Missed',
		ready: 'Ready',
		unhealthy: 'Unhealthy',
	};

	const dotSize = size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2';
	const textSize = size === 'sm' ? 'text-[10px]' : 'text-xs';
</script>

<span class="inline-flex items-center gap-1.5 {textSize} font-medium {textClass[state]}">
	<span class="rounded-full {dotSize} {dotClass[state]}"></span>
	{label ?? defaultLabel[state]}
</span>
