#!/usr/bin/env python3
"""Performance analysis for code review — detects anti-patterns via regex."""
import sys
import os
import json
import re
import time
from pathlib import Path

SKIP_DIRS = {
    'node_modules', '.git', '__pycache__', 'dist', '.next', '.svelte-kit',
    'build', 'venv', '.venv', 'coverage', '.turbo', '.cache', 'vendor',
    'target', '.output', '.nuxt', 'env', '.env',
}
SKIP_EXTS = {
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
    '.woff', '.woff2', '.ttf', '.eot', '.lock', '.map',
    '.min.js', '.min.css', '.zip', '.tar', '.gz', '.pdf',
    '.mp3', '.mp4', '.mov',
}
EXT_LANG = {
    '.py': 'python',
    '.js': 'javascript', '.mjs': 'javascript', '.jsx': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript',
    '.svelte': 'javascript',
}

# Patterns organized by category
PERF_CHECKS = {
    'sync-io': {
        'patterns': [
            (r'readFileSync\(', 'readFileSync — blocks the event loop'),
            (r'writeFileSync\(', 'writeFileSync — blocks the event loop'),
            (r'existsSync\(', 'existsSync — blocks the event loop'),
            (r'readdirSync\(', 'readdirSync — blocks the event loop'),
            (r'mkdirSync\(', 'mkdirSync — blocks the event loop'),
            (r'statSync\(', 'statSync — blocks the event loop'),
        ],
        'severity': 'medium',
        'category': 'blocking-io',
        'title': 'Synchronous file I/O',
        'description': 'Sync I/O blocks the event loop; use async alternatives',
        'suggestion': 'Use async fs methods (readFile, writeFile, etc.)',
        'languages': {'javascript', 'typescript'},
    },
    'n-plus-1-py': {
        'patterns': [
            (r'for\s+.*:.*(?:\.query|\.execute|\.fetch|cursor)', 'DB query inside loop'),
            (r'for\s+.*:\s*\n\s+.*requests\.(?:get|post|put|delete)', 'HTTP request inside loop'),
        ],
        'severity': 'high',
        'category': 'query-pattern',
        'title': 'N+1 query pattern',
        'description': 'Database query or HTTP request inside a loop — scales linearly',
        'suggestion': 'Batch queries or use bulk operations',
        'languages': {'python'},
    },
    'n-plus-1-js': {
        'patterns': [
            (r'for\s*\(.*\)\s*\{[^}]*(?:await\s+fetch|await\s+\w+\.query|await\s+\w+\.find)', 'await in for loop'),
            (r'\.forEach\(\s*async\s', 'async forEach — sequential awaits'),
            (r'\.map\(\s*async\s', 'async map without Promise.all'),
        ],
        'severity': 'high',
        'category': 'query-pattern',
        'title': 'N+1 / sequential async pattern',
        'description': 'Sequential async operations in a loop — use Promise.all or batch',
        'suggestion': 'Use Promise.all(items.map(...)) or batch API',
        'languages': {'javascript', 'typescript'},
    },
    'db-in-loop': {
        'patterns': [
            (r'for\s+.*:[\s\S]*?(?:\.query|\.execute|\.find|\.select)\s*\(', 'DB query in loop'),
        ],
        'severity': 'high',
        'category': 'query-pattern',
        'title': 'Database query in loop',
        'description': 'Database operations inside loops scale linearly with data size',
        'suggestion': 'Batch queries, use IN clauses, or prefetch data',
        'languages': None,
    },
    'unbounded-query': {
        'patterns': [
            (r'\.(?:find|select|query)\s*\(\s*\)\s*(?!.*(?:limit|take|first|paginate))', 'Unbounded query — missing limit'),
        ],
        'severity': 'medium',
        'category': 'query-pattern',
        'title': 'Unbounded query',
        'description': 'Query without limit/pagination may return excessive data',
        'suggestion': 'Add .limit(), .take(), or pagination',
        'languages': None,
    },
    'select-star': {
        'patterns': [
            (r'SELECT\s+\*\s+FROM', 'SELECT * without specific columns'),
        ],
        'severity': 'low',
        'category': 'query-pattern',
        'title': 'SELECT * query',
        'description': 'Fetching all columns when only some are needed wastes bandwidth',
        'suggestion': 'Select only needed columns',
        'languages': None,  # All languages
    },
    'no-limit': {
        'patterns': [
            (r'SELECT\s+(?:\*|\w+).*FROM(?!.*LIMIT)', 'SELECT without LIMIT'),
        ],
        'severity': 'low',
        'category': 'query-pattern',
        'title': 'Query without LIMIT',
        'description': 'Unbounded queries may return excessive data',
        'suggestion': 'Add LIMIT or pagination',
        'languages': None,
    },
    'sync-crypto': {
        'patterns': [
            (r'(?:hashSync|compareSync|genSaltSync)\s*\(', 'Synchronous crypto operation'),
        ],
        'severity': 'high',
        'category': 'blocking-io',
        'title': 'Synchronous crypto',
        'description': 'Synchronous crypto operations block the event loop — high latency under load',
        'suggestion': 'Use async variants (hash, compare, genSalt)',
        'languages': {'javascript', 'typescript'},
    },
    'large-json-parse': {
        'patterns': [
            (r'JSON\.parse\s*\(\s*(?:req|request|body)', 'JSON.parse on raw request body'),
        ],
        'severity': 'medium',
        'category': 'blocking-io',
        'title': 'JSON.parse on raw request',
        'description': 'Parsing large JSON payloads without size limits can block or OOM',
        'suggestion': 'Add body size limit via middleware (e.g., express.json({ limit: "1mb" }))',
        'languages': {'javascript', 'typescript'},
    },
    'console-in-production': {
        'patterns': [
            (r'console\.(?:log|debug|trace)\s*\(', 'Console statement in production code'),
        ],
        'severity': 'low',
        'category': 'cleanup',
        'title': 'Console statement',
        'description': 'Console logging in production adds I/O overhead and leaks info',
        'suggestion': 'Remove or use structured logging',
        'languages': {'javascript', 'typescript'},
        'skip_test_files': True,
    },
    'full-library-import': {
        'patterns': [
            (r"import\s+\w+\s+from\s+['\"]lodash['\"]", 'Full lodash import'),
            (r"import\s+\w+\s+from\s+['\"]moment['\"]", 'Full moment import'),
            (r"import\s+\w+\s+from\s+['\"]rxjs['\"]", 'Full rxjs import'),
            (r"require\(['\"]lodash['\"]\)", 'Full lodash require'),
            (r"require\(['\"]moment['\"]\)", 'Full moment require'),
        ],
        'severity': 'medium',
        'category': 'bundle-size',
        'title': 'Full library import',
        'description': 'Importing entire library instead of specific functions increases bundle size',
        'suggestion': "Use tree-shakeable imports: import { get } from 'lodash/get'",
        'languages': {'javascript', 'typescript'},
    },
    'event-listener-leak': {
        'patterns': [
            (r'addEventListener\(', 'addEventListener without matching removeEventListener'),
        ],
        'severity': 'low',
        'category': 'memory',
        'title': 'Event listener without cleanup',
        'description': 'Event listeners without cleanup can cause memory leaks',
        'suggestion': 'Add removeEventListener in cleanup/unmount',
        'languages': {'javascript', 'typescript'},
    },
    'forced-reflow': {
        'patterns': [
            (r'(?:offsetHeight|offsetWidth|clientHeight|clientWidth|scrollHeight|getBoundingClientRect)',
             'Layout property read — may force reflow if followed by style write'),
        ],
        'severity': 'low',
        'category': 'rendering',
        'title': 'Potential forced reflow',
        'description': 'Reading layout properties between DOM writes forces synchronous layout',
        'suggestion': 'Batch reads before writes, or use requestAnimationFrame',
        'languages': {'javascript', 'typescript'},
    },
    'missing-key': {
        'patterns': [
            (r'\{#each\s+\w+\s+as\s+\w+\}(?!.*\()', 'Svelte #each without key'),
        ],
        'severity': 'medium',
        'category': 'rendering',
        'title': 'List rendering without key',
        'description': 'Missing key in list rendering causes unnecessary re-renders',
        'suggestion': 'Add (item.id) key to {#each} block',
        'languages': {'javascript'},  # Svelte files
    },
    'base64-inline': {
        'patterns': [
            (r'data:(?:image|application)/[^;]+;base64,[A-Za-z0-9+/=]{500,}', 'Large inline base64 data'),
        ],
        'severity': 'medium',
        'category': 'bundle-size',
        'title': 'Large inline base64 data',
        'description': 'Large base64 strings inflate bundle size and bypass caching',
        'suggestion': 'Move to external file and reference by URL',
        'languages': None,
    },
    'queryselector-in-loop': {
        'patterns': [
            (r'(?:for|while)\s*\(.*\)\s*\{[^}]*(?:querySelector|querySelectorAll|getElementById)',
             'DOM query inside loop'),
        ],
        'severity': 'medium',
        'category': 'rendering',
        'title': 'DOM query inside loop',
        'description': 'Repeated DOM queries inside loops are slow',
        'suggestion': 'Cache the DOM reference outside the loop',
        'languages': {'javascript', 'typescript'},
    },
    'sleep-in-handler': {
        'patterns': [
            (r'time\.sleep\(', 'time.sleep() — blocks the thread'),
            (r'await\s+new\s+Promise.*setTimeout', 'sleep via Promise setTimeout'),
        ],
        'severity': 'medium',
        'category': 'blocking-io',
        'title': 'Sleep in code path',
        'description': 'Blocking sleep in request handlers increases latency',
        'suggestion': 'Use async scheduling or remove the sleep',
        'languages': None,
    },
}


def get_code_context(file_lines, line_num, context=2):
    """Return 2 lines before/after the finding for context."""
    start = max(0, line_num - 1 - context)
    end = min(len(file_lines), line_num + context)
    parts = []
    for i in range(start, end):
        marker = '>>> ' if i == line_num - 1 else '    '
        parts.append('%s%4d | %s' % (marker, i + 1, file_lines[i].rstrip()))
    return '\n'.join(parts)


def scan_file(filepath, lang):
    findings = []
    try:
        content = open(filepath, errors='ignore').read()
        lines = content.split('\n')
    except Exception:
        return findings

    is_test = 'test' in str(filepath).lower()

    for check_id, check in PERF_CHECKS.items():
        allowed_langs = check.get('languages')
        if allowed_langs is not None and lang not in allowed_langs:
            continue
        if check.get('skip_test_files') and is_test:
            continue

        for pattern, detail in check['patterns']:
            for i, line in enumerate(lines, 1):
                stripped = line.strip()
                if not stripped or stripped.startswith('#') or stripped.startswith('//') or stripped.startswith('*'):
                    continue
                try:
                    if re.search(pattern, stripped, re.IGNORECASE):
                        findings.append({
                            'file': str(filepath),
                            'line': i,
                            'severity': check['severity'],
                            'category': check['category'],
                            'title': check['title'],
                            'description': detail,
                            'snippet': stripped[:200],
                            'suggestion': check.get('suggestion', ''),
                            'context': get_code_context(lines, i),
                        })
                        break  # One match per pattern per file
                except re.error:
                    continue

    # File-level: check for addEventListener without removeEventListener
    if lang in ('javascript', 'typescript'):
        has_add = 'addEventListener' in content
        has_remove = 'removeEventListener' in content
        has_cleanup = 'onDestroy' in content or 'onCleanup' in content or 'useEffect' in content
        if has_add and not has_remove and not has_cleanup:
            # Already covered by pattern check, but we can enhance
            pass

    return findings


def collect_files(target_path):
    files = []
    if target_path.is_file():
        ext = target_path.suffix.lower()
        lang = EXT_LANG.get(ext)
        if lang:
            files.append((target_path, lang))
        return files

    for root, dirs, filenames in os.walk(target_path):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fname in filenames:
            fpath = Path(root) / fname
            ext = fpath.suffix.lower()
            if ext in SKIP_EXTS:
                continue
            lang = EXT_LANG.get(ext)
            if lang:
                files.append((fpath, lang))
    return files


def format_markdown_report(result):
    lines = ['# Performance Analysis Report\n']
    lines.append('**Target:** `%s`' % result['target'])
    lines.append('**Files scanned:** %d | **Findings:** %d | **Time:** %dms\n' % (
        result['file_count'], result['finding_count'], result['scan_time_ms']))

    if not result['findings']:
        lines.append('No performance issues found.\n')
        lines.append('> Agent: Do a focused 3-minute check on database queries and I/O operations only.\n')
        return '\n'.join(lines)

    lines.append('## Summary\n')
    lines.append(result['summary'] + '\n')

    by_category = {}
    for f in result['findings']:
        by_category.setdefault(f['category'], []).append(f)

    for cat, group in sorted(by_category.items()):
        lines.append('## %s (%d)\n' % (cat.replace('-', ' ').title(), len(group)))
        for f in group:
            lines.append('### %s' % f['title'])
            lines.append('- **File:** `%s:%d`' % (f['file'], f['line']))
            lines.append('- **Severity:** %s' % f['severity'])
            lines.append('- **Detail:** %s' % f['description'])
            if f.get('context'):
                lines.append('```')
                lines.append(f['context'])
                lines.append('```')
            else:
                lines.append('```')
                lines.append(f['snippet'])
                lines.append('```')
            if f.get('suggestion'):
                lines.append('> **Suggestion:** %s' % f['suggestion'])
            lines.append('')

    return '\n'.join(lines)


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else '.'
    target_path = Path(os.path.expanduser(target)).resolve()

    if not target_path.exists():
        result = {
            'tool': 'perf-analyzer',
            'target': str(target_path),
            'scan_time_ms': 0,
            'file_count': 0,
            'finding_count': 0,
            'findings': [],
            'summary': 'Target not found: %s' % target,
        }
        print(json.dumps(result, indent=2))
        return

    t0 = time.time()
    files = collect_files(target_path)
    all_findings = []

    for fpath, lang in files:
        all_findings.extend(scan_file(fpath, lang))

    elapsed_ms = int((time.time() - t0) * 1000)

    # Deduplicate
    seen = set()
    deduped = []
    for f in all_findings:
        key = (f['file'], f['title'], f['line'])
        if key not in seen:
            seen.add(key)
            deduped.append(f)
    all_findings = deduped

    counts = {}
    for f in all_findings:
        counts[f['severity']] = counts.get(f['severity'], 0) + 1
    severity_order = ['critical', 'high', 'medium', 'low', 'info']
    summary_parts = ['%d %s' % (v, k) for k, v in
                     sorted(counts.items(), key=lambda x: severity_order.index(x[0])
                            if x[0] in severity_order else 99)]
    summary = '%d findings: %s' % (len(all_findings), ', '.join(summary_parts)) if all_findings else 'No issues found'

    for f in all_findings:
        f['file'] = str(f['file'])

    result = {
        'tool': 'perf-analyzer',
        'target': str(target_path),
        'scan_time_ms': elapsed_ms,
        'file_count': len(files),
        'finding_count': len(all_findings),
        'findings': all_findings,
        'summary': summary,
    }

    # Write markdown report for agents
    report_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'output')
    os.makedirs(report_dir, exist_ok=True)
    report_path = os.path.join(report_dir, 'perf-report.md')
    with open(report_path, 'w') as f:
        f.write(format_markdown_report(result))

    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
