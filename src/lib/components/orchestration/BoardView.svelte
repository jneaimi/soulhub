<script lang="ts">
	const {
		board,
		requests = [],
	}: {
		board: string;
		requests: Array<{ taskId: string; content: string }>;
	} = $props();

	// Minimal markdown renderer — we control the board format
	function renderMarkdown(md: string): string {
		if (!md) return '';

		const lines = md.split('\n');
		const result: string[] = [];
		let inTable = false;
		let isHeaderRow = true;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Headers
			if (line.startsWith('# ')) { result.push(`<h2 style="margin:8px 0 4px;font-size:16px;color:#e0e0e0">${esc(line.slice(2))}</h2>`); continue; }
			if (line.startsWith('## ')) { result.push(`<h3 style="margin:8px 0 4px;font-size:14px;color:#e0e0e0">${esc(line.slice(3))}</h3>`); continue; }
			if (line.startsWith('### ')) { result.push(`<h4 style="margin:6px 0 4px;font-size:13px;color:#e0e0e0">${esc(line.slice(4))}</h4>`); continue; }

			// Table rows
			if (line.startsWith('|')) {
				// Skip separator rows (|---|---|)
				if (line.match(/^\|[\s\-:|]+\|$/)) {
					isHeaderRow = false;
					continue;
				}
				if (!inTable) {
					inTable = true;
					isHeaderRow = true;
					result.push('<table style="border-collapse:collapse;width:100%;margin:4px 0">');
				}
				const cells = line.split('|').slice(1, -1).map((c) => c.trim());
				const tag = isHeaderRow ? 'th' : 'td';
				const style = isHeaderRow
					? 'padding:4px 8px;border:1px solid #2a2a3e;font-size:11px;color:#888;text-align:left;background:#0f0f15'
					: 'padding:4px 8px;border:1px solid #1e1e2e;font-size:12px;color:#ccc';
				result.push(`<tr>${cells.map((c) => `<${tag} style="${style}">${inlineFormat(c)}</${tag}>`).join('')}</tr>`);
				continue;
			}

			// Close table if we were in one
			if (inTable) {
				inTable = false;
				isHeaderRow = true;
				result.push('</table>');
			}

			// List items
			if (line.startsWith('- ')) { result.push(`<div style="padding-left:12px;font-size:12px;color:#ccc">&#x2022; ${inlineFormat(line.slice(2))}</div>`); continue; }

			// Empty lines
			if (line.trim() === '') { result.push('<div style="height:4px"></div>'); continue; }

			// Plain text
			result.push(`<div style="font-size:12px;color:#ccc">${inlineFormat(line)}</div>`);
		}

		if (inTable) result.push('</table>');

		return result.join('\n');
	}

	function esc(s: string): string {
		return s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function inlineFormat(s: string): string {
		let out = esc(s);
		// Bold
		out = out.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#e0e0e0">$1</strong>');
		// Inline code
		out = out.replace(/`(.+?)`/g, '<code style="background:#1a1a2e;padding:1px 4px;border-radius:2px;font-size:11px">$1</code>');
		// Status icons
		out = out.replace(/✓/g, '<span style="color:#22c55e">&#x2713;</span>');
		out = out.replace(/●/g, '<span style="color:#3b82f6">&#x25cf;</span>');
		out = out.replace(/✗/g, '<span style="color:#ef4444">&#x2717;</span>');
		out = out.replace(/○/g, '<span style="color:#666">&#x25cb;</span>');
		return out;
	}

	const renderedBoard = $derived(renderMarkdown(board));
</script>

<div class="board-view">
	<div class="board-header">
		<span class="board-title">Board</span>
	</div>

	{#if board}
		<div class="board-content">
			{@html renderedBoard}
		</div>
	{:else}
		<div class="board-empty">No board content yet</div>
	{/if}

	{#if requests.length > 0}
		<div class="requests-section">
			<div class="requests-title">Worker Requests</div>
			{#each requests as req}
				<div class="request-item">
					<span class="request-task">[{req.taskId}]</span>
					<span class="request-content">{req.content}</span>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.board-view {
		background: #111118;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		overflow: hidden;
	}
	.board-header {
		padding: 8px 14px;
		border-bottom: 1px solid #1e1e2e;
		display: flex;
		align-items: center;
	}
	.board-title {
		color: #e0e0e0;
		font-size: 13px;
		font-weight: 600;
	}
	.board-content {
		padding: 10px 14px;
		max-height: 400px;
		overflow-y: auto;
	}
	.board-content :global(table) {
		border-collapse: collapse;
		width: 100%;
		margin: 4px 0;
	}
	.board-empty {
		padding: 20px 14px;
		color: #555;
		font-size: 13px;
		text-align: center;
	}
	.requests-section {
		border-top: 1px solid #1e1e2e;
		padding: 8px 14px;
	}
	.requests-title {
		color: #f59e0b;
		font-size: 12px;
		font-weight: 600;
		margin-bottom: 6px;
	}
	.request-item {
		display: flex;
		gap: 8px;
		padding: 4px 0;
		font-size: 12px;
	}
	.request-task {
		color: #a78bfa;
		font-family: 'SF Mono', monospace;
		flex-shrink: 0;
	}
	.request-content {
		color: #ccc;
	}
</style>
