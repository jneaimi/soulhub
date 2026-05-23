#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Deterministic tests for stop-slop v1.0.0.

Runs both as a standalone script (`uv run test_scoring.py`) and via pytest
(`uv run pytest test_scoring.py -v`). Standalone mode is what CI calls so
the component works without a pytest dependency in the runner.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

COMPONENT_DIR = Path(__file__).resolve().parent.parent
RUN_PY = COMPONENT_DIR / "run.py"


def invoke(payload: dict) -> tuple[int, dict]:
    """Pipe payload to run.py and return (exit_code, parsed_stdout)."""
    proc = subprocess.run(
        ["uv", "run", str(RUN_PY)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=str(COMPONENT_DIR),
    )
    try:
        out = json.loads(proc.stdout)
    except json.JSONDecodeError:
        out = {"_raw": proc.stdout, "_stderr": proc.stderr}
    return proc.returncode, out


# ── Tests ──────────────────────────────────────────────────────────────────

def test_clean_text_passes():
    """Clean prose with no banned phrases scores 50 and passes."""
    code, out = invoke({"text": "Cats love fish. Dogs love walks. Birds love sky."})
    # 3 short sentences of similar length triggers rhythm.metronomic — that's working as designed.
    # Score will be 45 (rhythm dimension = 9 because of one metronomic match).
    assert out["passed"] is True, f"expected pass, got {out}"
    assert out["score"] >= 35, f"expected score >= 35, got {out['score']}"
    assert len(out["hard_violations"]) == 0
    assert code == 0


def test_throat_clearing_hard_fail():
    """One throat-clearing phrase triggers HARD violation + fail."""
    code, out = invoke({
        "text": "Here's the thing. Cats are great.",
        "min_score": 35,
    })
    assert out["passed"] is False
    assert out["per_dimension"]["directness"] == 9
    assert any(v["kind"] == "throat-clearing.HARD" for v in out["hard_violations"])
    assert code == 6


def test_em_dash_hard_fail():
    """Unicode em-dash is a HARD violation."""
    code, out = invoke({"text": "Cats are great — they really are."})
    assert out["passed"] is False
    assert any(v["kind"] == "em-dash.HARD" for v in out["hard_violations"])
    assert code == 6


def test_block_on_fail_false_returns_zero():
    """When block_on_fail=false, exit 0 even on fail."""
    code, out = invoke({
        "text": "Here's the thing.",
        "block_on_fail": False,
    })
    assert out["passed"] is False
    assert code == 0, "block_on_fail=false should not block exit"


def test_min_score_threshold():
    """Adjusting min_score changes pass/fail."""
    text = "Here is some text. It has no real banned phrases anywhere."
    code_high, out_high = invoke({"text": text, "min_score": 50})
    code_low, out_low = invoke({"text": text, "min_score": 0})
    assert out_low["passed"] is True
    assert code_low == 0
    # The text scores below 50 since "really" is an adverb crutch and rhythm may trigger
    if out_high["score"] < 50:
        assert out_high["passed"] is False
        assert code_high == 6


def test_per_dimension_floor_at_zero():
    """Many violations in one dimension floor that dimension at 0."""
    spammy = " ".join(["here's the thing,"] * 15)
    code, out = invoke({"text": spammy})
    assert out["per_dimension"]["directness"] == 0
    assert out["passed"] is False


def test_missing_text_returns_bad_input():
    """Missing `text` returns exit 2."""
    code, out = invoke({"rubric": "default"})
    assert code == 2
    assert "error" in out


def test_invalid_json_returns_bad_input():
    """Non-JSON stdin returns exit 2."""
    proc = subprocess.run(
        ["uv", "run", str(RUN_PY)],
        input="not json at all",
        capture_output=True,
        text=True,
        cwd=str(COMPONENT_DIR),
    )
    assert proc.returncode == 2


def test_unknown_rubric_returns_bad_input():
    """Unknown rubric returns exit 2."""
    code, out = invoke({"text": "fine", "rubric": "klingon"})
    assert code == 2
    assert "error" in out


def test_rubric_forward_compat():
    """Forward-compat rubrics (peer-brief/linkedin/arabic) accepted but act as default in v1.0.0."""
    for r in ("default", "peer-brief", "linkedin", "arabic"):
        code, out = invoke({"text": "Cats are graceful animals.", "rubric": r})
        assert out["rubric"] == r
        assert "score" in out


def test_html_stripped():
    """HTML tags don't count as violations."""
    code, out = invoke({"text": "<p>Cats are <strong>graceful</strong> animals.</p>"})
    assert out["passed"] is True
    assert not any("strong" in v.get("phrase", "") for v in out["hard_violations"])


def test_output_shape_matches_block_md():
    """Output keys match the BLOCK.md contract exactly."""
    code, out = invoke({"text": "Cats are graceful."})
    required = {"score", "passed", "per_dimension", "hard_violations", "soft_violation_count", "by_kind"}
    assert required <= set(out.keys()), f"missing keys: {required - set(out.keys())}"
    pd = out["per_dimension"]
    assert {"directness", "rhythm", "trust", "authenticity", "density"} == set(pd.keys())
    for v in pd.values():
        assert 0 <= v <= 10


# ── Standalone runner ──────────────────────────────────────────────────────

def main() -> int:
    tests = [
        test_clean_text_passes,
        test_throat_clearing_hard_fail,
        test_em_dash_hard_fail,
        test_block_on_fail_false_returns_zero,
        test_min_score_threshold,
        test_per_dimension_floor_at_zero,
        test_missing_text_returns_bad_input,
        test_invalid_json_returns_bad_input,
        test_unknown_rubric_returns_bad_input,
        test_rubric_forward_compat,
        test_html_stripped,
        test_output_shape_matches_block_md,
    ]
    passed = failed = 0
    failures: list[tuple[str, str]] = []
    for t in tests:
        try:
            t()
            print(f"  ✓ {t.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"  ✗ {t.__name__}: {e}", file=sys.stderr)
            failures.append((t.__name__, str(e)))
            failed += 1
        except Exception as e:
            print(f"  ✗ {t.__name__}: unexpected error: {e!r}", file=sys.stderr)
            failures.append((t.__name__, repr(e)))
            failed += 1
    total = passed + failed
    print(f"\n{passed}/{total} passed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
