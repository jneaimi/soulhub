import { apiGet } from '../api.ts';
import { emit, type OutputOpts } from '../output.ts';

interface MetricsResp {
  ok?: boolean;
  period?: { fromMs?: number; toMs?: number; days?: number };
  gates?: Record<string, boolean | number | string>;
  sourceCounts?: Record<string, number>;
  routeCounts?: Array<{ route: string; n: number }>;
}

function fmtDay(ms: number | undefined): string {
  if (!ms) return '?';
  return new Date(ms).toISOString().slice(0, 10);
}

export async function metrics(_args: Record<string, string | undefined>, opts: OutputOpts) {
  const d = await apiGet<MetricsResp>('/api/intent/metrics');
  emit(d, opts, (m: MetricsResp) => {
    const lines: string[] = [];
    if (m.period) {
      lines.push(`Window: ${fmtDay(m.period.fromMs)} → ${fmtDay(m.period.toMs)}  (${m.period.days ?? '?'}d)`);
    }
    if (m.gates) {
      lines.push('Gates:');
      for (const [k, v] of Object.entries(m.gates)) lines.push(`  ${k.padEnd(20)} ${v}`);
    }
    if (m.sourceCounts) {
      lines.push('Sources:');
      for (const [k, v] of Object.entries(m.sourceCounts)) lines.push(`  ${k.padEnd(20)} ${v}`);
    }
    if (m.routeCounts && m.routeCounts.length > 0) {
      lines.push('Top routes:');
      for (const r of m.routeCounts.slice(0, 10)) {
        lines.push(`  ${String(r.n).padStart(5)}  ${r.route}`);
      }
    }
    return lines.length === 0 ? '(no metrics)' : lines.join('\n');
  });
}
