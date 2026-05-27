/** Contract registry types — soul-hub-governance ADR-002 (P2).
 *
 *  A *contract* is an invariant one organ guarantees plus a *falsifier* — a
 *  cheap self-test that goes red when the invariant is violated (ADR-001).
 *  The registry is governed VAULT content (source of truth, ADR-001 #3); this
 *  module's compile step projects it to a fast on-disk cache the global hook
 *  and CLI read instantly + offline (ADR-002 Option C). */

/** A file-glob entry, root-prefixed so the compiler can resolve it to an
 *  absolute glob. Roots:
 *    `vault:<glob>` → under ~/vault/
 *    `repo:<glob>`  → under the soul-hub repo root
 *    `abs:<glob>` or a leading `/` or `~` → used as-is (expanded). */
export type ContractGlob = string;

/** A static, change-local build-time assertion (soul-hub-governance ADR-003 P3).
 *  Run by the `contract-precommit` gate. Two forms:
 *
 *  `diff-regex` — tested against ADDED lines of the staged diff for the
 *    contract's files. A match REFUSES when `mustNotMatch` (default). Good for
 *    catching re-introduction of retired patterns.
 *
 *  `file-regex` — tested against the FULL CONTENT of an absolute file path.
 *    The file is read at commit time; a match REFUSES when `mustNotMatch`.
 *    Good for static invariants in files outside the soul-hub repo (e.g.
 *    agent profiles at `~/.claude/agents/`) — ADR-007 hygiene-fixer buildCheck.
 */
export type ContractBuildCheck = DiffRegexBuildCheck | FileRegexBuildCheck;

export interface DiffRegexBuildCheck {
	type: 'diff-regex';
	/** Optional subset of the contract's `files` to scope the check to. */
	files?: ContractGlob[];
	/** Regex (JS/PCRE-ish) tested against added (`+`) lines of the staged diff. */
	pattern: string;
	/** When true (default), a match means the change is REFUSED. */
	mustNotMatch?: boolean;
	/** Operator-facing reason shown on refuse. */
	message: string;
}

export interface FileRegexBuildCheck {
	type: 'file-regex';
	/** Absolute path of the file to inspect (supports `~` expansion and `abs:` prefix). */
	file: string;
	/** Regex (JS/PCRE-ish) tested against the full file content. */
	pattern: string;
	/** When true (default), a match means the change is REFUSED. */
	mustNotMatch?: boolean;
	/** Operator-facing reason shown on refuse. */
	message: string;
}

/** One declared contract, as authored in the vault registry note's
 *  `contracts:` frontmatter array. */
export interface Contract {
	/** Stable kebab-case id, unique in the registry. */
	id: string;
	/** Organ / area that guarantees it (vault, projects, scheduler, …). */
	area: string;
	/** One-line statement of the invariant. */
	guarantees: string;
	/** Root-prefixed globs for the files that participate in the contract. */
	files: ContractGlob[];
	/** Other contract ids this one depends on (for blast-radius later). */
	dependsOn?: string[];
	/** The falsifier: a scheduler task id (joined on `/hygiene`) or a shell
	 *  command string. Required — ADR-001: no contract is protected without one. */
	falsifier: string;
	/** Optional build-time assertion enforced by the pre-commit gate (ADR-003 P3).
	 *  Absent = the gate applies only the default falsifier-touched WARN rule. */
	buildCheck?: ContractBuildCheck;
}

/** A compiled contract: the authored record plus absolute globs resolved at
 *  compile time (so the edge — hook/CLI — does pure matching, no root logic),
 *  and `bashGlobs` (a `**`→`*` simplification bash `[[ == ]]` can match). */
export interface CompiledContract extends Contract {
	/** Absolute globs with `**`/`*`/`?` semantics, for the node resolver. */
	globsAbs: string[];
	/** Absolute globs simplified for bash `[[ $p == $glob ]]` (advisory hook;
	 *  may slightly over-match — safe, since the API resolver is authoritative). */
	bashGlobs: string[];
}

/** The on-disk cache shape (`~/.soul-hub/data/contracts/registry.json`). */
export interface CompiledRegistry {
	/** ISO timestamp the cache was compiled. */
	compiledAt: string;
	/** Vault path of the source registry note. */
	sourcePath: string;
	/** Source note mtime (ms) + content hash — for the freshness falsifier. */
	sourceMtime: number;
	sourceHash: string;
	/** Resolved roots, recorded for transparency / debugging. */
	roots: { vault: string; repo: string };
	contracts: CompiledContract[];
}

/** Result of a resolution+freshness self-check (the registry's own falsifier). */
export interface RegistryCheck {
	ok: boolean;
	/** Contracts whose files glob resolves to zero existing paths. */
	unresolvedFiles: { id: string; glob: string }[];
	/** Contracts whose falsifier is neither a known task id nor a command. */
	danglingFalsifiers: { id: string; falsifier: string }[];
	/** dependsOn ids that point at no declared contract. */
	danglingDeps: { id: string; dep: string }[];
	/** True if the cache is stale vs the vault source (hash mismatch / missing). */
	cacheStale: boolean;
	count: number;
}
