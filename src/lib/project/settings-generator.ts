/**
 * Generates .claude/settings.json content for a project.
 * Mirrors the builder's settings format at pipelines/_builder/.claude/settings.json.
 * Wires guard.sh as a PreToolUse hook on Write and Edit tools.
 */
export function generateSettings(): object {
	return {
		hooks: {
			PreToolUse: [
				{
					matcher: 'Write',
					hooks: [
						{
							type: 'command',
							command: 'bash .claude/hooks/guard.sh',
						},
					],
				},
				{
					matcher: 'Edit',
					hooks: [
						{
							type: 'command',
							command: 'bash .claude/hooks/guard.sh',
						},
					],
				},
			],
		},
	};
}
