# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""csv_splitter — Split a CSV file into smaller chunk files.

Usage as a pipeline block:
    Reads PIPELINE_INPUT (CSV file path)
    Writes chunks to PIPELINE_OUTPUT (directory path)

Config via BLOCK_CONFIG_* env vars:
    BLOCK_CONFIG_CHUNK_SIZE: rows per chunk (default: 500)
    BLOCK_CONFIG_FORMAT: output format 'csv' or 'json' (default: csv)
"""
import csv
import json
import os
import sys
from pathlib import Path


def split_csv(input_path: str, output_dir: str, chunk_size: int = 500, output_format: str = 'csv') -> int:
    """Split a CSV into chunks. Returns number of chunks created."""
    os.makedirs(output_dir, exist_ok=True)

    with open(input_path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            print("Error: CSV has no header row", file=sys.stderr)
            return 0

        headers = list(reader.fieldnames)
        chunk_num = 0
        rows: list[dict] = []

        for row in reader:
            rows.append(row)
            if len(rows) >= chunk_size:
                chunk_num += 1
                _write_chunk(rows, headers, output_dir, chunk_num, output_format)
                rows = []

        # Write remaining rows
        if rows:
            chunk_num += 1
            _write_chunk(rows, headers, output_dir, chunk_num, output_format)

    return chunk_num


def _write_chunk(rows: list[dict], headers: list[str], output_dir: str, chunk_num: int, fmt: str) -> None:
    """Write a single chunk file."""
    filename = f"chunk_{str(chunk_num).zfill(4)}.{fmt}"
    filepath = os.path.join(output_dir, filename)

    if fmt == 'json':
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(rows, f, indent=2, ensure_ascii=False)
    else:
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=headers)
            writer.writeheader()
            writer.writerows(rows)


def main():
    input_path = os.environ.get('PIPELINE_INPUT', '')
    output_dir = os.environ.get('PIPELINE_OUTPUT', '')
    chunk_size = int(os.environ.get('BLOCK_CONFIG_CHUNK_SIZE', '500'))
    output_format = os.environ.get('BLOCK_CONFIG_FORMAT', 'csv').lower()

    if not input_path or not Path(input_path).exists():
        print(f"Error: input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    if not output_dir:
        print("Error: PIPELINE_OUTPUT not set", file=sys.stderr)
        sys.exit(1)

    num_chunks = split_csv(input_path, output_dir, chunk_size, output_format)
    print(f"Split into {num_chunks} chunks of {chunk_size} rows each")
    print(f"Output: {output_dir}")


if __name__ == '__main__':
    main()
