/**
 * Files Explorer — runtime-mutable root configuration.
 *
 * Roots are paths the user has opted-in to expose through `/api/files`.
 * Stored in `.data/explorer-roots.json` so UI changes don't require a
 * server restart (mirrors the secrets.ts pattern, not config.ts).
 *
 * Security model:
 * - The user explicitly adds each root via Settings → File Explorer
 * - A hard deny list (DENIED_PATHS) blocks sensitive Mac paths even when
 *   covered by an allowed root — defense-in-depth
 * - Symlink escape is prevented by callers using fs.realpath() before the
 *   final allow-check
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { soulHubDataFile } from './paths.js';

const HOME = homedir();
const ROOTS_PATH = soulHubDataFile('explorer-roots.json');

export interface ExplorerRoot {
	id: string;
	name: string;
	/** Original user-supplied path (may contain `~`) — preserved for display + edits */
	path: string;
	/** Resolved absolute path — what the API uses for allow-checks */
	resolvedPath: string;
	showHidden: boolean;
	createdAt: string;
}

interface RootsFile {
	version: 1;
	roots: ExplorerRoot[];
}

/**
 * Mac paths that are always denied, regardless of user-configured roots.
 * Listed as `~`-prefixed for readability — resolved at startup.
 */
const DENIED_PATTERNS = [
	'~/.ssh',
	'~/.aws',
	'~/.gnupg',
	'~/.config/gh',
	'~/.config/op',
	'~/.kube',
	'~/.docker/config.json',
	'~/Library/Keychains',
	'~/Library/Cookies',
	'~/Library/Application Support/com.apple.TCC',
	'~/Library/Application Support/Google/Chrome',
	'~/Library/Application Support/Firefox',
	'~/Library/Application Support/1Password',
];

let DENIED_RESOLVED: string[] | null = null;
function getDeniedResolved(): string[] {
	if (DENIED_RESOLVED === null) {
		DENIED_RESOLVED = DENIED_PATTERNS.map(expandPath);
	}
	return DENIED_RESOLVED;
}

function expandPath(p: string): string {
	if (p.startsWith('~/')) return resolve(HOME, p.slice(2));
	if (p === '~') return HOME;
	return resolve(p);
}

function ensureDataDir(): void {
	const dir = dirname(ROOTS_PATH);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readFile(): RootsFile {
	if (!existsSync(ROOTS_PATH)) return { version: 1, roots: [] };
	try {
		const raw = readFileSync(ROOTS_PATH, 'utf-8');
		const parsed = JSON.parse(raw) as RootsFile;
		if (!parsed.roots || !Array.isArray(parsed.roots)) return { version: 1, roots: [] };
		return parsed;
	} catch {
		return { version: 1, roots: [] };
	}
}

function writeFile(file: RootsFile): void {
	ensureDataDir();
	writeFileSync(ROOTS_PATH, JSON.stringify(file, null, 2) + '\n', 'utf-8');
}

/**
 * On first run, seed the roots file with the previously-hardcoded entries
 * (~/dev, ~/vault) so existing flows that browse those paths keep working
 * without manual intervention.
 */
export function seedDefaultsIfEmpty(seedPaths: { name: string; path: string }[]): void {
	const file = readFile();
	if (file.roots.length > 0) return;
	const now = new Date().toISOString();
	file.roots = seedPaths.map((s) => ({
		id: randomUUID(),
		name: s.name,
		path: s.path,
		resolvedPath: expandPath(s.path),
		showHidden: false,
		createdAt: now,
	}));
	writeFile(file);
}

export function listRoots(): ExplorerRoot[] {
	return readFile().roots;
}

export interface AddRootInput {
	name: string;
	path: string;
	showHidden?: boolean;
}

export class RootValidationError extends Error {
	constructor(message: string, public code: 'invalid_path' | 'not_directory' | 'denied' | 'overlap' | 'duplicate') {
		super(message);
	}
}

/**
 * Validate + add a new root. Throws RootValidationError on failure so
 * callers can map the code to a stable HTTP status.
 *
 * Validation:
 *   1. Path must not contain null bytes or `..`
 *   2. Resolves to an existing directory (not file, not missing)
 *   3. Resolved path is not on the deny list
 *   4. Resolved path doesn't equal an existing root (duplicate)
 *   5. Resolved path doesn't sit inside an existing root (overlap)
 *      and no existing root sits inside this one
 */
export function addRoot(input: AddRootInput): ExplorerRoot {
	if (!input.path || input.path.includes('\0') || input.path.includes('..')) {
		throw new RootValidationError('Path contains invalid characters', 'invalid_path');
	}
	if (!input.name?.trim()) {
		throw new RootValidationError('Name is required', 'invalid_path');
	}

	const resolvedPath = expandPath(input.path);

	// Resolve symlinks so /var → /private/var doesn't fool the deny check
	let realPath: string;
	try {
		realPath = realpathSync(resolvedPath);
		const s = statSync(realPath);
		if (!s.isDirectory()) {
			throw new RootValidationError('Path is not a directory', 'not_directory');
		}
	} catch (e) {
		if (e instanceof RootValidationError) throw e;
		throw new RootValidationError('Directory does not exist or is not accessible', 'not_directory');
	}

	for (const denied of getDeniedResolved()) {
		if (realPath === denied || realPath.startsWith(denied + '/')) {
			throw new RootValidationError(`Path is on the system deny list: ${denied}`, 'denied');
		}
	}

	const file = readFile();
	for (const existing of file.roots) {
		if (existing.resolvedPath === realPath) {
			throw new RootValidationError(`Root already exists: ${existing.name}`, 'duplicate');
		}
		if (realPath.startsWith(existing.resolvedPath + '/')) {
			throw new RootValidationError(`Path is inside existing root "${existing.name}"`, 'overlap');
		}
		if (existing.resolvedPath.startsWith(realPath + '/')) {
			throw new RootValidationError(`Existing root "${existing.name}" is inside this path`, 'overlap');
		}
	}

	const root: ExplorerRoot = {
		id: randomUUID(),
		name: input.name.trim(),
		path: input.path,
		resolvedPath: realPath,
		showHidden: input.showHidden ?? false,
		createdAt: new Date().toISOString(),
	};
	file.roots.push(root);
	writeFile(file);
	return root;
}

export function removeRoot(id: string): boolean {
	const file = readFile();
	const before = file.roots.length;
	file.roots = file.roots.filter((r) => r.id !== id);
	if (file.roots.length === before) return false;
	writeFile(file);
	return true;
}

export interface UpdateRootInput {
	name?: string;
	showHidden?: boolean;
}

export function updateRoot(id: string, patch: UpdateRootInput): ExplorerRoot | null {
	const file = readFile();
	const root = file.roots.find((r) => r.id === id);
	if (!root) return null;
	if (patch.name !== undefined) {
		const trimmed = patch.name.trim();
		if (!trimmed) throw new RootValidationError('Name cannot be empty', 'invalid_path');
		root.name = trimmed;
	}
	if (patch.showHidden !== undefined) root.showHidden = patch.showHidden;
	writeFile(file);
	return root;
}

/**
 * True if `targetPath` (already resolved with realpathSync by the caller)
 * sits inside any allowed root and is not on the deny list.
 *
 * This is the single allow-check used by /api/files. Callers MUST pass a
 * resolved+realpath'd path — symlink escape protection lives at the call
 * site, not here.
 */
export function isPathAllowed(targetPath: string): { allowed: boolean; root?: ExplorerRoot; reason?: string } {
	for (const denied of getDeniedResolved()) {
		if (targetPath === denied || targetPath.startsWith(denied + '/')) {
			return { allowed: false, reason: 'denied by system deny list' };
		}
	}
	for (const root of listRoots()) {
		if (targetPath === root.resolvedPath || targetPath.startsWith(root.resolvedPath + '/')) {
			return { allowed: true, root };
		}
	}
	return { allowed: false, reason: 'not under any allowed root' };
}

/** Find the root that contains a given resolved path, if any. Used for showHidden lookup. */
export function findRootForPath(targetPath: string): ExplorerRoot | null {
	for (const root of listRoots()) {
		if (targetPath === root.resolvedPath || targetPath.startsWith(root.resolvedPath + '/')) {
			return root;
		}
	}
	return null;
}

export { DENIED_PATTERNS };
