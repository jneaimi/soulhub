/** Task-type registry.
 *
 *  Two-layer registration model:
 *    1. **Code** declares task TYPES via `registerTaskHandler` — each
 *       handler owns the logic for turning typed `params` into an
 *       executable function.
 *    2. **Settings** declares task INSTANCES — `{id, type, cron,
 *       params, …}` — pointing at a registered type by slug.
 *
 *  At reconcile time, the lifecycle module walks the settings list and
 *  resolves each entry's `type` to a handler factory; tasks whose
 *  type isn't registered are skipped with a warning (so a settings
 *  entry that references an unbuilt task type doesn't kill the
 *  scheduler — useful during incremental rollout).
 *
 *  Phase 2 ships the registry empty. Phase 3 lands the first handler
 *  (`shell-script`) for the project-hygiene migration.
 */

/** Optional context the runner threads into each invocation. `signal`
 *  fires when `killRun(taskId)` is called — handlers that wrap external
 *  resources (subprocesses, fetch calls) should listen for it and bail
 *  early. Older handlers that ignore the signal still work; the run will
 *  complete naturally, but `killRun` returns immediately and the run's
 *  output is recorded as `error: cancelled by user` once it settles. */
export interface TaskCtx {
	signal: AbortSignal;
}

export type TaskFn = (ctx?: TaskCtx) => Promise<unknown> | unknown;
export type TaskFactory = (params: unknown) => TaskFn;

export interface TaskHandler {
	type: string;
	factory: TaskFactory;
	description?: string;
}

const handlers = new Map<string, TaskHandler>();

export function registerTaskHandler(
	type: string,
	factory: TaskFactory,
	description?: string,
): void {
	if (handlers.has(type)) {
		throw new Error(`Task handler already registered: ${type}`);
	}
	handlers.set(type, { type, factory, description });
	console.log(`[scheduler] task-handler registered: ${type}`);
}

export function getTaskHandler(type: string): TaskHandler | null {
	return handlers.get(type) ?? null;
}

export function listTaskTypes(): string[] {
	return Array.from(handlers.keys()).sort();
}

/** Test-only helper. Clears all registered handlers. Do not call from
 *  production code paths. */
export function _resetTaskHandlersForTests(): void {
	handlers.clear();
}
