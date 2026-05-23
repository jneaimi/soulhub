#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "pypdf"]
# ///
"""
parity-check.py — daily peer-brief shadow parity report (ADR-034 cutover gate).

Compares the legacy katib brief vs the internalized rebuild brief for a date and
sends an objective metrics report to Telegram so the operator's daily review is
a glance. Deterministic — no model call.

Metrics:
  - both PDFs present (legacy + rebuild rendered)?
  - page count + file size for each
  - rebuild section count (expect 15) + stop-slop score/hard from its run record

Verdict is objective only (structure + score). FIDELITY stays the operator's
call — the report nudges them to open both when something looks off.

Inputs:
  --date         YYYY-MM-DD (default today)
  --downloads    dir holding the PDFs (default ~/Downloads)
  --no-telegram  print to stdout instead of sending

Exit: 0 always (a report, never blocks anything).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path

import httpx
from pypdf import PdfReader

RUNS_DIR = Path.home() / ".soul-hub/data/naseej/runs"
EXPECTED_SECTIONS = 15


def pdf_stats(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        pages = len(PdfReader(str(path)).pages)
    except Exception:  # noqa: BLE001 — a corrupt/odd PDF should not break the report
        pages = -1
    return {"pages": pages, "bytes": path.stat().st_size}


def human(n: int) -> str:
    return f"{n/1024:.0f}KB" if n < 1_048_576 else f"{n/1_048_576:.1f}MB"


def rebuild_run_record(date: str) -> dict:
    """Latest SCHEDULED rebuild run for the date (run_id peer-brief-rebuild-<date>-*)."""
    out: dict = {}
    cands = sorted(
        RUNS_DIR.glob(f"peer-brief-rebuild-{date}-*"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not cands:
        return out
    run = cands[0]
    try:
        comp = json.loads((run / "composition.json").read_text())
        out["sections"] = comp.get("section_count")
    except (OSError, json.JSONDecodeError):
        pass
    try:
        ss = json.loads((run / "stop-slop.json").read_text())
        sc = ss.get("score", {})
        out["score"] = sc.get("total")
        out["hard"] = sc.get("hard_violation_count")
    except (OSError, json.JSONDecodeError):
        pass
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--downloads", default=str(Path.home() / "Downloads"))
    ap.add_argument("--no-telegram", action="store_true")
    ns = ap.parse_args()

    dl = Path(ns.downloads).expanduser()
    legacy = pdf_stats(dl / f"peer-brief-{ns.date}.en.pdf")
    rebuild = pdf_stats(dl / f"peer-brief-{ns.date}-rebuild.en.pdf")
    rec = rebuild_run_record(ns.date)

    flags: list[str] = []
    if not legacy:
        flags.append("legacy PDF missing")
    if not rebuild:
        flags.append("rebuild PDF missing")
    if rec.get("sections") not in (None, EXPECTED_SECTIONS):
        flags.append(f"sections={rec.get('sections')} (expect {EXPECTED_SECTIONS})")
    if rec.get("hard"):
        flags.append(f"stop-slop hard={rec.get('hard')}")
    if legacy and rebuild and legacy["bytes"]:
        delta = (rebuild["bytes"] - legacy["bytes"]) / legacy["bytes"] * 100
        if abs(delta) > 50:
            flags.append(f"size Δ {delta:+.0f}%")

    verdict = "✅ clean" if not flags else "⚠️ review: " + "; ".join(flags)

    leg = f"{legacy['pages']}p · {human(legacy['bytes'])}" if legacy else "MISSING"
    reb = (
        f"{rebuild['pages']}p · {human(rebuild['bytes'])}"
        f" · {rec.get('sections','?')} sections"
        f" · stop-slop {rec.get('score','?')}/50 (hard {rec.get('hard','?')})"
        if rebuild
        else "MISSING"
    )

    lines = [
        f"📊 Peer-brief parity · {ns.date}",
        "",
        f"Legacy:  {leg}",
        f"Rebuild: {reb}",
        "",
        verdict,
        "Open both to judge fidelity.",
    ]
    text = "\n".join(lines)

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = os.environ.get("PEER_BRIEF_TELEGRAM_CHAT_ID") or os.environ.get("TELEGRAM_CHAT_ID")
    if ns.no_telegram or not token or not chat:
        print(text)
        return 0
    try:
        r = httpx.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat, "text": text},
            timeout=20,
        )
        print(f"telegram {r.status_code}")
        print(text)
    except httpx.HTTPError as e:
        print(f"[WARN] telegram send failed: {e}")
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
