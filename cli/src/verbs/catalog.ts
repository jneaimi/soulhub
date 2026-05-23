// ADR-027 P2.3 — Naseej catalog-index surface from the CLI.
//
// `soul catalog index` is the operator + AI-author manual entrypoint to the
// catalog-index. Wraps GET /api/components/index — the endpoint re-builds in
// memory + atomic-writes catalog/catalog-index.json on every fetch (P2.1), so
// the CLI doubles as a "force regen + dump" tool. Pair with `--json | jq` to
// project specific fields:
//
//   soul catalog index --json | jq '.components | keys'
//   soul catalog index --json | jq '.components."shell-exec".used_by_recipes'
//   soul catalog index --freshness --json | jq .ageSeconds
//
// `--freshness` switches to the lightweight `GET /api/components/index/freshness`
// probe (no rebuild). Useful for `soul doctor`-style scripted checks.
//
// Dumb-pipe rule (ADR-001): no client-side validation or caching; errors
// surface verbatim. Pretty output is a thin summary, never a partial copy of
// the API payload — `--json` is the contract.

import { apiGet } from '../api.ts';
import { emit, type OutputOpts } from '../output.ts';

interface CatalogIndexComponentEntry {
  name: string;
  version: string;
  tier: 1 | 2;
  shape: 'default' | 'agentic' | 'gate';
  category?: string;
  runtime: 'node' | 'python';
  description?: string;
  when_to_use?: string;
  when_not_to_use?: string;
  inputs: unknown[];
  outputs: unknown[];
  used_by_recipes: string[];
  example_usage:
    | { from_recipe: string; step: { id: string; component: string; inputs: Record<string, unknown> } }
    | null;
}

interface CatalogIndexRecipeEntry {
  name: string;
  version: string;
  project: string;
  description?: string;
  step_count: number;
  components_used: string[];
  recipe_path: string;
}

interface CatalogIndexDoc {
  schema_version: number;
  generated_at: string;
  components: Record<string, CatalogIndexComponentEntry>;
  recipes: Record<string, CatalogIndexRecipeEntry>;
}

interface CatalogIndexFreshness {
  exists: boolean;
  fresh: boolean;
  indexPath: string;
  indexMtime: string | null;
  newestSource: string | null;
  newestSourceMtime: string | null;
  ageSeconds: number | null;
}

export async function catalogIndex(args: Record<string, string | undefined>, opts: OutputOpts) {
  // --freshness routes to the cheap probe endpoint instead of regenerating.
  if (args.freshness !== undefined) {
    const data = await apiGet<CatalogIndexFreshness>('/api/components/index/freshness');
    emit(data, opts, (f: CatalogIndexFreshness) => {
      const lines: string[] = [];
      lines.push(`Index path:   ${f.indexPath}`);
      lines.push(`Exists:       ${f.exists ? '✓' : '✗'}`);
      if (!f.exists) {
        lines.push('');
        lines.push('Fetch `soul catalog index` once to materialise it.');
        return lines.join('\n');
      }
      lines.push(`Fresh:        ${f.fresh ? '✓' : '⚠'}`);
      lines.push(`Index mtime:  ${f.indexMtime ?? '—'}`);
      lines.push(`Newest src:   ${f.newestSource ?? '(no catalog sources)'}`);
      if (f.newestSourceMtime) lines.push(`Source mtime: ${f.newestSourceMtime}`);
      if (f.ageSeconds !== null) {
        lines.push(
          f.ageSeconds >= 0
            ? `Age:          +${f.ageSeconds}s ahead of newest source`
            : `Age:          ${Math.abs(f.ageSeconds)}s behind newest source`,
        );
      }
      return lines.join('\n');
    });
    return;
  }

  // Default: regenerate + dump the full catalog-index. The endpoint re-builds
  // + atomic-writes the on-disk file on every fetch (P2.1 behaviour).
  const data = await apiGet<CatalogIndexDoc>('/api/components/index');
  emit(data, opts, (d: CatalogIndexDoc) => {
    const lines: string[] = [];
    const compCount = Object.keys(d.components).length;
    const recipeCount = Object.keys(d.recipes).length;
    lines.push(`Schema:     v${d.schema_version}`);
    lines.push(`Generated:  ${d.generated_at}`);
    lines.push(`Components: ${compCount}`);
    lines.push(`Recipes:    ${recipeCount}`);
    lines.push('');
    lines.push('Components (name · tier · shape · runtime · used-by):');
    const compEntries = Object.values(d.components).sort((a, b) => a.name.localeCompare(b.name));
    for (const c of compEntries) {
      const usedBy = c.used_by_recipes.length;
      const usedStr = usedBy === 0 ? '(unused)' : `${usedBy} recipe${usedBy === 1 ? '' : 's'}`;
      lines.push(
        `  ${c.name.padEnd(22)} T${c.tier}  ${c.shape.padEnd(8)} ${c.runtime.padEnd(7)} ${usedStr}`,
      );
    }
    lines.push('');
    lines.push('Recipes (name · project · steps · components):');
    const recipeEntries = Object.values(d.recipes).sort((a, b) => a.name.localeCompare(b.name));
    for (const r of recipeEntries) {
      lines.push(
        `  ${r.name.padEnd(30)} ${r.project.padEnd(15)} ${String(r.step_count).padStart(2)}  [${r.components_used.join(', ')}]`,
      );
    }
    lines.push('');
    lines.push('Pipe `--json | jq` for full inputs/outputs/example_usage detail.');
    return lines.join('\n');
  });
}
