import type { PlaybookInput, PlaybookRun, RunStatus } from './types.js';

export interface PlaybookChainNode {
	id: string;
	/** Name of playbook directory in playbooks/ */
	playbook: string;
	/** Map chain inputs/node outputs to playbook inputs */
	inputs?: Record<string, string | number>;
	/** Nodes that must complete before this one */
	depends_on?: string[];
	/** Condition: only run when expression is true */
	when?: string;
	/** Condition: skip when expression is true */
	skip_if?: string;
	/** Gate: require approval before this node runs */
	gate?: 'approval';
}

export interface PlaybookChainSpec {
	name: string;
	description: string;
	type: 'playbook-chain';
	inputs?: PlaybookInput[];
	nodes: PlaybookChainNode[];
	on_failure?: {
		strategy?: 'halt' | 'halt-branch' | 'skip-dependents';
	};
}

export type ChainNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PlaybookChainNodeRun {
	id: string;
	playbookName: string;
	status: ChainNodeStatus;
	startedAt?: string;
	completedAt?: string;
	durationMs?: number;
	error?: string;
	/** The inner playbook run (full phase-level detail) */
	playbookRun?: PlaybookRun;
}

export interface PlaybookChainRun {
	runId: string;
	chainName: string;
	type: 'playbook-chain';
	status: RunStatus;
	startedAt: string;
	completedAt?: string;
	nodes: PlaybookChainNodeRun[];
	resolvedInputs: Record<string, string | number>;
}
