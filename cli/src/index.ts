// Soul Hub CLI entry — ADR-001 + ADR-002 (soul-hub-cli), Phase 1 + Phase 2.
// Dispatch shape: soul <noun> <verb> [args]. Dumb pipe to /api/*.

import { parseArgs } from 'node:util';
import { fail, type OutputOpts } from './output.ts';
import * as vault from './verbs/vault.ts';
import * as project from './verbs/project.ts';
import * as adr from './verbs/adr.ts';
import * as crm from './verbs/crm.ts';
import * as scheduler from './verbs/scheduler.ts';
import * as intent from './verbs/intent.ts';
import * as note from './verbs/note.ts';
import * as naseej from './verbs/naseej.ts';
import * as inbox from './verbs/inbox.ts';
import * as contracts from './verbs/contracts.ts';
import { catalogIndex } from './verbs/catalog.ts';
import { doctor } from './verbs/doctor.ts';

const HELP = `soul — Soul Hub CLI (ADR-001 + ADR-002 + ADR-003 Phase 3a)

READ VERBS
  soul vault search [-q QUERY] [--zone Z] [--project P] [--type T] [--limit N]
  soul vault get   PATH
  soul vault recent [--limit N]
  soul vault hygiene
  soul vault writes [--limit N] [--agent A] [--actor-prefix P] [--zone Z]
  soul vault unresolved
  soul project list
  soul project get   SLUG
  soul project graph [--format json|adjacency-list|dot]
  soul project edges SLUG [--format json|adjacency-list]
  soul project next-actions SLUG [--limit N]
  soul project worklist SLUG    [--json]
  soul project similar --slug NEWSLUG [--title T] [--description D]
  soul adr list   --project SLUG [--status STATUS]
  soul recipe list [--project P] [-q QUERY]
  soul recipe get SLUG
  soul component list [--category C] [--runtime R] [-q QUERY]
  soul component get SLUG
  soul naseej audit [--type runs|publishes] [--limit N] [--recipe R] [--status S]
  soul catalog index [--freshness]
  soul crm find   [-q QUERY] [--stage S] [--limit N]
  soul crm followups
  soul scheduler tasks
  soul inbox queued [--limit N] [--account A]
  soul inbox accounts                 (email accounts + sync age)
  soul inbox status                   (sync-health summary; exits 1 if any account stale)
  soul intent metrics
  soul contracts touching PATH        (governance ADR-002 — what contracts a change touches)
  soul contracts check                (registry self-falsifier: resolution + cache freshness)
  soul doctor

WRITE VERBS (each supports --dry-run)
  soul note create   --zone Z --filename F --type T [--meta-json JSON] (--content STR | --content-file PATH | --content -)
  soul note update   PATH [--meta-json JSON] [--content STR | --content-file PATH | --content -]
  soul project create --slug S [--parent P] [--title T] [--meta-json JSON]
  soul project label-shape SLUG --shape SHAPE
  soul project label-falsifier SLUG --on YYYY-MM-DD [--text TEXT]
  soul project propose-adr SLUG --input-json '{...}' (or --title T --tier "Tier 2" --problem STR)
  soul project ship-slice SLUG --adr X --slice S<N> --status STATUS [--commit SHA]
  soul vault reindex
  soul adr propose   --project P --slug S --title T (--content STR | --content-file PATH | --content -) [--meta-json JSON]
  soul adr accept    PATH
  soul adr ship      PATH
  soul adr park      PATH --review-after YYYY-MM-DD
  soul adr reject    PATH --reason "..."
  soul recipe run SLUG [--mode test|production|oneshot] [--input k=v] [--inputs-json '{...}'] [--run-id ID]
  soul recipe cancel RUN_ID
  soul scheduler run-now TASK_ID
  soul inbox digest-telegram [--since EPOCH_MS] [--inputs-json '{...}']

GLOBAL FLAGS
  --json     Emit raw API JSON (composable with jq).
  --base URL Override Soul Hub URL (default http://localhost:2400 or $SOUL_HUB_URL).
  --dry-run  (write verbs only) print the request body without calling the API.
  --help | -h | --version | -V

EXAMPLES
  soul vault hygiene --json | jq '.totals'
  soul project next-actions naseej
  soul catalog index --json | jq '.components."shell-exec".used_by_recipes'
  soul catalog index --freshness
  soul recipe run peer-brief-v2 --mode test
  soul scheduler run-now peer-brief-daily-naseej
  soul project propose-adr naseej --input-json "$(cat my-adr.json)" --dry-run

Backed by the Soul Hub HTTP API. Governance + chokepoints (ADR-046/047/048/050)
fire at the API layer; this CLI is a dumb pipe. Errors surface verbatim.
`;

// Per-verb usage lines, keyed by "<noun> <verb>" (matching the dispatch table)
// plus the top-level "doctor". Sourced verbatim from the corresponding HELP line
// so per-verb --help and the full HELP stay consistent. (ADR-007)
const USAGE: Record<string, string> = {
  'vault search': 'soul vault search [-q QUERY] [--zone Z] [--project P] [--type T] [--limit N]',
  'vault get': 'soul vault get   PATH',
  'vault recent': 'soul vault recent [--limit N]',
  'vault hygiene': 'soul vault hygiene',
  'vault reindex': 'soul vault reindex',
  'vault writes': 'soul vault writes [--limit N] [--agent A] [--actor-prefix P] [--zone Z]',
  'vault unresolved': 'soul vault unresolved',
  'project list': 'soul project list',
  'project get': 'soul project get   SLUG',
  'project graph': 'soul project graph [--format json|adjacency-list|dot]',
  'project edges': 'soul project edges SLUG [--format json|adjacency-list]',
  'project create': 'soul project create --slug S [--parent P] [--title T] [--meta-json JSON]',
  'project label-shape': 'soul project label-shape SLUG --shape SHAPE',
  'project label-falsifier': 'soul project label-falsifier SLUG --on YYYY-MM-DD [--text TEXT]',
  'project next-actions': 'soul project next-actions SLUG [--limit N]',
  'project worklist': 'soul project worklist SLUG    [--json]',
  'project similar': 'soul project similar --slug NEWSLUG [--title T] [--description D]',
  'project propose-adr': `soul project propose-adr SLUG --input-json '{...}' (or --title T --tier "Tier 2" --problem STR)`,
  'project ship-slice': 'soul project ship-slice SLUG --adr X --slice S<N> --status STATUS [--commit SHA]',
  'adr list': 'soul adr list   --project SLUG [--status STATUS]',
  'adr propose': 'soul adr propose   --project P --slug S --title T --content STR [--meta-json JSON]',
  'adr accept': 'soul adr accept    PATH',
  'adr ship': 'soul adr ship      PATH',
  'adr park': 'soul adr park      PATH --review-after YYYY-MM-DD',
  'adr reject': 'soul adr reject    PATH --reason "..."',
  'recipe list': 'soul recipe list [--project P] [-q QUERY]',
  'recipe get': 'soul recipe get SLUG',
  'recipe run': `soul recipe run SLUG [--mode test|production|oneshot] [--input k=v] [--inputs-json '{...}'] [--run-id ID]`,
  'recipe cancel': 'soul recipe cancel RUN_ID',
  'component list': 'soul component list [--category C] [--runtime R] [-q QUERY]',
  'component get': 'soul component get SLUG',
  'naseej audit': 'soul naseej audit [--type runs|publishes] [--limit N] [--recipe R] [--status S]',
  'catalog index': 'soul catalog index [--freshness]',
  'crm find': 'soul crm find   [-q QUERY] [--stage S] [--limit N]',
  'crm followups': 'soul crm followups',
  'scheduler tasks': 'soul scheduler tasks',
  'scheduler run-now': 'soul scheduler run-now TASK_ID',
  'inbox queued': 'soul inbox queued [--limit N] [--account A]',
  'inbox digest-telegram': `soul inbox digest-telegram [--since EPOCH_MS] [--inputs-json '{...}']`,
  'intent metrics': 'soul intent metrics',
  'note create': 'soul note create   --zone Z --filename F --type T [--meta-json JSON] --content STR',
  'note update': 'soul note update   PATH [--meta-json JSON] [--content STR]',
  'contracts touching': 'soul contracts touching PATH        (governance ADR-002 — what contracts a change touches)',
  'contracts check': 'soul contracts check                (registry self-falsifier: resolution + cache freshness)',
  doctor: 'soul doctor',
};

function isHelpFlag(s: string | undefined): boolean {
  return s === '-h' || s === '--help';
}

// Print every usage line belonging to a noun (for `soul <noun> --help`).
// Falls back to full HELP if the noun has no registered verbs.
function printNounUsage(noun: string): void {
  const prefix = `${noun} `;
  const lines = Object.keys(USAGE)
    .filter((k) => k.startsWith(prefix))
    .map((k) => USAGE[k]);
  process.stdout.write(lines.length > 0 ? lines.join('\n') + '\n' : HELP);
}

type Verb = (args: Record<string, string | undefined>, opts: OutputOpts) => Promise<void>;
interface Dispatch { [noun: string]: { [verb: string]: Verb }; }

const dispatch: Dispatch = {
  vault:     { search: vault.search, get: vault.get, recent: vault.recent, hygiene: vault.hygiene, reindex: vault.reindex, writes: vault.writes, unresolved: vault.unresolved },
  project:   { list: project.list, get: project.get, graph: project.graph, edges: project.edges, create: project.create, 'label-shape': project.labelShape, 'label-falsifier': project.labelFalsifier, 'next-actions': project.nextActions, worklist: project.worklist, similar: project.similar, 'propose-adr': project.proposeAdr, 'ship-slice': project.shipSlice },
  adr:       { list: adr.list, propose: adr.propose, accept: adr.accept, ship: adr.ship, park: adr.park, reject: adr.reject },
  recipe:    { list: naseej.recipeList, get: naseej.recipeGet, run: naseej.recipeRun, cancel: naseej.recipeCancel },
  component: { list: naseej.componentList, get: naseej.componentGet },
  naseej:    { audit: naseej.naseejAudit },
  catalog:   { index: catalogIndex },
  crm:       { find: crm.find, followups: crm.followups },
  scheduler: { tasks: scheduler.tasks, 'run-now': scheduler.runNow },
  inbox:     { queued: inbox.queued, accounts: inbox.accounts, status: inbox.status, 'digest-telegram': inbox.digestTelegram },
  intent:    { metrics: intent.metrics },
  note:      { create: note.create, update: note.update },
  contracts: { touching: contracts.touching, check: contracts.check },
};

function splitGlobals(argv: string[]): { rest: string[]; opts: OutputOpts; base?: string } {
  const rest: string[] = [];
  const opts: OutputOpts = { json: false };
  let base: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--base') { base = argv[++i]; continue; }
    if (a.startsWith('--base=')) { base = a.slice('--base='.length); continue; }
    rest.push(a);
  }
  return { rest, opts, base };
}

async function main() {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw[0] === '-h' || raw[0] === '--help' || raw[0] === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (raw[0] === '--version' || raw[0] === '-V') {
    process.stdout.write('soul 0.2.0\n');
    return;
  }

  const { rest, opts, base } = splitGlobals(raw);
  if (base) process.env.SOUL_HUB_URL = base;

  // doctor is a top-level verb (no noun).
  if (rest[0] === 'doctor') {
    if (rest.slice(1).some(isHelpFlag)) { process.stdout.write(USAGE.doctor + '\n'); return; }
    await doctor({}, opts);
    return;
  }

  const [noun, verb, ...tail] = rest;
  if (!noun || !dispatch[noun]) fail(`unknown noun "${noun ?? ''}". Run \`soul --help\`.`);

  // Per-verb --help interception (ADR-007). Must run BEFORE parseArgs (which would
  // swallow the flag) and BEFORE the unknown-verb fail (so `soul vault --help` and
  // `soul note create --help` print usage instead of erroring). No API call.
  const helpInTail = tail.some(isHelpFlag);
  if (isHelpFlag(verb) || (helpInTail && (!verb || !dispatch[noun][verb]))) {
    printNounUsage(noun);
    return;
  }

  if (!verb || !dispatch[noun][verb]) fail(`unknown verb "${noun} ${verb ?? ''}". Run \`soul --help\`.`);

  if (helpInTail) {
    const u = USAGE[`${noun} ${verb}`];
    process.stdout.write(u ? u + '\n' : HELP);
    return;
  }

  const parsed = parseArgs({
    args: tail,
    options: {
      // read flags
      q:        { type: 'string', short: 'q' },
      zone:     { type: 'string' },
      project:  { type: 'string' },
      type:     { type: 'string' },
      limit:    { type: 'string' },
      status:   { type: 'string' },
      stage:    { type: 'string' },
      agent:    { type: 'string' },
      'actor-prefix': { type: 'string' },
      account:  { type: 'string' },
      category: { type: 'string' },
      runtime:  { type: 'string' },
      recipe:   { type: 'string' },
      component:{ type: 'string' },
      description: { type: 'string' },
      'skip-semantic': { type: 'string' },
      // write flags
      slug:        { type: 'string' },
      parent:      { type: 'string' },
      title:       { type: 'string' },
      filename:    { type: 'string' },
      content:     { type: 'string' },
      'content-file': { type: 'string' },
      reason:      { type: 'string' },
      shape:       { type: 'string' },
      format:      { type: 'string' },
      'meta-json': { type: 'string' },
      'input-json': { type: 'string' },
      'inputs-json': { type: 'string' },
      'review-after': { type: 'string' },
      on:          { type: 'string' },
      text:        { type: 'string' },
      tier:        { type: 'string' },
      problem:     { type: 'string' },
      adr:         { type: 'string' },
      slice:       { type: 'string' },
      commit:      { type: 'string' },
      notes:       { type: 'string' },
      'closes-falsifier': { type: 'string' },
      mode:        { type: 'string' },
      input:       { type: 'string' },
      'run-id':    { type: 'string' },
      since:       { type: 'string' },
      'dry-run':   { type: 'boolean' },
      freshness:   { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });

  const args: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(parsed.values)) {
    if (typeof v === 'boolean') args[k] = v ? '1' : undefined;
    else args[k] = v as string | undefined;
  }
  if (parsed.positionals.length > 0) args._ = parsed.positionals.join('/');

  try {
    await dispatch[noun][verb](args, opts);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 1);
  }
}

main();
