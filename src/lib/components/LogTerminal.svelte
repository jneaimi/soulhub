<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';

	interface Props {
		/** Raw terminal output (with ANSI codes) to render */
		data?: string;
		/** Max height CSS value */
		maxHeight?: string;
	}

	let { data = '', maxHeight = '240px' }: Props = $props();

	let terminalEl: HTMLDivElement | undefined = $state();
	let terminal: any = null;
	let writtenLength = 0;
	let mounted = false;

	// Fixed dimensions — no FitAddon, no resize loops
	const COLS = 120;
	const ROWS = 14;

	onMount(async () => {
		const { Terminal } = await import('@xterm/xterm');
		const { Unicode11Addon } = await import('@xterm/addon-unicode11');
		await import('@xterm/xterm/css/xterm.css');

		terminal = new Terminal({
			cols: COLS,
			rows: ROWS,
			cursorBlink: false,
			cursorStyle: 'underline',
			disableStdin: true,
			fontSize: 12,
			fontFamily: "'JetBrains Mono', 'Fira Code', 'Menlo', monospace",
			theme: {
				background: '#0a0a0f',
				foreground: '#e0e0e8',
				cursor: '#0a0a0f',
				selectionBackground: '#a78bfa40',
				black: '#1a1a2e',
				red: '#ff6b6b',
				green: '#51cf66',
				yellow: '#fcc419',
				blue: '#748ffc',
				magenta: '#c084fc',
				cyan: '#22d3ee',
				white: '#e0e0e8',
				brightBlack: '#4a4a6a',
				brightRed: '#ff8787',
				brightGreen: '#69db7c',
				brightYellow: '#ffd43b',
				brightBlue: '#91a7ff',
				brightMagenta: '#d8b4fe',
				brightCyan: '#67e8f9',
				brightWhite: '#f8f8ff',
			},
			allowProposedApi: true,
			convertEol: true,
			scrollback: 5000,
			scrollOnUserInput: false,
		});

		terminal.loadAddon(new Unicode11Addon());

		if (terminalEl) {
			terminal.open(terminalEl);

			// Write any data that's already available
			if (data) {
				terminal.write(data);
				writtenLength = data.length;
			}

			// Fix xterm scroll layers: .xterm-screen sits above .xterm-viewport
			// and swallows wheel events. Let events pass through to the viewport.
			const screen = terminalEl.querySelector('.xterm-screen') as HTMLElement;
			if (screen) screen.style.pointerEvents = 'none';
			const viewport = terminalEl.querySelector('.xterm-viewport') as HTMLElement;
			if (viewport) {
				viewport.style.pointerEvents = 'all';
				viewport.style.overflowY = 'scroll';
			}

			mounted = true;
		}
	});

	// React to data changes — write incremental updates
	$effect(() => {
		const currentData = data;
		if (!mounted || !terminal || !currentData) return;
		if (currentData.length > writtenLength) {
			tick().then(() => {
				if (terminal && data.length > writtenLength) {
					terminal.write(data.slice(writtenLength));
					writtenLength = data.length;
				}
			});
		}
	});

	onDestroy(() => {
		if (terminal) terminal.dispose();
	});
</script>

<div
	bind:this={terminalEl}
	class="w-full rounded-b-lg"
	style="height: {maxHeight}; contain: layout size;"
></div>
