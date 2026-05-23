# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""csv_merger — Merge multiple CSV or JSON chunk files into one.

Usage as a pipeline block:
    Reads PIPELINE_INPUT (directory of chunk files)
    Writes merged output to PIPELINE_OUTPUT (single file)

Config via BLOCK_CONFIG_* env vars:
    BLOCK_CONFIG_FORMAT: input/output format 'csv' or 'json' (default: csv)
    BLOCK_CONFIG_SORT_BY: column to sort merged result by (optional)
"""
import csv
import json
import os
import sys
from pathlib import Path


def merge_files(input_dir: str, output_path: str, fmt: str = 'csv', sort_by: str = '') -> int:
    """Merge chunk files from a directory. Returns total rows."""
    chunk_files = sorted(
        f for f in os.listdir(input_dir)
        if not f.startswith('.') and (f.endswith(f'.{fmt}') or f.endswith('.csv') or f.endswith('.json'))
    )

    if not chunk_files:
        print("Warning: no chunk files found", file=sys.stderr)
        # Write empty output
        with open(output_path, 'w') as f:
            f.write('[]' if fmt == 'json' else '')
        return 0

    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)

    if fmt == 'json':
        return _merge_json(input_dir, chunk_files, output_path, sort_by)
    else:
        return _merge_csv(input_dir, chunk_files, output_path, sort_by)


def _merge_csv(input_dir: str, files: list[str], output_path: str, sort_by: str) -> int:
    """Merge CSV chunks."""
    all_rows: list[dict] = []
    headers: list[str] = []

    for f in files:
        filepath = os.path.join(input_dir, f)
        with open(filepath, newline='', encoding='utf-8') as fh:
            reader = csv.DictReader(fh)
            if not headers and reader.fieldnames:
                headers = list(reader.fieldnames)
            for row in reader:
                all_rows.append(row)

    if sort_by and sort_by in headers:
        all_rows.sort(key=lambda r: r.get(sort_by, ''))

    with open(output_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        writer.writerows(all_rows)

    return len(all_rows)


def _merge_json(input_dir: str, files: list[str], output_path: str, sort_by: str) -> int:
    """Merge JSON chunks."""
    all_items: list = []

    for f in files:
        filepath = os.path.join(input_dir, f)
        with open(filepath, encoding='utf-8') as fh:
            try:
                data = json.load(fh)
                if isinstance(data, list):
                    all_items.extend(data)
                else:
                    all_items.append(data)
            except json.JSONDecodeError:
                all_items.append({'_file': f, '_error': 'Invalid JSON'})

    if sort_by:
        all_items.sort(key=lambda r: r.get(sort_by, '') if isinstance(r, dict) else '')

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(all_items, f, indent=2, ensure_ascii=False)

    return len(all_items)


def main():
    input_dir = os.environ.get('PIPELINE_INPUT', '')
    output_path = os.environ.get('PIPELINE_OUTPUT', '')
    fmt = os.environ.get('BLOCK_CONFIG_FORMAT', 'csv').lower()
    sort_by = os.environ.get('BLOCK_CONFIG_SORT_BY', '')

    if not input_dir or not Path(input_dir).is_dir():
        print(f"Error: input directory not found: {input_dir}", file=sys.stderr)
        sys.exit(1)

    if not output_path:
        print("Error: PIPELINE_OUTPUT not set", file=sys.stderr)
        sys.exit(1)

    total = merge_files(input_dir, output_path, fmt, sort_by)
    print(f"Merged {total} rows from {len(os.listdir(input_dir))} chunks")
    print(f"Output: {output_path}")


if __name__ == '__main__':
    main()
