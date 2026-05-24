import { apiGet, apiPost, apiPatch, ApiError } from '../api.ts';
import { emit, fail, withCanonical, type OutputOpts } from '../output.ts';

interface Contact {
  id: string;
  displayName: string;
  company?: string | null;
  role?: string | null;
  stage?: string | null;
  nextFollowupAt?: string | null;
  vaultNotePath?: string | null;
}
interface ContactsResp { mode: string; contacts: Contact[]; total: number; }

export async function find(args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<ContactsResp>('/api/crm/contacts', {
    search: args.q,
    stage: args.stage,
    limit: args.limit ?? '20',
  });
  emit(withCanonical(data, 'contacts'), opts, (d: ContactsResp) =>
    d.contacts.length === 0
      ? '(no contacts)'
      : d.contacts
          .map((c) => `${c.id.padEnd(12)} ${(c.displayName ?? '').padEnd(28)} ${(c.stage ?? '—').padEnd(16)} ${c.company ?? ''}`)
          .join('\n')
  );
}

interface FollowupsResp { overdue: any[]; upcoming: any[]; }

export async function followups(_args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<FollowupsResp>('/api/crm/followups');
  emit(data, opts, (d: FollowupsResp) => {
    const lines: string[] = [];
    if (d.overdue.length > 0) {
      lines.push('Overdue:');
      for (const f of d.overdue) lines.push(`  ${(f.dueAt ?? '').padEnd(12)} ${f.contactId ?? ''} ${f.note ?? ''}`);
    }
    if (d.upcoming.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Upcoming:');
      for (const f of d.upcoming) lines.push(`  ${(f.dueAt ?? '').padEnd(12)} ${f.contactId ?? ''} ${f.note ?? ''}`);
    }
    return lines.length === 0 ? '(no follow-ups)' : lines.join('\n');
  });
}

// ─── ADR-010: write verbs ────────────────────────────────────────────────────
// All writes pipe to the SAME /api/crm/* endpoints the chat orchestrator tools
// call (ADR-001 dumb-pipe). The server is authoritative for enum/dedup/existence
// checks; the thin client-side guards below only catch typos before a no-op
// round-trip and never *accept* anything the server would reject. No `crm rm`
// (DELETE) by design — the CLI keeps its zero-destructive-delete invariant.

// Mirror of src/lib/crm/types.ts (kept thin; server stays authoritative).
const STAGES = ['Lead', 'Contacted', 'In Conversation', 'Proposal', 'Won', 'Lost'];
const CHANNELS = ['email', 'call', 'meeting', 'social', 'whatsapp', 'other'];
const DIRECTIONS = ['inbound', 'outbound'];
const NOTE_KINDS = ['transcript', 'document', 'reference', 'other'];

interface CrmWriteResp { id?: string; displayName?: string; contact?: any; changed?: boolean; nextFollowupAt?: number | null; note?: string; vaultPath?: string; syncPath?: string; error?: string; }

/** Execute a CRM write, surfacing the endpoint's `{error}` (HTTP 4xx, no
 *  `success` envelope → apiPost throws ApiError) as a clean `✗` + exit 1. */
async function crmWrite(call: () => Promise<CrmWriteResp>, ok: (d: CrmWriteResp) => string, opts: OutputOpts): Promise<void> {
  let data: CrmWriteResp;
  try {
    data = await call();
  } catch (err) {
    if (err instanceof ApiError) {
      let msg = err.body;
      try { const p = JSON.parse(err.body); if (p && typeof p.error === 'string') msg = p.error; } catch { /* keep raw body */ }
      emit({ success: false, status: err.status, error: msg }, opts, () => `✗ ${msg}`);
      process.exit(1);
    }
    throw err;
  }
  emit(data, opts, ok);
}

function dryRun(method: string, path: string, body: unknown, opts: OutputOpts): void {
  emit({ dryRun: true, method, path, body }, opts, (d: any) =>
    `DRY RUN — ${d.method} ${d.path}\nBody:\n${JSON.stringify(d.body, null, 2).split('\n').map((l) => '  ' + l).join('\n')}`,
  );
}

function requireId(args: Record<string, string | undefined>, verb: string, extra = ''): string {
  const id = args._0;
  if (!id) fail(`crm ${verb}: usage: soul crm ${verb} <contact-id>${extra}`);
  return id as string;
}

/** YYYY-MM-DD → epoch ms at LOCAL midnight (matches how the CRM UI reads dates). */
function dateToEpoch(s: string, verb: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) fail(`crm ${verb}: date must be YYYY-MM-DD (got "${s}")`);
  return new Date(Number(m![1]), Number(m![2]) - 1, Number(m![3])).getTime();
}

export async function add(args: Record<string, string | undefined>, opts: OutputOpts) {
  if (!args.name) fail('crm add: --name is required');
  if (args.stage && !STAGES.includes(args.stage)) fail(`crm add: --stage must be one of ${STAGES.join(', ')}`);
  const body: Record<string, unknown> = { displayName: args.name };
  if (args.company) body.company = args.company;
  if (args.role) body.role = args.role;
  if (args.stage) body.stage = args.stage;
  if (args.source) body.source = args.source;
  if (args['deal-type']) body.dealType = args['deal-type'];
  if (args['deal-currency']) body.dealCurrency = args['deal-currency'];
  if (args.notes) body.notes = args.notes;
  if (args['deal-value'] !== undefined) {
    const n = Number.parseFloat(args['deal-value']);
    if (!Number.isFinite(n)) fail(`crm add: --deal-value must be a number (got "${args['deal-value']}")`);
    body.dealValue = n;
  }
  if (args.email) body.emails = [{ email: args.email, isPrimary: true }];
  if (args.phone) body.phones = [{ phone: args.phone, isPrimary: true }];

  if (args['dry-run']) return dryRun('POST', '/api/crm/contacts', body, opts);
  await crmWrite(() => apiPost<CrmWriteResp>('/api/crm/contacts', body), (d) =>
    `✓ added ${d.id ?? '?'} ${d.displayName ?? args.name}${d.syncPath ? `\n  vault: ${d.syncPath}` : ''}`, opts);
}

export async function stage(args: Record<string, string | undefined>, opts: OutputOpts) {
  const id = requireId(args, 'stage', ' <stage> [--reason "..."]');
  const stageVal = args._1;
  if (!stageVal) fail(`crm stage: missing <stage>. One of: ${STAGES.join(', ')}`);
  if (!STAGES.includes(stageVal)) fail(`crm stage: stage must be one of ${STAGES.join(', ')} (got "${stageVal}")`);
  const body: Record<string, unknown> = { stage: stageVal };
  if (args.reason) body.reason = args.reason;

  if (args['dry-run']) return dryRun('POST', `/api/crm/contacts/${id}/stage`, body, opts);
  await crmWrite(() => apiPost<CrmWriteResp>(`/api/crm/contacts/${id}/stage`, body), (d) =>
    d.changed === false ? `· stage unchanged (${stageVal})` : `✓ ${id} → ${stageVal}`, opts);
}

export async function followup(args: Record<string, string | undefined>, opts: OutputOpts) {
  const id = requireId(args, 'followup', ' (--due YYYY-MM-DD | --in <Nd> | --clear)');
  let dueAt: number | null;
  if (args.clear) {
    dueAt = null;
  } else if (args.due) {
    dueAt = dateToEpoch(args.due, 'followup');
  } else if (args.in !== undefined) {
    const m = /^(\d+)d?$/.exec(args.in.trim());
    if (!m) fail(`crm followup: --in must be like "3d" or "3" (got "${args.in}")`);
    dueAt = Date.now() + Number(m![1]) * 86_400_000;
  } else {
    fail('crm followup: one of --due YYYY-MM-DD | --in <Nd> | --clear is required');
  }
  const body = { dueAt: dueAt! };

  if (args['dry-run']) return dryRun('POST', `/api/crm/contacts/${id}/followup`, body, opts);
  await crmWrite(() => apiPost<CrmWriteResp>(`/api/crm/contacts/${id}/followup`, body), (d) =>
    d.nextFollowupAt == null
      ? `✓ ${id} follow-up cleared`
      : `✓ ${id} follow-up set ${new Date(d.nextFollowupAt).toISOString().slice(0, 10)}`, opts);
}

export async function log(args: Record<string, string | undefined>, opts: OutputOpts) {
  const id = requireId(args, 'log', ' --channel <c> --summary "..." [--direction inbound|outbound] [--at YYYY-MM-DD]');
  if (!args.channel) fail(`crm log: --channel is required. One of: ${CHANNELS.join(', ')}`);
  if (!CHANNELS.includes(args.channel)) fail(`crm log: --channel must be one of ${CHANNELS.join(', ')} (got "${args.channel}")`);
  if (!args.summary) fail('crm log: --summary is required');
  if (args.direction && !DIRECTIONS.includes(args.direction)) fail(`crm log: --direction must be one of ${DIRECTIONS.join(', ')}`);
  const body: Record<string, unknown> = { channel: args.channel, summary: args.summary };
  if (args.direction) body.direction = args.direction;
  if (args.at) body.timestamp = dateToEpoch(args.at, 'log');

  if (args['dry-run']) return dryRun('POST', `/api/crm/contacts/${id}/interactions`, body, opts);
  await crmWrite(() => apiPost<CrmWriteResp>(`/api/crm/contacts/${id}/interactions`, body), () =>
    `✓ logged ${args.channel} interaction on ${id}`, opts);
}

export async function note(args: Record<string, string | undefined>, opts: OutputOpts) {
  const id = requireId(args, 'note', ' <vault-path> [--kind K] [--label "..."] [--source-url URL]');
  const vaultPath = args._1;
  if (!vaultPath) fail('crm note: missing <vault-path> (the note must already exist in the vault)');
  if (args.kind && !NOTE_KINDS.includes(args.kind)) fail(`crm note: --kind must be one of ${NOTE_KINDS.join(', ')}`);
  const body: Record<string, unknown> = { vaultPath };
  if (args.kind) body.kind = args.kind;
  if (args.label) body.label = args.label;
  if (args['source-url']) body.sourceUrl = args['source-url'];

  if (args['dry-run']) return dryRun('POST', `/api/crm/contacts/${id}/notes`, body, opts);
  await crmWrite(() => apiPost<CrmWriteResp>(`/api/crm/contacts/${id}/notes`, body), () =>
    `✓ attached ${vaultPath} to ${id}`, opts);
}

// ─── Phase 2: identity edits ─────────────────────────────────────────────────

export async function update(args: Record<string, string | undefined>, opts: OutputOpts) {
  const id = requireId(args, 'update', ' [--name ...] [--company ...] [--role ...] [--deal-type ...] [--deal-value N] [--notes ...] [--source ...]');
  const body: Record<string, unknown> = {};
  if (args.name) body.displayName = args.name;
  if (args.company !== undefined) body.company = args.company;
  if (args.role !== undefined) body.role = args.role;
  if (args['deal-type'] !== undefined) body.dealType = args['deal-type'];
  if (args['deal-currency'] !== undefined) body.dealCurrency = args['deal-currency'];
  if (args.notes !== undefined) body.notes = args.notes;
  if (args.source !== undefined) body.source = args.source;
  if (args['deal-value'] !== undefined) {
    const n = Number.parseFloat(args['deal-value']);
    if (!Number.isFinite(n)) fail(`crm update: --deal-value must be a number (got "${args['deal-value']}")`);
    body.dealValue = n;
  }
  if (Object.keys(body).length === 0) fail('crm update: nothing to update — pass at least one field flag');

  if (args['dry-run']) return dryRun('PATCH', `/api/crm/contacts/${id}`, body, opts);
  await crmWrite(() => apiPatch<CrmWriteResp>(`/api/crm/contacts/${id}`, body), () =>
    `✓ updated ${id}`, opts);
}

export async function email(args: Record<string, string | undefined>, opts: OutputOpts) {
  const id = requireId(args, 'email', ' <address> [--label L] [--primary]');
  const address = args._1;
  if (!address) fail('crm email: missing <address>');
  const body: Record<string, unknown> = { email: address, isPrimary: !!args.primary };
  if (args.label) body.label = args.label;

  if (args['dry-run']) return dryRun('POST', `/api/crm/contacts/${id}/emails`, body, opts);
  await crmWrite(() => apiPost<CrmWriteResp>(`/api/crm/contacts/${id}/emails`, body), () =>
    `✓ added email ${address} to ${id}${args.primary ? ' (primary)' : ''}`, opts);
}

export async function phone(args: Record<string, string | undefined>, opts: OutputOpts) {
  const id = requireId(args, 'phone', ' <number> [--label L] [--primary]');
  const number = args._1;
  if (!number) fail('crm phone: missing <number>');
  const body: Record<string, unknown> = { phone: number, isPrimary: !!args.primary };
  if (args.label) body.label = args.label;

  if (args['dry-run']) return dryRun('POST', `/api/crm/contacts/${id}/phones`, body, opts);
  await crmWrite(() => apiPost<CrmWriteResp>(`/api/crm/contacts/${id}/phones`, body), () =>
    `✓ added phone ${number} to ${id}${args.primary ? ' (primary)' : ''}`, opts);
}
