#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# ///
"""
pick-cover.py — deterministic daily cover-image selector (ADR-034 adjustment).

Picks today's peer-brief cover background from a pool of pre-generated images,
rotating by date so the cover image is a DETERMINISTIC slot — no model call, no
image-provider layer, reproducible (the same date always yields the same cover).

Selection: sorted(pool)[ date.toordinal() % N ]. Stable ordering + modular
rotation walks the whole pool across the calendar.

Emits a JSON object on stdout:
    { "image": "<absolute path>", "pool_size": int, "index": int, "date": "..." }

Exit: 0 ok | 2 bad input (no pool, bad date).

Usage:
    uv run pick-cover.py --date 2026-05-20
    uv run pick-cover.py --date 2026-05-20 --covers-dir /abs/path/to/covers
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

# Default pool: the jneaimi brand cover assets in this repo.
DEFAULT_COVERS = (
    Path(__file__).resolve().parents[2] / "catalog/brands/jneaimi/covers"
)
IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def fail(msg: str) -> int:
    print(json.dumps({"error": msg}))
    return 2


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--date", default=dt.date.today().isoformat(), help="YYYY-MM-DD anchor (default: today)")
    ap.add_argument("--covers-dir", default=str(DEFAULT_COVERS), help="Pool directory of cover images")
    ns = ap.parse_args()

    try:
        anchor = dt.date.fromisoformat(ns.date)
    except ValueError:
        return fail(f"bad --date {ns.date!r} (expected YYYY-MM-DD)")

    pool_dir = Path(ns.covers_dir).expanduser()
    if not pool_dir.is_dir():
        return fail(f"covers dir not found: {pool_dir}")

    pool = sorted(p for p in pool_dir.iterdir() if p.suffix.lower() in IMG_EXTS)
    if not pool:
        return fail(f"no cover images in {pool_dir}")

    index = anchor.toordinal() % len(pool)
    chosen = pool[index].resolve()

    print(
        json.dumps(
            {
                "image": str(chosen),
                "pool_size": len(pool),
                "index": index,
                "date": ns.date,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
