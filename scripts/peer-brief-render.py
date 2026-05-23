#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""peer-brief-render.py — Render today's Signal Forge miner-daily into a peer-brief PDF.

Pipeline:
  1. Resolve today's miner-daily report
  2. Extract 14-day signal-trend YAML (helper script)
  3. Synthesise recipe via peer-brief-synth agent (Sonnet)
  4. Stop-slop CORRECT — AI prescription pass (fix slop) + deterministic em-dash
     backstop. stop-slop is a corrector skill, so we fix the prose rather than only
     gating on it (ADR-035). Uses the prescription pattern (JSON substitution map +
     deterministic apply) to avoid rewriting the recipe.
  5. Stop-slop VERIFY — scan as a safety net (should pass after correction; still
     hard-fails on residual violations the corrector could not fix)
  6. Build PDF via katib (--brand jasem)
  7. Telegram text alert (optional, fail-soft)

Usage:
  ./peer-brief-render.py                              # today
  ./peer-brief-render.py --date 2026-05-14            # specific day
  ./peer-brief-render.py --date 2026-05-14 --dry-run  # skip render, keep recipe
  ./peer-brief-render.py --date 2026-05-14 --out /tmp/test.pdf
  PEER_BRIEF_MODEL=opus ./peer-brief-render.py        # override model

Exit codes (contract preserved from peer-brief-render.sh; see ADR-040):
  0  success (PDF rendered + alert sent if configured)
  2  bad CLI args
  4  missing input (miner-daily report not found)
  5  synthesis failed (agent returned [SYNTH-FAIL] or no output)
  6  stop-slop gate failed
  7  katib build failed
  8  Telegram alert failed (PDF is still on disk; non-fatal)

Structured JSON log: every step emits one `{"event":"step","name":...,"ok":...,
"detail":{...}}` line on stderr immediately after the human `[STEP N/5]` marker.
The scheduler captures stderr and surfaces the JSON inline, replacing the bash
version's "find the tempdir, cat the JSON" triage flow.
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path
from typing import Any, Optional

import httpx


class ExitCode(IntEnum):
    SUCCESS = 0
    BAD_ARGS = 2
    MISSING_INPUT = 4
    SYNTH_FAIL = 5
    STOP_SLOP_FAIL = 6
    KATIB_FAIL = 7
    TELEGRAM_FAIL = 8


HOME = Path.home()
REPORTS_DIR = HOME / "vault/content/signal-forge/reports"
CANONICAL_RECIPE = HOME / ".katib/recipes/peer-brief-2026-05-14-miner-daily-en.yaml"
TREND_HELPER = HOME / ".claude/skills/katib/scripts/extract-signal-trend.py"
KATIB_PROJECT_DIR = HOME / "dev/katib"
SYNTH_AGENT = HOME / ".claude/agents/peer-brief-synth.md"

SCRIPT_DIR = Path(__file__).resolve().parent
SCANNER = SCRIPT_DIR / "peer-brief/stop-slop-scan.py"
STOP_SLOP_SKILL = HOME / ".claude/skills/stop-slop/SKILL.md"
# ADR-035 P4 — the single, shared corrector. The legacy peer-brief and the
# Naseej rebuild both drive this one component (prescription map + em-dash
# backstop), so there is one corrector definition system-wide.
TEXT_CORRECT = SCRIPT_DIR.parent / "catalog/components/text-correct/run.py"

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass
class Config:
    date: str
    model: str
    budget: float
    min_score: int
    out_pdf: Path
    dry_run: bool
    no_notify: bool
    tg_chat_id: Optional[str]


def emit(line: str) -> None:
    sys.stderr.write(line if line.endswith("\n") else line + "\n")
    sys.stderr.flush()


def log_step(name: str, ok: bool, **detail: Any) -> None:
    emit(json.dumps({"event": "step", "name": name, "ok": ok, "detail": detail}, separators=(",", ":")))


class Heartbeat:
    def __init__(self, label: str, interval: int = 30) -> None:
        self._label = label
        self._interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        elapsed = 0
        while not self._stop.wait(self._interval):
            elapsed += self._interval
            emit(f"[STATUS] {self._label} working... ({elapsed}s)")

    def __enter__(self) -> "Heartbeat":
        self._thread.start()
        return self

    def __exit__(self, *_a: Any) -> None:
        self._stop.set()
        self._thread.join(timeout=2)


def parse_args() -> Config:
    p = argparse.ArgumentParser(
        description="Render a peer-brief PDF for a given date",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--date", default=time.strftime("%Y-%m-%d"), help="YYYY-MM-DD (default: today)")
    p.add_argument("--model", default=os.environ.get("PEER_BRIEF_MODEL", "sonnet"))
    p.add_argument("--budget", default=os.environ.get("PEER_BRIEF_BUDGET", "2.00"))
    p.add_argument("--out", default=None, help="Override PDF output path")
    p.add_argument("--min-score", type=int, default=int(os.environ.get("PEER_BRIEF_MIN_SCORE", "30")))
    p.add_argument("--dry-run", action="store_true", help="Skip katib render, keep recipe")
    p.add_argument("--no-notify", action="store_true", help="Skip Telegram alert")

    try:
        ns = p.parse_args()
    except SystemExit as e:
        raise SystemExit(ExitCode.BAD_ARGS if e.code else ExitCode.SUCCESS)

    if not DATE_RE.match(ns.date):
        emit(f"[ERROR] Invalid date format: {ns.date} (expected YYYY-MM-DD)")
        raise SystemExit(ExitCode.BAD_ARGS)

    try:
        budget = float(ns.budget)
    except (TypeError, ValueError):
        emit(f"[ERROR] Invalid budget: {ns.budget}")
        raise SystemExit(ExitCode.BAD_ARGS)

    out_pdf = Path(ns.out) if ns.out else HOME / f"Downloads/peer-brief-{ns.date}.en.pdf"
    tg_chat_id = os.environ.get("PEER_BRIEF_TELEGRAM_CHAT_ID") or os.environ.get("TELEGRAM_CHAT_ID")

    return Config(
        date=ns.date,
        model=ns.model,
        budget=budget,
        min_score=ns.min_score,
        out_pdf=out_pdf,
        dry_run=ns.dry_run,
        no_notify=ns.no_notify,
        tg_chat_id=tg_chat_id,
    )


def step_resolve_miner_daily(cfg: Config) -> Path:
    miner = REPORTS_DIR / f"{cfg.date}-miner-daily.md"
    if not miner.is_file():
        emit(f"[ERROR] Miner-daily not found: {miner}")
        emit(f"[HINT] Check ls {REPORTS_DIR} for the actual filename")
        log_step("resolve-miner-daily", False, path=str(miner), reason="not-found")
        raise SystemExit(ExitCode.MISSING_INPUT)
    with miner.open() as f:
        lines = sum(1 for _ in f)
    emit(f"[STEP 1/7] miner-daily ✓ ({lines} lines)")
    log_step("resolve-miner-daily", True, path=str(miner), lines=lines)
    return miner


def step_extract_trend(cfg: Config, work: Path) -> Path:
    out = work / f"trend-{cfg.date}.yaml"
    err = work / "trend.err"
    emit("[STEP 2/7] extracting signal-trend...")
    cmd = ["uv", "run", str(TREND_HELPER), "--as-of", cfg.date]
    with err.open("wb") as ef, out.open("wb") as of:
        result = subprocess.run(cmd, stdout=of, stderr=ef, check=False)
    if result.returncode != 0:
        emit("[ERROR] signal-trend extraction failed")
        emit(err.read_text(errors="replace"))
        log_step("extract-trend", False, returncode=result.returncode, stderr=err.read_text(errors="replace")[-500:])
        raise SystemExit(ExitCode.MISSING_INPUT)
    with out.open() as f:
        lines = sum(1 for _ in f)
    emit(f"[STEP 2/7] signal-trend ✓ ({lines} lines)")
    log_step("extract-trend", True, path=str(out), lines=lines)
    return out


def step_synthesise(cfg: Config, work: Path, miner: Path, trend: Path) -> Path:
    recipe = work / f"peer-brief-{cfg.date}-synthesised.yaml"
    synth_log = work / f"synth-{cfg.date}.log"
    synth_stderr = work / f"synth-{cfg.date}.stderr"

    emit(f"[STEP 3/7] synthesising via {cfg.model} (budget ${cfg.budget:.2f})...")

    prompt = (
        "Synthesise today's peer-brief recipe.\n\n"
        f"DATE: {cfg.date}\n"
        f"MINER-DAILY REPORT: {miner}\n"
        f"CANONICAL RECIPE TEMPLATE: {CANONICAL_RECIPE}\n"
        f"SIGNAL-TREND YAML (Figure 0 input, paste verbatim): {trend}\n"
        f"OUTPUT RECIPE PATH: {recipe}\n\n"
        "Read the canonical recipe to absorb section structure and prose voice.\n"
        "Read today's miner-daily for findings, signal counts, and source material.\n"
        "Read the trend YAML; embed verbatim under the signal-trend-area section.\n\n"
        "Write the synthesised recipe to the output path. Apply stop-slop discipline.\n"
        "Apply the six lessons (em-dash ban, text: not quote: for pull-quote, etc.).\n\n"
        "When done, print the [SYNTH-DONE] line to stderr."
    )

    cmd = [
        "claude",
        "--agent", str(SYNTH_AGENT),
        "-p", prompt,
        # Claude CLI 2.1.146 stopped honouring `--allowedTools Write(<path>)` as a
        # write pre-authorization in headless `-p` mode — it now PROMPTS, which hangs
        # forever with no TTY → the agent burns its budget "waiting for write
        # permission" and the recipe is never written (SYNTH_FAIL / exit 5). Skip
        # permissions like every other headless dispatcher in the system; the clean
        # cwd + the allowlist below + the --max-budget-usd cap keep this safe.
        "--dangerously-skip-permissions",
        "--allowedTools", f"Read(*),Write({recipe}),Bash(wc*),Bash(head*),Bash(grep*),Glob(*),Grep(*)",
        "--max-budget-usd", f"{cfg.budget}",
        "--model", cfg.model,
        # ADR-003 P3 — cost discipline: strip the global ~/.claude config and the
        # dynamic system-prompt sections (cwd/env/memory/git) so they don't auto-load
        # into every synthesis call. ~10x cost otherwise ($0.159 -> $0.015, measured
        # 2026-05-19, inline-llm-pass gold standard). All inputs are absolute paths,
        # so the clean cwd below does not affect file access.
        "--setting-sources", "",
        "--exclude-dynamic-system-prompt-sections",
        "--verbose",
        "--output-format", "stream-json",
    ]

    # ADR-003 P3 — run from a clean, empty dir so no project CLAUDE.md is inherited.
    clean_cwd = work / "synth-cwd"
    clean_cwd.mkdir(exist_ok=True)

    with Heartbeat("synthesis"), synth_log.open("wb") as lf, synth_stderr.open("wb") as ef:
        subprocess.run(cmd, stdout=lf, stderr=ef, cwd=str(clean_cwd), check=False)

    err_text = synth_stderr.read_text(errors="replace")

    if "[SYNTH-FAIL]" in err_text:
        emit("[ERROR] Synthesis returned SYNTH-FAIL:")
        for line in err_text.splitlines():
            if "[SYNTH-FAIL]" in line:
                emit(line)
        log_step("synthesise", False, reason="synth-fail-marker")
        raise SystemExit(ExitCode.SYNTH_FAIL)

    if not recipe.is_file() or recipe.stat().st_size == 0:
        emit(f"[ERROR] Synthesis produced no recipe at {recipe}")
        emit("[HINT] last 20 lines of synth log:")
        for line in synth_log.read_text(errors="replace").splitlines()[-20:]:
            emit(line)
        emit("[HINT] last 20 lines of synth stderr:")
        for line in err_text.splitlines()[-20:]:
            emit(line)
        log_step("synthesise", False, reason="no-recipe", recipe=str(recipe))
        raise SystemExit(ExitCode.SYNTH_FAIL)

    with recipe.open() as f:
        lines = sum(1 for _ in f)
    emit(f"[STEP 3/7] synthesis ✓ ({lines} lines)")
    for line in err_text.splitlines():
        if "[SYNTH-DONE]" in line or "[SYNTH-SKIP]" in line:
            emit(line)
    log_step("synthesise", True, recipe=str(recipe), lines=lines)
    return recipe


def step_correct(cfg: Config, work: Path, recipe: Path) -> None:
    """STEP 4/7 — AI stop-slop CORRECTOR via the shared text-correct component
    (ADR-035 P4).

    Folds the legacy inline corrector onto the one shared definition: the same
    catalog/components/text-correct component the Naseej peer-brief uses, driven
    here with the stop-slop ruleset. The component prescribes a minimal
    substitution map (no full rewrite — keeps every fact verbatim), applies it
    deterministically, and runs the em-dash backstop. It edits the recipe
    in place. Best-effort: on any failure we log + continue — the scan that
    follows is the net.
    """
    emit("[STEP 4/7] stop-slop CORRECT (shared text-correct component)...")
    payload = json.dumps({
        "input_text_path": str(recipe),
        "output_path": str(recipe),  # in place
        "ruleset": str(STOP_SLOP_SKILL),
        "model": cfg.model,
        "max_budget_usd": 0.40,
        "emdash_backstop": True,
    })

    applied = missed = 0
    emdash_fixed = False
    try:
        with Heartbeat("correct"):
            proc = subprocess.run(
                ["uv", "run", str(TEXT_CORRECT)],
                input=payload, capture_output=True, text=True,
                cwd=str(work), check=False,
            )
        out = json.loads(proc.stdout)
        applied = out.get("substitutions_applied", 0)
        missed = out.get("substitutions_missed", 0)
        emdash_fixed = bool(out.get("emdash_fixed", False))
    except Exception as e:  # noqa: BLE001 — corrector is best-effort
        emit(f"[WARN] text-correct component unavailable ({e}); recipe left as drafted")

    emit(
        f"[STEP 4/7] correction ✓ (applied {applied}, missed {missed}, "
        f"em-dash backstop: {'fixed' if emdash_fixed else 'clean'})"
    )
    log_step("correct", True, applied=applied, missed=missed, emdash=emdash_fixed)


def step_stop_slop(cfg: Config, work: Path, recipe: Path) -> int:
    emit(f"[STEP 5/7] stop-slop VERIFY (min {cfg.min_score}, hard=0 after correction)...")
    scan_out = work / f"stop-slop-{cfg.date}.json"
    cmd = ["uv", "run", str(SCANNER), str(recipe), "--min-score", str(cfg.min_score)]
    with scan_out.open("wb") as f:
        result = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT, check=False)

    scan_text = scan_out.read_text(errors="replace")
    detail: dict[str, Any] = {}
    for line in scan_text.splitlines():
        if "[stop-slop" in line:
            emit(line)
            m = re.search(r"score=(\d+).*hard=(\d+)", line)
            if m:
                detail["score"] = int(m.group(1))
                detail["hard"] = int(m.group(2))

    if result.returncode != 0:
        emit(f"[ERROR] stop-slop gate FAILED — recipe at {recipe}")
        emit(f"[HINT] inspect {scan_out} for the breakdown")
        try:
            json_start = scan_text.index("{")
            payload = json.loads(scan_text[json_start:])
            violations = payload.get("violations") or []
            if violations:
                v0 = violations[0]
                detail["first_violation"] = f"{v0.get('kind')} at {v0.get('origin')}"
                detail["violation_count"] = len(violations)
        except (ValueError, json.JSONDecodeError):
            pass
        log_step("stop-slop", False, **detail)
        raise SystemExit(ExitCode.STOP_SLOP_FAIL)

    score = int(detail.get("score", 0))
    emit(f"[STEP 5/7] stop-slop VERIFY ✓ (score {score}/50, hard 0)")
    log_step("stop-slop", True, **detail)
    return score


def step_katib(cfg: Config, work: Path, recipe: Path) -> None:
    emit("[STEP 6/7] rendering PDF via katib...")
    if not KATIB_PROJECT_DIR.is_dir():
        emit(f"[ERROR] katib project dir not found: {KATIB_PROJECT_DIR}")
        log_step("katib", False, reason="missing-project-dir")
        raise SystemExit(ExitCode.KATIB_FAIL)

    build_log = work / "build.log"
    cmd = [
        "uv", "run", "scripts/build.py", str(recipe),
        "--lang", "en", "--brand", "jasem", "--out", str(cfg.out_pdf),
        "--skip-audit-check",
    ]
    with build_log.open("wb") as f:
        result = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT, cwd=KATIB_PROJECT_DIR, check=False)

    if result.returncode != 0:
        emit("[ERROR] katib build FAILED")
        for line in build_log.read_text(errors="replace").splitlines()[-40:]:
            emit(line)
        emit(f"[HINT] full build log: {build_log}")
        emit(f"[HINT] recipe: {recipe}")
        log_step("katib", False, returncode=result.returncode)
        raise SystemExit(ExitCode.KATIB_FAIL)

    if not cfg.out_pdf.is_file():
        emit(f"[ERROR] katib reported success but PDF missing: {cfg.out_pdf}")
        log_step("katib", False, reason="pdf-missing")
        raise SystemExit(ExitCode.KATIB_FAIL)

    size_bytes = cfg.out_pdf.stat().st_size
    emit(f"[STEP 6/7] PDF rendered ✓ ({_human_bytes(size_bytes)})")
    log_step("katib", True, pdf=str(cfg.out_pdf), size_bytes=size_bytes)


def step_telegram(cfg: Config, recipe: Path, score: int) -> None:
    if cfg.no_notify:
        emit("[INFO] --no-notify: skipping Telegram alert")
        return
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token or not cfg.tg_chat_id:
        emit("[WARN] TELEGRAM_BOT_TOKEN or chat_id not set, skipping alert")
        log_step("telegram", True, skipped=True, reason="no-creds")
        return

    sections = sum(1 for line in recipe.read_text(errors="replace").splitlines() if line.startswith("  - component:"))
    pdf_size = _human_bytes(cfg.out_pdf.stat().st_size)
    msg = (
        f"📄 Peer brief ready · {cfg.date}\n"
        f"{cfg.out_pdf.name}\n"
        f"{sections} sections · score {score}/50 · {pdf_size}\n"
        f"Open ~/Downloads/ to review and forward."
    )

    try:
        r = httpx.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data={
                "chat_id": cfg.tg_chat_id,
                "text": msg,
                "disable_web_page_preview": "true",
            },
            timeout=15.0,
        )
        ok = r.status_code == 200
    except httpx.HTTPError as e:
        emit(f"[WARN] Telegram alert HTTP error: {e}")
        emit(f"[WARN] PDF is still at {cfg.out_pdf} (alert failure is non-fatal)")
        emit(f"[DONE] {cfg.out_pdf} (no notification)")
        sys.stdout.write(str(cfg.out_pdf) + "\n")
        log_step("telegram", False, exception=str(e))
        raise SystemExit(ExitCode.TELEGRAM_FAIL)

    if not ok:
        emit(f"[WARN] Telegram alert FAILED (http={r.status_code})")
        emit(f"[WARN] response: {r.text[:200]}")
        emit(f"[WARN] PDF is still at {cfg.out_pdf} (alert failure is non-fatal)")
        emit(f"[DONE] {cfg.out_pdf} (no notification)")
        sys.stdout.write(str(cfg.out_pdf) + "\n")
        log_step("telegram", False, http=r.status_code)
        raise SystemExit(ExitCode.TELEGRAM_FAIL)

    emit("[STEP 7/7] Telegram alert ✓")
    log_step("telegram", True, http=200)


def _human_bytes(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.1f}M"
    if n >= 1024:
        return f"{n / 1024:.0f}K"
    return f"{n}B"


def main() -> int:
    cfg = parse_args()
    emit(f"[START] peer-brief-render — {cfg.date}")
    emit(f"[INFO] model={cfg.model}  budget=${cfg.budget:.2f}  min-score={cfg.min_score}")

    work = Path(tempfile.mkdtemp(prefix="peer-brief-"))
    atexit.register(lambda: emit(f"[INFO] work dir: {work}"))
    emit(f"[INFO] work={work}  out={cfg.out_pdf}")
    log_step("start", True, date=cfg.date, model=cfg.model, budget=cfg.budget,
             work=str(work), out=str(cfg.out_pdf))

    miner = step_resolve_miner_daily(cfg)
    trend = step_extract_trend(cfg, work)
    recipe = step_synthesise(cfg, work, miner, trend)
    step_correct(cfg, work, recipe)
    score = step_stop_slop(cfg, work, recipe)

    if cfg.dry_run:
        emit("[DRY-RUN] skipping katib build")
        emit(f"[DRY-RUN] recipe at: {recipe}")
        emit("[DONE] dry-run complete (no PDF)")
        log_step("done", True, dry_run=True, recipe=str(recipe), score=score)
        return ExitCode.SUCCESS

    step_katib(cfg, work, recipe)
    step_telegram(cfg, recipe, score)

    emit(f"[DONE] {cfg.out_pdf}")
    sys.stdout.write(str(cfg.out_pdf) + "\n")
    log_step("done", True, pdf=str(cfg.out_pdf), score=score)
    return ExitCode.SUCCESS


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        emit("[INFO] interrupted")
        sys.exit(130)
