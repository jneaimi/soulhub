# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""BLOCK_NAME — DESCRIPTION."""
# Check components/ before writing utility code: api_client, csv_writer, error_handler, progress
# Add dependencies above (e.g. "pandas", "requests") — uv run installs them automatically
import os, json, sys
from pathlib import Path

# Add components to import path — use PIPELINE_DIR (set by runner) for reliability
_comp = Path(os.environ.get("PIPELINE_DIR", "")).parent / "_builder" / "components"
if not _comp.is_dir():
    _comp = Path(__file__).resolve().parent
    while _comp != _comp.parent:
        if (_comp / "_builder" / "components").is_dir():
            _comp = _comp / "_builder" / "components"
            break
        _comp = _comp.parent
sys.path.insert(0, str(_comp))
from error_handler import with_error_handling

# Pipeline context
PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
DB_PATH = PIPELINE_DIR / "db" / os.environ.get("BLOCK_DATABASE", "data.db")
INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")

# Multi-input: PIPELINE_INPUT (primary), PIPELINE_INPUT_0..N, PIPELINE_INPUT_COUNT
# INPUT_COUNT = int(os.environ.get("PIPELINE_INPUT_COUNT", "1"))

# Config from BLOCK_CONFIG_* env vars
# PARAM = os.environ.get("BLOCK_CONFIG_PARAM_NAME", "default")


def main():
    # 1. Read input
    if INPUT_PATH and Path(INPUT_PATH).exists():
        with open(INPUT_PATH) as f:
            data = json.load(f)
    else:
        data = {}

    # 2. Process
    result = {"status": "ok"}

    # 3. Write output
    if OUTPUT_PATH:
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w") as f:
            json.dump(result, f, indent=2)
        print(f"Output: {OUTPUT_PATH}")
    else:
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    with_error_handling(main)()
