/** Shared workspace types and data-loading functions.
 *
 *  A "workspace" is a code-repo directory under ~/dev/ that the operator
 *  works on with Claude Code. Markers live as `.soul-hub.json` files at the
 *  project root. Renamed from `projects` per ADR-037 to free the `/projects`
 *  surface for vault-tracked managed initiatives. */

export interface Workspace {
	name: string;
	devPath: string | null;
	lastModified: string;
	type: string;
	hasGit: boolean;
	description: string;
}

export interface Suggestion {
	name: string;
	path: string;
	hasGit: boolean;
	hasClaude: boolean;
}

export interface GitBranchInfo {
	branch: string;
	dirty: boolean;
}

/** Load workspaces and suggestions from API */
export async function fetchWorkspaces(): Promise<{ workspaces: Workspace[]; suggestions: Suggestion[] }> {
	const res = await fetch('/api/workspaces');
	if (!res.ok) throw new Error(`Failed to load workspaces: ${res.status}`);
	const data = await res.json();
	// API still returns `projects` key for backwards compatibility — alias here.
	return { workspaces: data.projects ?? data.workspaces ?? [], suggestions: data.suggestions || [] };
}

/** Fetch git branch info for workspaces with git repos, max 5 concurrent */
export async function fetchGitBranches(workspaces: Workspace[]): Promise<Record<string, GitBranchInfo>> {
	const gitWorkspaces = workspaces.filter(w => w.hasGit && w.devPath);
	const branches: Record<string, GitBranchInfo> = {};

	for (let i = 0; i < gitWorkspaces.length; i += 5) {
		const batch = gitWorkspaces.slice(i, i + 5);
		const results = await Promise.allSettled(
			batch.map(async (w) => {
				const res = await fetch(`/api/git?path=${encodeURIComponent(w.devPath!)}`);
				if (!res.ok) return null;
				const d = await res.json();
				if (d?.isGit && d.branch) {
					return { name: w.name, branch: d.branch, dirty: d.dirty };
				}
				return null;
			})
		);
		for (const result of results) {
			if (result.status === 'fulfilled' && result.value) {
				branches[result.value.name] = { branch: result.value.branch, dirty: result.value.dirty };
			}
		}
	}
	return branches;
}

/** Register a folder as a managed workspace */
export async function addWorkspaceApi(path: string): Promise<boolean> {
	const res = await fetch('/api/workspaces', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ path }),
	});
	return res.ok;
}

/** Unregister a managed workspace */
export async function removeWorkspaceApi(path: string): Promise<boolean> {
	const res = await fetch('/api/workspaces', {
		method: 'DELETE',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ path }),
	});
	return res.ok;
}

/** Format an ISO timestamp as relative time */
export function timeAgo(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
