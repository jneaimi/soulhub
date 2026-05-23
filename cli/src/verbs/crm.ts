import { apiGet } from '../api.ts';
import { emit, type OutputOpts } from '../output.ts';

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
  emit(data, opts, (d: ContactsResp) =>
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
