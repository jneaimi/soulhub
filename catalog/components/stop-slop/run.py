#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
stop-slop component v1.0.0 — deterministic content quality gate.

I/O contract (see BLOCK.md):
  stdin:  { text: str, rubric?: str, min_score?: int, block_on_fail?: bool }
  stdout: { score, passed, per_dimension, hard_violations, soft_violation_count, by_kind }
  exit:   0 pass | 6 fail (when block_on_fail) | 2 bad input

Detection + scoring live in catalog/components/_shared/stop_slop_rules.py
(ADR-035 P1) — the single source of truth shared with
scripts/peer-brief/stop-slop-scan.py. This file owns only the stdin-json I/O
shell.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

# Shared rubric core (ADR-035 P1). cwd-independent: resolves the sibling
# _shared dir relative to this file, not the runner's working directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "_shared"))
from stop_slop_rules import compute_scores, scan_text  # noqa: E402


def score_violations(all_violations: list[dict]) -> dict:
    """Reshape the shared score to this component's contract (`total` → `score`)."""
    s = compute_scores(all_violations)
    return {
        "per_dimension": s["per_dimension"],
        "score": s["total"],
        "hard_violation_count": s["hard_violation_count"],
        "soft_violation_count": s["soft_violation_count"],
        "by_kind": s["by_kind"],
    }


# ── Entry point ────────────────────────────────────────────────────────────

def fail(msg: str) -> int:
    print(json.dumps({"error": msg}), file=sys.stdout)
    return 2


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        return fail(f"stdin is not valid JSON: {e}")

    if not isinstance(payload, dict):
        return fail("stdin JSON must be an object")

    text = payload.get("text")
    if not isinstance(text, str):
        return fail("missing or non-string `text` field")

    rubric = payload.get("rubric", "default")
    if rubric not in ("default", "peer-brief", "linkedin", "arabic"):
        return fail(f"unknown rubric: {rubric!r}")

    min_score = payload.get("min_score", 35)
    if not isinstance(min_score, int) or not 0 <= min_score <= 50:
        return fail("`min_score` must be int 0..50")

    block_on_fail = payload.get("block_on_fail", True)
    if not isinstance(block_on_fail, bool):
        return fail("`block_on_fail` must be bool")

    violations = scan_text(text)
    scored = score_violations(violations)

    hard_violations = [v for v in violations if v["kind"].endswith(".HARD")]
    passed = scored["score"] >= min_score and scored["hard_violation_count"] == 0

    result: dict[str, Any] = {
        "score": scored["score"],
        "passed": passed,
        "per_dimension": scored["per_dimension"],
        "hard_violations": hard_violations,
        "soft_violation_count": scored["soft_violation_count"],
        "by_kind": scored["by_kind"],
        "min_score": min_score,
        "rubric": rubric,
    }

    print(json.dumps(result, indent=2))

    if not passed and block_on_fail:
        return 6
    return 0


if __name__ == "__main__":
    sys.exit(main())
