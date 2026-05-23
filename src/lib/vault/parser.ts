import matter from 'gray-matter';
import type { ParsedNote, VaultMeta, VaultLink } from './types.js';

// Wikilink content must not contain newlines (prevents false matches on escape sequences like ^[[...)
const WIKILINK_RE = /(!?)\[\[([^\]\n|#^]+?)(?:#([^\]\n|]+?))?(?:\^([^\]\n|]+?))?(?:\|([^\]\n]+?))?\]\]/g;

export function parseNote(filePath: string, raw: string): ParsedNote {
	const { data, content } = matter(raw);
	const meta = data as VaultMeta;
	const title =
		(typeof meta.title === 'string' && meta.title) ||
		extractFirstHeading(content) ||
		pathToTitle(filePath);

	return {
		title,
		meta,
		content,
		links: extractLinks(content)
	};
}

/** Exported so the link validator (ADR-047) can call it on `CreateNoteRequest.content`
 *  / merged update content without round-tripping through `parseNote`. Same code-block
 *  + table-escape handling as the indexer-side parse — keeps validator and indexer
 *  in sync. */
export function extractLinks(content: string): VaultLink[] {
	const links: VaultLink[] = [];
	let match: RegExpExecArray | null;
	const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);

	// Strip fenced code blocks and inline code so we don't parse example wikilinks.
	//
	// Fenced blocks per CommonMark: opener + closer must be at the START of a
	// line (up to 3 spaces of indent), and only the closer-run matters — runs
	// of backticks/tildes appearing mid-line inside the content do NOT close
	// the fence. A naive `(`{3,})[\s\S]*?\1` matches the first 3-backtick run
	// anywhere, so a JSON example mentioning the literal text ```json inside
	// the fence's content closes the fence early and corrupts downstream parse.
	//
	// Inline code spans are constrained to a single line (no blank-line spans),
	// which mirrors how authors actually use them and prevents one stray
	// unclosed backtick from swallowing the rest of the document.
	let stripped = content
		.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, '')
		.replace(/(`+)[^\n]+?\1/g, '');

	// Normalise legacy `\|` table-escapes inside wikilinks so the regex can
	// pick the alias separator correctly. Without this, `[[note\|alias]]`
	// parses as target=`note\` and never resolves.
	stripped = stripped.replace(/\[\[([^\]\n]+?)\]\]/g, (_, inner) => '[[' + inner.replace(/\\\|/g, '|') + ']]');

	while ((match = re.exec(stripped)) !== null) {
		links.push({
			raw: match[2].trim(),
			resolved: null,
			alias: match[5] || undefined,
			heading: match[3] || undefined,
			embed: match[1] === '!'
		});
	}

	return links;
}

function extractFirstHeading(content: string): string | null {
	const match = /^#\s+(.+)$/m.exec(content);
	return match ? match[1].trim() : null;
}

function pathToTitle(filePath: string): string {
	const basename = filePath.split('/').pop() ?? filePath;
	const withoutExt = basename.replace(/\.md$/i, '');
	const withoutDate = withoutExt.replace(/^\d{4}-\d{2}-\d{2}-/, '');
	return withoutDate
		.split('-')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}
