#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""
stop-slop-scan.py — Deterministic stop-slop gate for synthesised peer-brief
recipes.

Reads a katib recipe / doc-render composition YAML, extracts every prose field
(callout body, module raw_body, pull-quote text, captions, subtitles), and
scans for violations of the stop-slop discipline. Outputs JSON with the
per-dimension breakdown and a 0-50 score. Exits non-zero if score is below the
threshold or any HARD violation is present.

Detection + scoring live in catalog/components/_shared/stop_slop_rules.py
(ADR-035 P1) — the single source of truth shared with the `stop-slop`
component. This script owns only the recipe-walking extraction + the argv/YAML
I/O shell, so legacy scripts/peer-brief-render.py keeps calling it unchanged.

Hard violations (each is one demerit + a fail flag):
  - em-dash (`—` or `--` between words)
  - throat-clearing openers / emphasis crutches / meta-commentary (banned lists)
  - vague declaratives / "not X, it's Y" rhetorical contrasts

Soft violations (each is one demerit, no fail flag):
  - adverb crutches / filler phrases / lazy extremes / inanimate-subject

Scoring (5 dimensions, 0-10 each, sum 0-50). Each dimension floors at 0.

Usage:
    uv run stop-slop-scan.py path/to/recipe.yaml
    uv run stop-slop-scan.py path/to/recipe.yaml --min-score 40
    uv run stop-slop-scan.py path/to/recipe.yaml --json-only

Exit codes:
    0  pass
    6  fail (score below threshold OR any HARD violation)
    2  bad input
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

# Shared rubric core (ADR-035 P1). cwd-independent: resolves the catalog
# _shared dir relative to this file (repo-root/catalog/components/_shared).
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "catalog/components/_shared"))
from stop_slop_rules import compute_scores, scan_text  # noqa: E402


# ── Recipe extraction ──────────────────────────────────────────────────────

def extract_prose(recipe: dict) -> list[tuple[str, str]]:
    """Walk a recipe and return [(origin, text), ...] for every prose field.

    Origins:
      - 'cover.subtitle'
      - 'callout.body[i]'
      - 'module.raw_body[i]'
      - 'pull-quote.text[i]'
      - 'caption[component name][i]'
    """
    out: list[tuple[str, str]] = []
    # katib recipe shape uses `sections`; the doc-render composition shape
    # (ADR-034) uses `composition` — both are [{component, inputs}], so the
    # per-entry extraction below is identical.
    sections = recipe.get("sections") or recipe.get("composition", [])
    callout_idx = module_idx = quote_idx = caption_idx = 0

    for sec in sections:
        comp = sec.get("component", "")
        inputs = sec.get("inputs") or sec.get("inputs_by_lang", {}).get("en", {}) or {}

        if comp == "cover-page":
            sub = inputs.get("subtitle")
            if sub:
                out.append(("cover.subtitle", sub))
        elif comp == "callout":
            body = inputs.get("body")
            if body:
                out.append((f"callout.body[{callout_idx}]", body))
                callout_idx += 1
        elif comp == "module":
            raw = inputs.get("raw_body")
            if raw:
                out.append((f"module.raw_body[{module_idx}]", raw))
                module_idx += 1
        elif comp == "pull-quote":
            txt = inputs.get("text") or inputs.get("quote")
            if txt:
                out.append((f"pull-quote.text[{quote_idx}]", txt))
                quote_idx += 1

        cap = inputs.get("caption")
        if cap:
            out.append((f"caption[{comp}][{caption_idx}]", cap))
            caption_idx += 1

    return out


# ── Detection (per-block, with provenance) ─────────────────────────────────

def scan_block(origin: str, raw: str) -> dict:
    """Scan one prose block via the shared core and tag each hit with origin."""
    violations = scan_text(raw)
    for v in violations:
        v["origin"] = origin
    return {"origin": origin, "violations": violations}


# ── Scoring (flat shape this script + peer-brief-render.py expect) ─────────

def score_violations(all_violations: list[dict]) -> dict:
    s = compute_scores(all_violations)
    pd = s["per_dimension"]
    return {
        "directness": pd["directness"],
        "rhythm": pd["rhythm"],
        "trust": pd["trust"],
        "authenticity": pd["authenticity"],
        "density": pd["density"],
        "total": s["total"],
        "hard_violation_count": s["hard_violation_count"],
        "by_kind": s["by_kind"],
    }


# ── Main ───────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("recipe", help="Path to a katib recipe YAML")
    ap.add_argument("--min-score", type=int, default=30, help="Minimum total score (0-50, default: 30 — calibrated against the canonical 14-May recipe scoring 41 after em-dash fix)")
    ap.add_argument("--max-hard", type=int, default=0, help="Maximum HARD violations allowed (default: 0). Em-dashes always count as HARD.")
    ap.add_argument("--json-only", action="store_true", help="Suppress human-readable output")
    args = ap.parse_args()

    recipe_path = Path(args.recipe)
    if not recipe_path.exists():
        print(json.dumps({"error": f"recipe not found: {recipe_path}"}), file=sys.stderr)
        return 2

    try:
        recipe = yaml.safe_load(recipe_path.read_text())
    except yaml.YAMLError as e:
        print(json.dumps({"error": f"yaml parse failed: {e}"}), file=sys.stderr)
        return 2

    if not isinstance(recipe, dict):
        print(json.dumps({"error": "recipe is not a mapping"}), file=sys.stderr)
        return 2

    blocks = extract_prose(recipe)
    all_violations: list[dict] = []
    block_reports = []
    for origin, raw in blocks:
        report = scan_block(origin, raw)
        block_reports.append(report)
        all_violations.extend(report["violations"])

    score = score_violations(all_violations)

    pass_score = score["total"] >= args.min_score
    pass_hard = score["hard_violation_count"] <= args.max_hard
    passed = pass_score and pass_hard

    result = {
        "recipe": str(recipe_path),
        "passed": passed,
        "score": score,
        "min_score": args.min_score,
        "max_hard": args.max_hard,
        "blocks_scanned": len(blocks),
        "violations": all_violations,
    }

    print(json.dumps(result, indent=2))

    if not args.json_only:
        verdict = "PASS" if passed else "FAIL"
        print(f"\n[stop-slop {verdict}] score={score['total']}/50 (min {args.min_score}) hard={score['hard_violation_count']} (max {args.max_hard})", file=sys.stderr)
        if not passed:
            print(f"[stop-slop FAIL] dimensions: directness={score['directness']} rhythm={score['rhythm']} trust={score['trust']} authenticity={score['authenticity']} density={score['density']}", file=sys.stderr)
            top_kinds = sorted(score["by_kind"].items(), key=lambda kv: -kv[1])[:5]
            for kind, n in top_kinds:
                print(f"[stop-slop FAIL] {kind}: {n}", file=sys.stderr)

    return 0 if passed else 6


if __name__ == "__main__":
    sys.exit(main())
