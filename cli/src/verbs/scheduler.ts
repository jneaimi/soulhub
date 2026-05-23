import { apiGet, apiPost } from '../api.ts';
import { emit, fail, type OutputOpts } from '../output.ts';

interface SchedTask {
  id?: string;
  name?: string;
  cron?: string;
  enabled?: boolean;
  lastRun?: string | number | null;
  nextRun?: string | number | null;
  lastStatus?: string | null;
}
interface TasksResp { tasks: SchedTask[]; }

export async function tasks(_args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<TasksResp>('/api/scheduler/tasks');
  emit(data, opts, (d: TasksResp) =>
    d.tasks.length === 0
      ? '(no scheduler tasks)'
      : d.tasks
          .map((t) => {
            const en = t.enabled === false ? 'off' : 'on ';
            const name = (t.name ?? t.id ?? '').padEnd(34);
            const cron = (t.cron ?? '').padEnd(18);
            const next = String(t.nextRun ?? '—');
            return `${en}  ${name} ${cron} next=${next} last=${t.lastStatus ?? '—'}`;
          })
          .join('\n')
  );
}

/** ADR-003 Phase 3a — fire a registered scheduler task immediately.
 *  POST /api/scheduler/run-now, body { taskId }. */
interface RunNowResp {
  ok: boolean;
  status?: string;
  durationMs?: number;
  output?: unknown;
  error?: string;
}

export async function runNow(args: Record<string, string | undefined>, opts: OutputOpts) {
  const taskId = args._;
  if (!taskId) fail('scheduler run-now: missing TASK_ID (e.g. soul scheduler run-now peer-brief-daily-naseej)');

  if (args['dry-run']) {
    emit(
      { dryRun: true, method: 'POST', path: '/api/scheduler/run-now', body: { taskId } },
      opts,
      (d: any) => `DRY RUN — POST /api/scheduler/run-now\n  taskId=${d.body.taskId}`,
    );
    return;
  }

  const data = await apiPost<RunNowResp>('/api/scheduler/run-now', { taskId });
  emit(data, opts, (d: RunNowResp) => {
    if (!d.ok) return `✗ ${d.error ?? 'run-now failed'}`;
    const lines = [
      `✓ ${taskId}`,
      `Status:   ${d.status ?? '—'}`,
      d.durationMs !== undefined ? `Duration: ${d.durationMs}ms` : '',
    ].filter(Boolean);
    return lines.join('\n');
  });
  if (!data.ok) process.exit(1);
}
