#!/usr/bin/env -S uv run --quiet python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "httpx>=0.27",
# ]
# ///
"""peer-brief-parity-3way.py — ADR-022 daily parity harness.

Runs at 08:45 Dubai (after both pipelines complete). Pulls per-pipeline:
  - Wall clock (audit-trail for v2; legacy not in db)
  - Cost (audit-trail for v2; manual N/A for legacy)
  - Stop-slop score (v2: ~/.soul-hub/data/naseej/runs/<run_id>/scan.stop-slop.json;
                    legacy: /tmp/peer-brief-legacy-<DATE>.stop-slop.json if patch landed)
  - PDF: page count + word count + headline + tagline (pdftotext + pdfinfo)

Writes:
  ~/vault/projects/naseej/research/shadow-week-<DATE>.md  via the vault API

Per ADR-022 F2 (operator-clarified 2026-05-19: Python via uv run, not shell).
"""
import argparse
import json
import os
import subprocess
import sys
import sqlite3
from datetime import date
from pathlib import Path

import httpx

NASEEJ_DB = Path.home() / ".soul-hub" / "data" / "naseej.db"
SOUL_HUB_BASE = os.environ.get("SOUL_HUB_BASE", "http://localhost:2400")
DOWNLOADS = Path.home() / "Downloads"
NASEEJ_RUNS = Path.home() / ".soul-hub" / "data" / "naseej" / "runs"


def query_v2_run(run_date: str) -> dict | None:
    """SQL on naseej.db for today's last successful (or attempted) v2 run.

    Returns None if naseej.db is missing or no row matches. Prefers a successful
    row when one exists for the date; falls back to most recent failed otherwise
    so the parity table still surfaces a v2 attempt.
    """
    if not NASEEJ_DB.exists():
        return None
    conn = sqlite3.connect(str(NASEEJ_DB))
    conn.row_factory = sqlite3.Row
    # Prefer success on this date; fall back to most recent any-status on this date.
    cur = conn.execute(
        """SELECT * FROM naseej_runs
           WHERE recipe = 'peer-brief-v2'
             AND DATE(started_at/1000, 'unixepoch', 'localtime') = ?
           ORDER BY (status = 'success') DESC, started_at DESC
           LIMIT 1""",
        (run_date,),
    )
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    return dict(row)


def pdf_metrics(pdf_path: Path) -> dict:
    """Return page_count, word_count, headline, tagline, size."""
    if not pdf_path.exists():
        return {"error": f"PDF not found: {pdf_path}"}
    txt_proc = subprocess.run(
        ["pdftotext", "-layout", str(pdf_path), "-"],
        capture_output=True, text=True,
    )
    if txt_proc.returncode != 0:
        return {"error": f"pdftotext failed: {txt_proc.stderr[:200]}"}
    text = txt_proc.stdout

    info_proc = subprocess.run(
        ["pdfinfo", str(pdf_path)], capture_output=True, text=True
    )
    page_count = 0
    if info_proc.returncode == 0:
        for line in info_proc.stdout.split("\n"):
            if line.startswith("Pages:"):
                try:
                    page_count = int(line.split(":")[1].strip())
                except ValueError:
                    pass
                break

    lines = [l.strip() for l in text.split("\n") if l.strip()]
    headline = (lines[0] if lines else "")[:80]
    tagline = (lines[1] if len(lines) > 1 else "")[:120]
    return {
        "page_count": page_count,
        "word_count": len(text.split()),
        "headline": headline,
        "tagline": tagline,
        "size_bytes": pdf_path.stat().st_size,
    }


def read_stop_slop(json_path: Path) -> dict:
    """Read a stop-slop scorecard JSON file. Handles both shapes:
    - Naseej runner writes {score: {total: N, directness: ..., ...}, passed: bool}
    - Legacy patch (if landed) writes {score: N, passed: bool}
    """
    if not json_path.exists():
        return {"score": None, "note": f"not found: {json_path}"}
    try:
        data = json.loads(json_path.read_text())
    except json.JSONDecodeError as e:
        return {"score": None, "note": f"invalid JSON: {e}"}
    raw_score = data.get("score")
    # Naseej shape: score is a dict containing 'total'
    if isinstance(raw_score, dict):
        score = raw_score.get("total")
        per_dim = {k: v for k, v in raw_score.items() if k != "total"}
    else:
        # Legacy/flat shape: score is the integer total
        score = raw_score
        per_dim = data.get("per_dimension")
    return {
        "score": score,
        "passed": data.get("passed"),
        "per_dimension": per_dim,
        "hard_violation_count": (raw_score.get("hard_violation_count") if isinstance(raw_score, dict) else data.get("hard_violation_count")),
    }


def collect_legacy(run_date: str) -> dict:
    """Legacy pipeline data: PDF metrics + stop-slop (if instrumentation patch landed)."""
    pdf = DOWNLOADS / f"peer-brief-{run_date}.en.pdf"
    ss = Path(f"/tmp/peer-brief-legacy-{run_date}.stop-slop.json")
    return {
        "pdf": pdf_metrics(pdf),
        "stop_slop": read_stop_slop(ss) if ss.exists() else {"score": None, "note": "instrumentation patch pending (ADR-022 build-surface item 6)"},
        "wall_s": None,
        "cost_usd": None,
        "note": "legacy pipeline does not write to naseej.db; wall + cost are manual",
    }


def collect_v2(run_date: str) -> dict:
    """Naseej v2 pipeline data: audit-trail row + PDF metrics + stop-slop from run dir."""
    row = query_v2_run(run_date)
    if row is None:
        return {"error": f"no peer-brief-v2 run found in naseej.db for {run_date}"}
    pdf = DOWNLOADS / f"peer-brief-{run_date}-v2.en.pdf"
    run_id = row.get("run_id", "")
    # Try a few known filenames — runner writes `stop-slop.json` per current
    # peer-brief-v2 recipe; older recipes used `scan.stop-slop.json`.
    candidates = [
        NASEEJ_RUNS / run_id / "stop-slop.json",
        NASEEJ_RUNS / run_id / "scan.stop-slop.json",
    ]
    ss = next((p for p in candidates if p.exists()), candidates[0])
    duration_ms = row.get("duration_ms") or 0
    return {
        "pdf": pdf_metrics(pdf),
        "stop_slop": read_stop_slop(ss),
        "wall_s": duration_ms / 1000 if duration_ms else None,
        "cost_usd": row.get("cost_usd"),
        "status": row.get("status"),
        "run_id": run_id,
        "recipe_version": row.get("recipe_version"),
        "error_from_run": row.get("error"),
        "failed_step": row.get("failed_step"),
    }


def fmt(value, suffix=""):
    """Format a value for the markdown table; — when None."""
    if value is None or value == "":
        return "—"
    return f"{value}{suffix}"


def evaluate_wall(legacy_wall, v2_wall):
    if legacy_wall is None or v2_wall is None:
        return "INDETERMINATE (missing wall data)"
    ratio = v2_wall / legacy_wall
    target = 0.6
    return f"v2/legacy = {ratio:.2f}× (target ≤ {target}×) — {'PASS' if ratio <= target else 'FAIL'}"


def evaluate_stop_slop(legacy_score, v2_score):
    if legacy_score is None or v2_score is None:
        return "INDETERMINATE (missing stop-slop data)"
    return f"v2 {v2_score}/50 vs legacy {legacy_score}/50 — {'PASS' if v2_score >= legacy_score else 'FAIL'}"


def render_parity_md(run_date: str, legacy: dict, v2: dict) -> str:
    """Markdown body for the daily parity report."""
    legacy_pdf = legacy.get("pdf") or {}
    legacy_ss = legacy.get("stop_slop") or {}
    v2_pdf = v2.get("pdf") or {}
    v2_ss = v2.get("stop_slop") or {}

    legacy_wall = legacy.get("wall_s")
    v2_wall = v2.get("wall_s")
    legacy_score = legacy_ss.get("score")
    v2_score = v2_ss.get("score")

    return f"""# Peer-brief shadow parity — {run_date}

> Generated by `scripts/peer-brief-parity-3way.py` per [[../adr-022-synth-decomposition-shadow|ADR-022]] F2.
> Operator: fill the **Rating** + **Justification** cells via vim edit at end-of-day.

## Summary

Daily parity row for the ADR-022 peer-brief shadow window. One row per pipeline (legacy + Naseej v2). The codified decision rule fires at 2026-05-29 against the aggregated rows. Wall: {fmt(legacy_wall, 's')} vs {fmt(v2_wall, 's')}. Stop-slop: {fmt(legacy_score)}/50 vs {fmt(v2_score)}/50.

## Key Findings

### Parity table

| Pipeline | Wall (s) | Cost ($) | Stop-slop | Pages | Words | Headline | Rating (1-5) | Justification |
|---|---|---|---|---|---|---|---|---|
| Legacy | {fmt(legacy_wall)} | {fmt(legacy.get('cost_usd'))} | {fmt(legacy_score)}/50 | {fmt(legacy_pdf.get('page_count'))} | {fmt(legacy_pdf.get('word_count'))} | {fmt(legacy_pdf.get('headline'))} | _fill_ | _fill_ |
| Naseej v2 | {fmt(v2_wall)} | {fmt(v2.get('cost_usd'))} | {fmt(v2_score)}/50 | {fmt(v2_pdf.get('page_count'))} | {fmt(v2_pdf.get('word_count'))} | {fmt(v2_pdf.get('headline'))} | _fill_ | _fill_ |

### Tagline column (overflow)

- **Legacy:** {fmt(legacy_pdf.get('tagline'))}
- **Naseej v2:** {fmt(v2_pdf.get('tagline'))}

### Decision-rule cells (codified per ADR-022 §"Decision rule")

- **Wall:** {evaluate_wall(legacy_wall, v2_wall)}
- **Stop-slop:** {evaluate_stop_slop(legacy_score, v2_score)}
- **Manual rating:** _fill via vim edit_ (v2 ≥ legacy required)

## Sources

- Naseej audit row: `~/.soul-hub/data/naseej.db` — `naseej_runs` WHERE recipe='peer-brief-v2' AND DATE=`{run_date}`
- Legacy PDF: `~/Downloads/peer-brief-{run_date}.en.pdf`
- Naseej v2 PDF: `~/Downloads/peer-brief-{run_date}-v2.en.pdf`
- Naseej v2 stop-slop: `~/.soul-hub/data/naseej/runs/{v2.get('run_id', '<run_id>')}/stop-slop.json`
- Legacy stop-slop (pending instrumentation patch): `/tmp/peer-brief-legacy-{run_date}.stop-slop.json`
- Driving ADR: [[../adr-022-synth-decomposition-shadow|ADR-022]]

### Raw legacy diagnostics

```json
{json.dumps(legacy, indent=2, default=str)}
```

### Raw Naseej v2 diagnostics

```json
{json.dumps(v2, indent=2, default=str)}
```

## Implications

This row feeds the 2026-05-29 decision: promote Naseej v2 to canonical, OR retire v2 and keep legacy. Cumulative across 5+ of 7 shadow weekdays. If today's row shows v2 wall > 0.6× legacy wall OR v2 stop-slop < legacy stop-slop OR (rating filled) v2 rating < legacy rating, this day counts against v2 in the decision rule.

## Operator notes (vim-editable)

_Day-end notes. Flag anything material for the 2026-05-29 decision._
"""


def write_vault_note(run_date: str, body: str, dry_run: bool = False) -> None:
    """POST to /api/vault/notes via the soul-hub API."""
    if dry_run:
        sys.stdout.write("--- DRY RUN: would write projects/naseej/research/shadow-week-{}.md ---\n".format(run_date))
        sys.stdout.write(body)
        return

    filename = f"shadow-week-{run_date}.md"
    target_path = f"projects/naseej/research/{filename}"
    payload = {
        "zone": "projects/naseej/research",
        "filename": filename,
        "meta": {
            "type": "research",
            "created": run_date,
            "tags": [
                "naseej",
                "peer-brief",
                "shadow-week",
                "parity",
                "adr-022",
                "auto-generated",
            ],
            "project": "naseej",
            "source_agent": "peer-brief-parity-3way",
            "source_context": "ADR-022 F2 daily parity row",
        },
        "content": body,
    }

    # Try POST (create). If it already exists, fall back to PUT (update).
    try:
        r = httpx.post(
            f"{SOUL_HUB_BASE}/api/vault/notes",
            json=payload, timeout=30,
        )
    except httpx.HTTPError as e:
        print(f"ERROR: POST to vault API failed: {e}", file=sys.stderr)
        sys.exit(2)

    if r.status_code in (200, 201) and r.json().get("success"):
        print(f"OK: created {target_path}", file=sys.stderr)
        return

    # Existing-file path: fall back to PUT
    lower_text = r.text.lower()
    if (
        "already exists" in lower_text
        or "duplicate content" in lower_text
        or r.status_code == 409
    ):
        try:
            put = httpx.put(
                f"{SOUL_HUB_BASE}/api/vault/notes/{target_path}",
                json={"meta": payload["meta"], "content": body},
                timeout=30,
            )
        except httpx.HTTPError as e:
            print(f"ERROR: PUT to vault API failed: {e}", file=sys.stderr)
            sys.exit(2)
        if put.status_code == 200:
            print(f"OK: updated {target_path}", file=sys.stderr)
            return
        print(f"ERROR: PUT failed {put.status_code}: {put.text[:300]}", file=sys.stderr)
        sys.exit(2)

    print(f"ERROR: POST failed {r.status_code}: {r.text[:300]}", file=sys.stderr)
    sys.exit(2)


def main() -> int:
    p = argparse.ArgumentParser(
        description="ADR-022 peer-brief shadow parity harness (legacy vs Naseej v2)."
    )
    p.add_argument(
        "--date",
        default=date.today().isoformat(),
        help="Run date YYYY-MM-DD (default: today). Use this date to find the v2 audit row + PDF outputs.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the parity markdown to stdout instead of writing to the vault.",
    )
    args = p.parse_args()

    legacy = collect_legacy(args.date)
    v2 = collect_v2(args.date)
    body = render_parity_md(args.date, legacy, v2)
    write_vault_note(args.date, body, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
