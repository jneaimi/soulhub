<script lang="ts">
	type Backend = 'claude-pty' | 'claude-cli-flag' | 'ai-sdk';

	interface Props {
		backend: Backend;
		size?: 'sm' | 'md';
	}

	const { backend, size = 'md' }: Props = $props();

	// Backend → token reuse per design proposal:
	//   claude-pty       → purple  (parallel-safe, prestige tier)
	//   claude-cli-flag  → warning (single-call only, parallel-unsafe)
	//   ai-sdk           → info    (BYOK, provider-flexible)
	const colorClass: Record<Backend, string> = {
		'claude-pty': 'text-hub-purple border-hub-purple/40',
		'claude-cli-flag': 'text-hub-warning border-hub-warning/40',
		'ai-sdk': 'text-hub-info border-hub-info/40',
	};

	const labelMap: Record<Backend, string> = {
		'claude-pty': 'PTY',
		'claude-cli-flag': 'CLI flag',
		'ai-sdk': 'AI SDK',
	};

	const sizeClass = size === 'sm' ? 'text-[10px] px-1 py-px' : 'text-[10px] px-1.5 py-0.5';
</script>

<span
	class="inline-flex items-center font-mono {sizeClass} bg-hub-bg rounded border {colorClass[backend]}"
	title={backend}
>
	{labelMap[backend]}
</span>
