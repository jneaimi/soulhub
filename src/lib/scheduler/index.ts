/** Soul Hub Scheduler — domain-agnostic task registry.
 *
 *  Public surface for Phase 1. Settings.json wiring, hot-reload, and
 *  catchup-on-boot land in Phase 2 (see
 *  `vault/projects/soul-hub-scheduler/`).
 */

export {
	register,
	unregister,
	list,
	getTask,
	runNow,
	killRun,
	isTaskRunning,
	destroyAllTasks,
	SchedulerError,
	type Task,
	type TaskInfo,
} from './registry.js';

export {
	recordRun,
	type RecordRunOptions,
	type RecordRunResult,
} from './runner.js';

export {
	hasActiveRun,
	lastSuccessfulRun,
	runHistory,
	type RunRow,
	type RunStatus,
} from './db.js';

export {
	registerTaskHandler,
	getTaskHandler,
	listTaskTypes,
	_resetTaskHandlersForTests,
	type TaskFn,
	type TaskFactory,
	type TaskHandler,
} from './task-types.js';

export {
	sweepStaleStartedRows,
	type SweepResult,
} from './sweep.js';

export {
	applyCatchupOnBoot,
	catchupTask,
	type CatchupOutcome,
} from './catchup.js';

export {
	initSchedulerCore,
	reconcileFromSettings,
	shutdownScheduler,
	_resetLifecycleForTests,
	type InitResult,
	type ReconcileResult,
} from './lifecycle.js';
