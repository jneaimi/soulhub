// ADR-003 Phase 3a — inbox surface: queued messages + manual digest trigger.
// Thin wrappers over /api/inbox/messages + /api/inbox/digest-telegram.

import { apiGet, apiPost } from '../api.ts';
import { emit, fail, type OutputOpts } from '../output.ts';

interface InboxMessage {
  id: number;
  account_id?: string;
  date_received?: number;
  subject?: string;
  from?: string;
  process_status?: string;
  category?: string;
  [k: string]: unknown;
}
interface InboxStats { queued?: number; total?: number; processed?: number; new?: number }
interface MessagesResp { messages: InboxMessage[]; total: number; stats?: InboxStats }

/** Queued = process_status='queued'. ADR-003 v1 maps `soul inbox queued`
 *  to GET /api/inbox/messages?status=queued (no /api/inbox/queued endpoint
 *  exists; the v1 ADR misnamed the route). */
export async function queued(args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<MessagesResp>('/api/inbox/messages', {
    status: 'queued',
    limit: args.limit ?? '50',
    account: args.account,
  });
  emit(data, opts, (d: MessagesResp) => {
    const s = d.stats ?? {};
    const head = `Queued: ${d.total ?? d.messages.length}    (total queued in stats: ${s.queued ?? '—'})`;
    if (d.messages.length === 0) return `${head}\n\n(no messages)`;
    const rows = d.messages.map((m) => {
      const id = String(m.id).padStart(5);
      const subj = (m.subject ?? '(no subject)').slice(0, 60).padEnd(60);
      const from = (m.from ?? '').slice(0, 28);
      return `${id}  ${subj}  ${from}`;
    });
    return [head, '', ...rows].join('\n');
  });
}

interface DigestResp {
  ok: boolean;
  sent?: number;
  skipped?: number;
  error?: string;
  [k: string]: unknown;
}

/** ADR-044 manual trigger. POST /api/inbox/digest-telegram with optional
 *  body { since, accounts, categories, ... } that the handler forwards
 *  unchanged. v1 CLI exposes --since (epoch ms) and --inputs-json escape. */
export async function digestTelegram(args: Record<string, string | undefined>, opts: OutputOpts) {
  let body: Record<string, unknown> = {};
  if (args.since) body.since = Number(args.since);
  if (args['inputs-json']) {
    try {
      const merged = JSON.parse(args['inputs-json']);
      if (typeof merged !== 'object' || merged === null) {
        fail('inbox digest-telegram: --inputs-json must be a JSON object');
      }
      body = { ...body, ...(merged as Record<string, unknown>) };
    } catch (err) {
      fail(`inbox digest-telegram: --inputs-json invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (args['dry-run']) {
    emit({ dryRun: true, method: 'POST', path: '/api/inbox/digest-telegram', body }, opts, (d: any) =>
      `DRY RUN — POST /api/inbox/digest-telegram\nBody:\n${JSON.stringify(d.body, null, 2).split('\n').map((l) => '  ' + l).join('\n')}`,
    );
    return;
  }

  const data = await apiPost<DigestResp>('/api/inbox/digest-telegram', body);
  emit(data, opts, (d: DigestResp) =>
    d.ok
      ? `✓ digest fired  sent=${d.sent ?? '?'} skipped=${d.skipped ?? '?'}`
      : `✗ ${d.error ?? 'digest failed'}`,
  );
  if (!data.ok) process.exit(1);
}
