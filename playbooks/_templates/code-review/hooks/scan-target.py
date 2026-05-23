#!/usr/bin/env python3
"""
Scan a target directory and output metrics for dynamic playbook timeout.
Used as a pre_run hook in code review and similar playbooks.

Usage: python3 hooks/scan-target.py <target_path>
Output: JSON to stdout with file_count, total_lines, languages, estimated_timeout_sec, summary
"""
import sys
import os
import json
from pathlib import Path

# Directories to skip
SKIP_DIRS = {
    'node_modules', '.git', '__pycache__', 'dist', '.next', '.svelte-kit',
    'build', 'coverage', '.turbo', '.cache', 'vendor', 'target',
    '.venv', 'venv', 'env', '.env', '.output', '.nuxt',
}

# Extension to language mapping
EXT_MAP = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
    '.py': 'python',
    '.svelte': 'svelte',
    '.vue': 'vue',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.kt': 'kotlin',
    '.swift': 'swift',
    '.rb': 'ruby',
    '.php': 'php',
    '.css': 'css', '.scss': 'scss',
    '.html': 'html',
    '.md': 'markdown',
    '.json': 'json',
    '.yaml': 'yaml', '.yml': 'yaml',
    '.sql': 'sql',
    '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
}

# Binary/large file extensions to skip
SKIP_EXTS = {
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
    '.woff', '.woff2', '.ttf', '.eot',
    '.zip', '.tar', '.gz', '.bz2',
    '.pdf', '.doc', '.docx',
    '.mp3', '.mp4', '.mov', '.avi',
    '.lock', '.map',
}


def scan_target(target):
    target_path = Path(os.path.expanduser(target)).resolve()

    if not target_path.exists():
        return {
            "error": "Target not found: %s" % target,
            "file_count": 0,
            "total_lines": 0,
            "languages": [],
            "estimated_timeout_sec": 600,
            "size_category": "unknown",
            "summary": "Target not found: %s" % target,
        }

    # If target is a file, just analyze that file
    if target_path.is_file():
        lines = 0
        try:
            lines = sum(1 for _ in open(target_path, errors='ignore'))
        except Exception:
            pass
        ext = target_path.suffix
        lang = EXT_MAP.get(ext, 'unknown')
        return {
            "file_count": 1,
            "total_lines": lines,
            "languages": [lang] if lang != 'unknown' else [],
            "estimated_timeout_sec": 180,
            "size_category": "tiny",
            "summary": "1 file, %s lines, %s" % ("{:,}".format(lines), lang),
        }

    # Scan directory
    files = []
    total_lines = 0
    languages = {}

    for root, dirs, filenames in os.walk(target_path):
        # Skip unwanted directories (keep .claude which has real project files)
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and d not in ('.git', '.svn', '.hg')]

        for fname in filenames:
            fpath = Path(root) / fname
            ext = fpath.suffix.lower()

            # Skip binary/large files
            if ext in SKIP_EXTS:
                continue

            files.append(fpath)

            # Count lines
            try:
                line_count = sum(1 for _ in open(fpath, errors='ignore'))
                total_lines += line_count
            except Exception:
                pass

            # Track language
            lang = EXT_MAP.get(ext)
            if lang:
                languages[lang] = languages.get(lang, 0) + 1

    file_count = len(files)

    # Calculate dynamic timeout
    # Real-world observation: agents need ~40s per file (read + analyze) + thinking time
    # Formula: 600s base + 40s/file + 90s per 1000 lines, capped at 1800s (30 min)
    timeout = min(
        600 + (file_count * 40) + (total_lines / 1000 * 90),
        1800
    )
    timeout = max(timeout, 600)  # minimum 10 minutes

    # Size category
    if file_count < 10:
        size_category = "tiny"
    elif file_count < 30:
        size_category = "small"
    elif file_count < 100:
        size_category = "medium"
    elif file_count < 300:
        size_category = "large"
    else:
        size_category = "very-large"

    # Top languages by file count
    top_languages = sorted(languages.keys(), key=lambda k: languages[k], reverse=True)[:5]

    top_3 = top_languages[:3]
    summary_langs = ', '.join(top_3) if top_3 else 'unknown'

    return {
        "file_count": file_count,
        "total_lines": total_lines,
        "languages": top_languages,
        "language_breakdown": dict(sorted(languages.items(), key=lambda x: -x[1])[:10]),
        "estimated_timeout_sec": int(timeout),
        "size_category": size_category,
        "summary": "%d files, %s lines, %s" % (file_count, "{:,}".format(total_lines), summary_langs),
    }


if __name__ == '__main__':
    target = sys.argv[1] if len(sys.argv) > 1 else '.'
    result = scan_target(target)
    print(json.dumps(result, indent=2))
