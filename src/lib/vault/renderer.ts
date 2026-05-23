import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import rehypePrettyCode from 'rehype-pretty-code';
import { visit } from 'unist-util-visit';
import type { VaultLink } from './types.js';

/**
 * Post-process HTML string to convert [[wikilinks]] to clickable elements.
 * Runs AFTER rehype-stringify since wikilinks are not standard markdown.
 *
 * `data-target` carries the *resolved* vault path (e.g. `projects/x/y.md`) so
 * the click handler can hit the notes API directly. Unresolved targets fall
 * back to the raw text and get a `vault-wikilink-broken` class.
 */
function processWikilinks(html: string, links: VaultLink[] = []): string {
	const resolvedByRaw = new Map<string, string | null>();
	for (const l of links) {
		if (!resolvedByRaw.has(l.raw)) resolvedByRaw.set(l.raw, l.resolved);
	}
	return html.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_, target, alias) => {
		const display = alias || target;
		const raw = String(target).trim();
		const resolved = resolvedByRaw.get(raw) ?? null;
		const dataTarget = resolved ?? raw;
		const cls = resolved ? 'vault-wikilink' : 'vault-wikilink vault-wikilink-broken';
		return `<a class="${cls}" data-target="${dataTarget}" href="javascript:void(0)">${display}</a>`;
	});
}

function rehypeMediaResolver(options: { vaultDir: string; noteDir: string }) {
	return (tree: any) => {
		visit(tree, 'element', (node: any) => {
			if (node.tagName === 'img' && node.properties?.src) {
				node.properties.src = resolveMediaSrc(node.properties.src, options);
			}
			if (node.tagName === 'video' && node.properties?.src) {
				node.properties.src = resolveMediaSrc(node.properties.src, options);
			}
			if (node.tagName === 'audio' && node.properties?.src) {
				node.properties.src = resolveMediaSrc(node.properties.src, options);
			}
			if (node.tagName === 'source' && node.properties?.src) {
				node.properties.src = resolveMediaSrc(node.properties.src, options);
			}
			if (node.tagName === 'a' && node.properties?.href) {
				rewriteAttachmentLink(node, options);
			}
		});
	};
}

function resolveMediaSrc(src: string, opts: { vaultDir: string; noteDir: string }): string {
	if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/api/')) return src;
	if (!opts.vaultDir) return src;
	const fullDir = opts.noteDir ? `${opts.vaultDir}/${opts.noteDir}` : opts.vaultDir;
	return `/api/files?path=${encodeURIComponent(fullDir)}&action=raw&file=${encodeURIComponent(src)}`;
}

/**
 * Rewrite relative `<a href>` targets that point to sibling non-markdown files
 * so they resolve through /api/files and carry metadata for click interception.
 * Markdown-to-markdown links, external URLs, anchors, and wikilinks are left alone.
 */
function rewriteAttachmentLink(node: any, opts: { vaultDir: string; noteDir: string }): void {
	const href = node.properties.href;
	if (typeof href !== 'string' || !href) return;
	if (href.startsWith('http://') || href.startsWith('https://')) return;
	if (href.startsWith('/')) return;
	if (href.startsWith('#')) return;
	if (href.startsWith('javascript:') || href.startsWith('mailto:')) return;

	const [pathPart] = href.split('#');
	const [cleanPath] = pathPart.split('?');
	if (!cleanPath) return;
	if (/\.(md|mdx)$/i.test(cleanPath)) return; // markdown targets handled by the note router

	if (!opts.vaultDir) return;

	const normalized = cleanPath.startsWith('./') ? cleanPath.slice(2) : cleanPath;
	const filename = normalized.split('/').pop();
	if (!filename) return;
	const subDir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
	const noteAbsDir = opts.noteDir ? `${opts.vaultDir}/${opts.noteDir}` : opts.vaultDir;
	const absDir = subDir ? `${noteAbsDir}/${subDir}` : noteAbsDir;
	const absPath = `${absDir}/${filename}`;

	node.properties.href = `/api/files?path=${encodeURIComponent(absDir)}&action=raw&file=${encodeURIComponent(filename)}`;
	node.properties['data-vault-attachment'] = 'true';
	node.properties['data-vault-attachment-path'] = absPath;
	node.properties['data-vault-attachment-name'] = filename;
	const existingClasses = Array.isArray(node.properties.className)
		? node.properties.className
		: node.properties.className
			? [node.properties.className]
			: [];
	node.properties.className = [...existingClasses, 'vault-attachment-link'];
}

/**
 * Tag block elements with `dir="auto"` so the browser picks LTR/RTL per block
 * based on the first strong character. This handles mixed-language notes
 * (English headings + Arabic code blocks, etc.) without a percentage heuristic.
 */
const AUTO_DIR_TAGS = new Set([
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'p', 'li', 'blockquote',
	'td', 'th', 'caption',
	'pre', 'figcaption',
	'dt', 'dd',
]);

function rehypeAutoDir() {
	return (tree: any) => {
		visit(tree, 'element', (node: any) => {
			if (!AUTO_DIR_TAGS.has(node.tagName)) return;
			node.properties = node.properties || {};
			if (node.properties.dir == null) node.properties.dir = 'auto';
		});
	};
}

/**
 * Render an inline color swatch next to any `<code>` element whose entire
 * content is a CSS hex literal (`#abc`, `#abcdef`, or `#abcdef12`). The swatch
 * makes color tokens scannable when reading design palettes inline — picking
 * the colors visually rather than mentally parsing hex.
 *
 * Runs *before* rehype-pretty-code so we see un-tokenized text. Skips any
 * code element that isn't a single text child (e.g., already-highlighted
 * tokens) to avoid clobbering existing structure.
 */
function rehypeHexSwatches() {
	const HEX = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
	return (tree: any) => {
		visit(tree, 'element', (node: any) => {
			if (node.tagName !== 'code') return;
			if (!Array.isArray(node.children) || node.children.length !== 1) return;
			const only = node.children[0];
			if (only.type !== 'text' || typeof only.value !== 'string') return;
			const text = only.value.trim();
			if (!HEX.test(text)) return;

			const existingClasses = Array.isArray(node.properties?.className)
				? node.properties.className
				: node.properties?.className
					? [node.properties.className]
					: [];
			node.properties = {
				...(node.properties || {}),
				className: [...existingClasses, 'hex-code'],
			};
			node.children = [
				{
					type: 'element',
					tagName: 'span',
					properties: {
						className: ['hex-swatch'],
						style: `background-color: ${text}`,
						'aria-hidden': 'true',
					},
					children: [],
				},
				{ type: 'text', value: text },
			];
		});
	};
}

function rehypeCodeCopyButton() {
	return (tree: any) => {
		visit(tree, 'element', (node: any, index: number | undefined, parent: any) => {
			if (node.tagName !== 'pre') return;
			const codeEl = node.children?.find((c: any) => c.tagName === 'code');
			if (!codeEl) return;

			const langClass = (codeEl.properties?.className || []).find((c: string) =>
				typeof c === 'string' && c.startsWith('language-')
			);
			const lang = langClass ? langClass.replace('language-', '') : '';

			const wrapper = {
				type: 'element',
				tagName: 'div',
				properties: { className: ['vault-code-block'], 'data-lang': lang },
				children: [
					{
						type: 'element',
						tagName: 'div',
						properties: { className: ['vault-code-header'] },
						children: [
							{
								type: 'element',
								tagName: 'span',
								properties: { className: ['vault-code-lang'] },
								children: [{ type: 'text', value: lang }],
							},
							{
								type: 'element',
								tagName: 'button',
								properties: {
									className: ['vault-code-copy'],
									onclick:
										"navigator.clipboard.writeText(this.closest('.vault-code-block').querySelector('code').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>{this.textContent='Copy'},1500)})",
								},
								children: [{ type: 'text', value: 'Copy' }],
							},
						],
					},
					node,
				],
			};

			if (parent && typeof index === 'number') {
				parent.children[index] = wrapper;
			}
		});
	};
}

/**
 * Auto-escape the `|` separator inside wikilink brackets so the GFM table
 * parser doesn't split `[[note|alias]]` across cells. Idempotent — pre-existing
 * `\|` is normalised first so we never produce `\\|`.
 */
function escapeWikilinkPipesForTables(md: string): string {
	return md.replace(/\[\[([^\]\n]+?)\]\]/g, (_, inner) => {
		const normalised = inner.replace(/\\\|/g, '|').replace(/\|/g, '\\|');
		return '[[' + normalised + ']]';
	});
}

export async function renderMarkdown(
	content: string,
	options: { vaultDir: string; noteDir: string; links?: VaultLink[] }
): Promise<string> {
	if (!content || !content.trim()) return '';

	const preprocessed = escapeWikilinkPipesForTables(content);

	const result = await unified()
		.use(remarkParse)
		.use(remarkFrontmatter, ['yaml'])
		.use(remarkGfm)
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeHexSwatches)
		.use(rehypePrettyCode, { theme: 'github-dark-default', keepBackground: true })
		.use(rehypeCodeCopyButton)
		.use(rehypeMediaResolver, options)
		.use(rehypeAutoDir)
		.use(rehypeStringify, { allowDangerousHtml: true })
		.process(preprocessed);

	let html = String(result);

	// Strip leading <h1> — title is already shown in the metadata header
	html = html.replace(/^\s*<h1[^>]*>.*?<\/h1>\s*/, '');

	// Wikilinks are processed as a post-pass on the HTML string
	// since [[target|alias]] is not standard markdown syntax
	return processWikilinks(html, options.links);
}

export function isRtl(text: string): boolean {
	const rtlChars = text.match(
		/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF]/g
	);
	if (!rtlChars) return false;
	const latinChars = text.match(/[a-zA-Z]/g);
	const totalAlpha = (rtlChars?.length || 0) + (latinChars?.length || 0);
	return totalAlpha > 0 && rtlChars.length / totalAlpha > 0.3;
}
