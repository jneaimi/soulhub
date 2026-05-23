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
  soul intent metrics
  soul contracts touching PATH        (governance ADR-002 — what contracts a change touches)
  soul contracts check                (registry self-falsifier: resolution + cache freshness)
  soul doctor

WRITE VERBS (each supports --dry-run)
  soul note create   --zone Z --filename F --type T [--meta-json JSON] --content STR
  soul note update   PATH [--meta-json JSON] [--content STR]
  soul project create --slug S [--parent P] [--title T] [--meta-json JSON]
  soul project label-shape SLUG --shape SHAPE
  soul project label-falsifier SLUG --on YYYY-MM-DD [--text TEXT]
  soul project propose-adr SLUG --input-json '{...}' (or --title T --tier "Tier 2" --problem STR)
  soul project ship-slice SLUG --adr X --slice S<N> --status STATUS [--commit SHA]
  soul vault reindex
  soul adr propose   --project P --slug S --title T --content STR [--meta-json JSON]
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
  inbox:     { queued: inbox.queued, 'digest-telegram': inbox.digestTelegram },
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
    await doctor({}, opts);
    return;
  }

  const [noun, verb, ...tail] = rest;
  if (!noun || !dispatch[noun]) fail(`unknown noun "${noun ?? ''}". Run \`soul --help\`.`);
  if (!verb || !dispatch[noun][verb]) fail(`unknown verb "${noun} ${verb ?? ''}". Run \`soul --help\`.`);

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
