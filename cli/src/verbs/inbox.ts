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

interface InboxAccount {
  id: string;
  email: string;
  provider?: string;
  status?: string;
  lastSync?: number | null;
  lastError?: string | null;
  label?: string;
  host?: string;
  port?: number;
  [k: string]: unknown;
}
interface AccountsResp { accounts: InboxAccount[] }

// ADR-005 — an account is stale when connected but its last sync is older
// than this. 30 min spans two missed 5-min polls + slack.
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

/** Short relative age for sync timestamps — finer than ageDays. */
function ageShort(epochMs: number | null | undefined): string {
  if (!epochMs) return 'never';
  const ms = Date.now() - epochMs;
  if (ms < 0) return '0s ago';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** ADR-005 — read-only account listing over /api/inbox/accounts. */
export async function accounts(_args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<AccountsResp>('/api/inbox/accounts');
  emit(data, opts, (d: AccountsResp) => {
    if (d.accounts.length === 0) return '(no accounts)';
    return d.accounts
      .map((a) => {
        const email = (a.email ?? a.label ?? a.id).padEnd(28);
        const provider = (a.provider ?? '?').padEnd(8);
        const status = (a.status ?? '?').padEnd(10);
        const age = ageShort(a.lastSync).padEnd(9);
        const err = a.lastError ? `  err: ${a.lastError}` : '';
        return `${email}  ${provider}  ${status}  ${age}${err}`;
      })
      .join('\n');
  });
}

/** ADR-005 — derived sync-health summary. Exits 1 if any connected account
 *  is stale so it composes in `&&` health checks. */
export async function status(_args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<AccountsResp>('/api/inbox/accounts');
  const now = Date.now();
  const rows = data.accounts.map((a) => {
    const lastSync = a.lastSync ?? null;
    const ageMs = lastSync ? now - lastSync : null;
    const stale = a.status === 'connected' && ageMs !== null && ageMs > STALE_THRESHOLD_MS;
    return { id: a.id, email: a.email ?? a.label ?? a.id, status: a.status ?? '?', lastSync, ageMs, stale };
  });
  const stale_count = rows.filter((r) => r.stale).length;
  const healthy_count = rows.length - stale_count;

  emit({ accounts: rows, stale_count, healthy_count }, opts, () => {
    const lines = rows.map((r) => {
      const marker = r.stale ? '⚠ STALE' : '✓';
      const age = ageShort(r.lastSync);
      return `${marker.padEnd(8)} ${(r.email ?? r.id).padEnd(28)}  ${r.status.padEnd(10)}  ${age}`;
    });
    lines.push('');
    lines.push(`${healthy_count}/${rows.length} healthy`);
    return lines.join('\n');
  });

  if (stale_count > 0) process.exit(1);
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
