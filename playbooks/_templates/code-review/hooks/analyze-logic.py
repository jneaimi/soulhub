#!/usr/bin/env python3
"""Static logic analysis for code review — finds common logic issues via regex + AST."""
import sys
import os
import json
import re
import ast
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
PYTHON_BUILTINS = {
    'id', 'type', 'list', 'dict', 'set', 'str', 'int', 'float', 'bool',
    'len', 'range', 'input', 'print', 'open', 'file', 'dir', 'map',
    'filter', 'zip', 'sum', 'min', 'max', 'any', 'all', 'format',
    'hash', 'hex', 'next', 'iter', 'object', 'bytes', 'tuple',
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


def check_python(filepath, line_num, line, stripped):
    findings = []

    # Bare except
    if re.match(r'^\s*except\s*:', line):
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'medium', 'category': 'error-handling',
            'title': 'Bare except clause',
            'description': 'Catches all exceptions including KeyboardInterrupt and SystemExit',
            'snippet': stripped,
            'suggestion': "Use 'except Exception:' to avoid catching system exits",
        })

    # == None / != None
    if re.search(r'[=!]=\s*None\b', stripped) and not stripped.lstrip().startswith('#'):
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'low', 'category': 'style',
            'title': 'Comparison to None using ==',
            'description': 'PEP 8 recommends using "is None" / "is not None"',
            'snippet': stripped,
            'suggestion': 'Use "is None" or "is not None"',
        })

    # Mutable default argument
    if re.match(r'^\s*def\s+\w+\(.*=\s*(\[\]|\{\})\s*[,)]', stripped):
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'high', 'category': 'logic-error',
            'title': 'Mutable default argument',
            'description': 'Default mutable arguments are shared between calls',
            'snippet': stripped,
            'suggestion': 'Use None as default and create inside function',
        })

    # assert used for validation (not in test files)
    if re.match(r'^\s*assert\s+', stripped) and 'test' not in str(filepath).lower():
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'medium', 'category': 'correctness',
            'title': 'Assert used for validation',
            'description': 'Assertions are stripped in optimized mode (-O)',
            'snippet': stripped,
            'suggestion': 'Use if/raise for input validation',
        })

    # type() comparison
    if re.search(r'type\(.+\)\s*==\s*', stripped) or re.search(r'==\s*type\(', stripped):
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'low', 'category': 'style',
            'title': 'type() comparison instead of isinstance()',
            'description': 'isinstance() handles inheritance correctly',
            'snippet': stripped,
            'suggestion': 'Use isinstance(obj, ClassName)',
        })

    # Variable shadowing builtins in function params
    m = re.match(r'^\s*def\s+\w+\(([^)]*)\)', stripped)
    if m:
        params = [p.strip().split(':')[0].split('=')[0].strip() for p in m.group(1).split(',')]
        for param in params:
            if param in PYTHON_BUILTINS:
                findings.append({
                    'file': str(filepath), 'line': line_num,
                    'severity': 'low', 'category': 'shadowing',
                    'title': 'Parameter shadows builtin "%s"' % param,
                    'description': 'Function parameter shadows Python builtin',
                    'snippet': stripped,
                    'suggestion': 'Rename parameter to avoid shadowing',
                })

    # Empty function body (just pass)
    if stripped == 'pass':
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'info', 'category': 'maintainability',
            'title': 'Empty function body (pass)',
            'description': 'Function or block contains only pass — may be unimplemented',
            'snippet': stripped,
        })

    # TODO/FIXME/HACK/XXX
    todo_match = re.search(r'#\s*(TODO|FIXME|HACK|XXX)\b(.{0,80})', stripped, re.IGNORECASE)
    if todo_match:
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'info', 'category': 'maintainability',
            'title': '%s comment' % todo_match.group(1).upper(),
            'description': todo_match.group(2).strip() or 'No description',
            'snippet': stripped,
        })

    return findings


def check_js_ts(filepath, line_num, line, stripped, lang):
    findings = []

    # Loose equality with null
    if re.search(r'[=!]=\s*null\b', stripped) and '===' not in stripped and '!==' not in stripped:
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'medium', 'category': 'correctness',
            'title': 'Loose equality with null',
            'description': '== null matches both null and undefined; use === for precision',
            'snippet': stripped,
            'suggestion': 'Use === null or === undefined',
        })

    # === undefined check (fragile)
    if re.search(r'===\s*undefined\b', stripped):
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'low', 'category': 'correctness',
            'title': '=== undefined check',
            'description': 'typeof x === "undefined" is safer; === undefined breaks if undefined is reassigned',
            'snippet': stripped,
            'suggestion': 'Use typeof x === "undefined" or nullish coalescing (??)',
        })

    # console.log in production code (skip test files)
    if re.search(r'\bconsole\.log\(', stripped) and 'test' not in str(filepath).lower():
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'low', 'category': 'cleanup',
            'title': 'console.log left in code',
            'description': 'Debug logging should be removed before production',
            'snippet': stripped,
            'suggestion': 'Remove or replace with proper logging',
        })

    # `any` type in TypeScript
    if lang == 'typescript' and re.search(r':\s*any\b', stripped):
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'low', 'category': 'type-safety',
            'title': '"any" type usage',
            'description': 'Using "any" defeats TypeScript type checking',
            'snippet': stripped,
            'suggestion': 'Use a specific type or "unknown"',
        })

    # Empty catch blocks
    if re.search(r'catch\s*\([^)]*\)\s*\{\s*\}', stripped):
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'medium', 'category': 'error-handling',
            'title': 'Empty catch block',
            'description': 'Silently swallowing errors hides bugs',
            'snippet': stripped,
            'suggestion': 'Log the error or handle it explicitly',
        })

    # var usage
    if re.match(r'^\s*var\s+', stripped):
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'low', 'category': 'style',
            'title': '"var" usage',
            'description': 'var has function-scoping issues; use let/const',
            'snippet': stripped,
            'suggestion': 'Replace var with let or const',
        })

    # Array mutation in state (.push in Svelte/React files)
    if re.search(r'\.\s*push\s*\(', stripped):
        ext = Path(filepath).suffix
        if ext in ('.svelte', '.tsx', '.jsx'):
            findings.append({
                'file': str(filepath), 'line': line_num,
                'severity': 'medium', 'category': 'reactivity',
                'title': 'Array mutation with .push()',
                'description': 'Direct mutation may not trigger reactivity in Svelte/React',
                'snippet': stripped,
                'suggestion': 'Use spread: arr = [...arr, item]',
            })

    # Empty function body {}
    if re.search(r'(?:=>|function\s*\([^)]*\))\s*\{\s*\}', stripped):
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'info', 'category': 'maintainability',
            'title': 'Empty function body',
            'description': 'Function has empty body — may be unimplemented',
            'snippet': stripped,
        })

    # Missing break in switch (detect case without break/return before next case)
    if re.match(r'^\s*case\s+', stripped):
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'info', 'category': 'switch-fallthrough',
            'title': 'Switch case (check for fallthrough)',
            'description': 'Verify intentional fallthrough — missing break causes bugs',
            'snippet': stripped,
        })

    # TODO/FIXME/HACK
    todo_match = re.search(r'(?://|/\*)\s*(TODO|FIXME|HACK|XXX)\b(.{0,80})', stripped, re.IGNORECASE)
    if todo_match:
        findings.append({
            'file': str(filepath), 'line': line_num,
            'severity': 'info', 'category': 'maintainability',
            'title': '%s comment' % todo_match.group(1).upper(),
            'description': todo_match.group(2).strip() or 'No description',
            'snippet': stripped,
        })

    return findings


def analyze_python_ast(filepath, source, file_lines):
    """AST-based analysis for Python files — catches things regex can't."""
    findings = []
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return findings

    for node in ast.walk(tree):
        # Overly complex function (rough size heuristic)
        if isinstance(node, ast.FunctionDef) or isinstance(node, ast.AsyncFunctionDef):
            dump_len = len(ast.dump(node))
            if dump_len > 5000:
                findings.append({
                    'file': str(filepath), 'line': node.lineno,
                    'severity': 'medium', 'category': 'complexity',
                    'title': 'Overly complex function: %s' % node.name,
                    'description': 'Function AST is very large (%d chars) — likely too complex' % dump_len,
                    'snippet': file_lines[node.lineno - 1].rstrip() if node.lineno <= len(file_lines) else '',
                    'suggestion': 'Consider breaking into smaller functions',
                })

            # Unreachable code after return/raise
            for i, stmt in enumerate(node.body):
                if isinstance(stmt, (ast.Return, ast.Raise)) and i < len(node.body) - 1:
                    next_stmt = node.body[i + 1]
                    # Skip if next is a function/class def (nested)
                    if not isinstance(next_stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        findings.append({
                            'file': str(filepath), 'line': next_stmt.lineno,
                            'severity': 'medium', 'category': 'correctness',
                            'title': 'Unreachable code after %s' % ('return' if isinstance(stmt, ast.Return) else 'raise'),
                            'description': 'Code after return/raise in function %s will never execute' % node.name,
                            'snippet': file_lines[next_stmt.lineno - 1].rstrip() if next_stmt.lineno <= len(file_lines) else '',
                            'suggestion': 'Remove unreachable code or fix control flow',
                        })

        # type() comparison via AST (more accurate than regex)
        if isinstance(node, ast.Compare):
            for op in node.ops:
                if isinstance(op, (ast.Eq, ast.NotEq)):
                    if isinstance(node.left, ast.Call) and isinstance(node.left.func, ast.Name) and node.left.func.id == 'type':
                        findings.append({
                            'file': str(filepath), 'line': node.lineno,
                            'severity': 'low', 'category': 'style',
                            'title': 'type() comparison (AST-detected)',
                            'description': 'isinstance() handles inheritance correctly',
                            'snippet': file_lines[node.lineno - 1].rstrip() if node.lineno <= len(file_lines) else '',
                            'suggestion': 'Use isinstance(obj, ClassName)',
                        })

    # Unused imports (basic: import name not referenced elsewhere in source)
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.asname or alias.name.split('.')[0]
                # Count occurrences of name in source (excluding the import line itself)
                lines_without_import = source[:source.find('\n' * 1)] + source[source.find('\n', source.find(name)):]
                count = len(re.findall(r'\b' + re.escape(name) + r'\b', source))
                if count <= 1:  # Only the import itself
                    findings.append({
                        'file': str(filepath), 'line': node.lineno,
                        'severity': 'low', 'category': 'cleanup',
                        'title': 'Possibly unused import: %s' % name,
                        'description': 'Imported name appears only in the import statement',
                        'snippet': file_lines[node.lineno - 1].rstrip() if node.lineno <= len(file_lines) else '',
                        'suggestion': 'Remove if unused',
                    })
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                name = alias.asname or alias.name
                if name == '*':
                    continue
                count = len(re.findall(r'\b' + re.escape(name) + r'\b', source))
                if count <= 1:
                    findings.append({
                        'file': str(filepath), 'line': node.lineno,
                        'severity': 'low', 'category': 'cleanup',
                        'title': 'Possibly unused import: %s' % name,
                        'description': 'Imported name appears only in the import statement',
                        'snippet': file_lines[node.lineno - 1].rstrip() if node.lineno <= len(file_lines) else '',
                        'suggestion': 'Remove if unused',
                    })

    return findings


def check_file_level(filepath, lines, lang):
    findings = []

    # Long function detection (> 50 lines)
    func_pattern = (r'^\s*(?:def|async\s+def)\s+(\w+)' if lang == 'python'
                    else r'^\s*(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\()')
    func_starts = []
    for i, line in enumerate(lines):
        m = re.match(func_pattern, line)
        if m:
            name = m.group(1) or (m.group(2) if m.lastindex >= 2 else None)
            func_starts.append((i, name or 'anonymous'))

    for idx, (start, name) in enumerate(func_starts):
        end = func_starts[idx + 1][0] if idx + 1 < len(func_starts) else len(lines)
        length = end - start
        if length > 50:
            findings.append({
                'file': str(filepath), 'line': start + 1,
                'severity': 'low', 'category': 'complexity',
                'title': 'Long function: %s (%d lines)' % (name, length),
                'description': 'Functions over 50 lines are hard to maintain',
                'snippet': lines[start].rstrip(),
                'suggestion': 'Consider extracting sub-functions',
            })

    # Deep nesting (> 4 levels)
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        if lang == 'python':
            indent = len(line) - len(line.lstrip())
            depth = indent // 4
        else:
            depth = 0
            for ch in line:
                if ch in (' ', '\t'):
                    depth += 1
                else:
                    break
            depth = depth // 2 if '\t' not in line else depth
        if depth > 4 and line.strip() and not line.strip().startswith(('#', '//', '/*', '*')):
            findings.append({
                'file': str(filepath), 'line': i + 1,
                'severity': 'low', 'category': 'complexity',
                'title': 'Deeply nested code (depth %d)' % depth,
                'description': 'Deep nesting reduces readability',
                'snippet': line.rstrip(),
                'suggestion': 'Extract to helper or use early returns',
            })
            break  # Only flag once per file

    # Unreachable code after return/raise/break/continue (Python — regex fallback)
    if lang == 'python':
        for i, line in enumerate(lines):
            stripped = line.strip()
            if re.match(r'^(return|raise|break|continue)\b', stripped):
                indent = len(line) - len(line.lstrip())
                for j in range(i + 1, min(i + 5, len(lines))):
                    next_line = lines[j]
                    next_stripped = next_line.strip()
                    if not next_stripped:
                        continue
                    next_indent = len(next_line) - len(next_line.lstrip())
                    if next_indent > indent and not next_stripped.startswith(('#', 'except', 'elif', 'else', 'finally')):
                        findings.append({
                            'file': str(filepath), 'line': j + 1,
                            'severity': 'medium', 'category': 'correctness',
                            'title': 'Potentially unreachable code',
                            'description': 'Code after %s statement' % stripped.split()[0],
                            'snippet': next_stripped,
                        })
                    break

    # JS/TS: unused imports (basic regex — imported name not found elsewhere)
    if lang in ('javascript', 'typescript'):
        content = '\n'.join(lines)
        for i, line in enumerate(lines):
            m = re.match(r"^\s*import\s+\{([^}]+)\}\s+from\s+['\"]", line)
            if m:
                names = [n.strip().split(' as ')[-1].strip() for n in m.group(1).split(',')]
                for name in names:
                    if not name:
                        continue
                    count = len(re.findall(r'\b' + re.escape(name) + r'\b', content))
                    if count <= 1:
                        findings.append({
                            'file': str(filepath), 'line': i + 1,
                            'severity': 'low', 'category': 'cleanup',
                            'title': 'Possibly unused import: %s' % name,
                            'description': 'Imported name appears only in the import statement',
                            'snippet': line.rstrip(),
                            'suggestion': 'Remove if unused',
                        })

    # JS/TS: switch fallthrough detection
    if lang in ('javascript', 'typescript'):
        in_switch = False
        case_line = None
        had_break = False
        for i, line in enumerate(lines):
            stripped = line.strip()
            if re.match(r'switch\s*\(', stripped):
                in_switch = True
                continue
            if not in_switch:
                continue
            if re.match(r'case\s+|default\s*:', stripped):
                if case_line is not None and not had_break:
                    findings.append({
                        'file': str(filepath), 'line': case_line,
                        'severity': 'medium', 'category': 'correctness',
                        'title': 'Switch case fallthrough',
                        'description': 'Case at line %d falls through to next case without break/return' % case_line,
                        'snippet': lines[case_line - 1].rstrip(),
                        'suggestion': 'Add break, return, or // fallthrough comment',
                    })
                case_line = i + 1
                had_break = False
            if re.match(r'(break|return|throw|continue)\b', stripped):
                had_break = True
            if re.search(r'//\s*fallthrough', stripped, re.IGNORECASE):
                had_break = True
            if stripped == '}':
                in_switch = False
                case_line = None

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
    lines = ['# Logic Analysis Report\n']
    lines.append('**Target:** `%s`' % result['target'])
    lines.append('**Files scanned:** %d | **Findings:** %d | **Time:** %dms\n' % (
        result['file_count'], result['finding_count'], result['scan_time_ms']))

    if not result['findings']:
        lines.append('No logic issues found.\n')
        lines.append('> Agent: Do a focused 3-minute spot-check of the most complex files only.\n')
        return '\n'.join(lines)

    lines.append('## Summary\n')
    lines.append(result['summary'] + '\n')

    # Group by severity
    by_severity = {}
    for f in result['findings']:
        by_severity.setdefault(f['severity'], []).append(f)

    for sev in ('high', 'medium', 'low', 'info'):
        group = by_severity.get(sev, [])
        if not group:
            continue
        lines.append('## %s (%d)\n' % (sev.upper(), len(group)))
        for f in group:
            lines.append('### %s' % f['title'])
            lines.append('- **File:** `%s:%d`' % (f['file'], f['line']))
            lines.append('- **Category:** %s' % f['category'])
            lines.append('- **Description:** %s' % f['description'])
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
            'tool': 'logic-analyzer',
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
        try:
            source = open(fpath, errors='ignore').read()
            file_lines = source.split('\n')
        except Exception:
            continue

        for i, line in enumerate(file_lines, 1):
            stripped = line.strip()
            if not stripped or stripped.startswith('#') or stripped.startswith('//'):
                continue
            if lang == 'python':
                all_findings.extend(check_python(fpath, i, line, stripped))
            elif lang in ('javascript', 'typescript'):
                all_findings.extend(check_js_ts(fpath, i, line, stripped, lang))

        all_findings.extend(check_file_level(fpath, file_lines, lang))

        # AST analysis for Python files
        if lang == 'python':
            all_findings.extend(analyze_python_ast(fpath, source, file_lines))

    # Deduplicate (same file + line + title)
    seen = set()
    deduped = []
    for f in all_findings:
        key = (f['file'], f['line'], f['title'])
        if key not in seen:
            seen.add(key)
            deduped.append(f)
    all_findings = deduped

    # Add code context to all findings
    file_cache = {}
    for f in all_findings:
        fpath = f['file']
        if fpath not in file_cache:
            try:
                file_cache[fpath] = open(fpath, errors='ignore').readlines()
            except Exception:
                file_cache[fpath] = []
        cached_lines = file_cache[fpath]
        if cached_lines:
            f['context'] = get_code_context(cached_lines, f['line'])

    elapsed_ms = int((time.time() - t0) * 1000)

    # Build summary
    counts = {}
    for f in all_findings:
        counts[f['severity']] = counts.get(f['severity'], 0) + 1
    summary_parts = ['%d %s' % (v, k) for k, v in
                     sorted(counts.items(), key=lambda x: ['critical', 'high', 'medium', 'low', 'info'].index(x[0])
                            if x[0] in ['critical', 'high', 'medium', 'low', 'info'] else 99)]
    summary = '%d findings: %s' % (len(all_findings), ', '.join(summary_parts)) if all_findings else 'No issues found'

    # Convert Path objects to strings for JSON serialization
    for f in all_findings:
        f['file'] = str(f['file'])

    result = {
        'tool': 'logic-analyzer',
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
    report_path = os.path.join(report_dir, 'logic-report.md')
    with open(report_path, 'w') as f:
        f.write(format_markdown_report(result))

    # Print JSON for engine
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
