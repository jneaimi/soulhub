#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# ///
"""Standalone tests for the text-correct component (ADR-035 P2).

Runs without pytest (CI calls `uv run tests/test_correct.py`). Uses the
claude-stub fixture so no live model call is made. The stub is driven via
STUB_MODE / STUB_MAP env vars, which propagate through run.py to the stub.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

COMPONENT_DIR = Path(__file__).resolve().parent.parent
RUN_PY = COMPONENT_DIR / "run.py"
STUB = COMPONENT_DIR / "tests" / "fixtures" / "claude-stub" / "claude"


def invoke(payload: dict, *, stub_mode: str = "ok", stub_map: str = "[]") -> tuple[int, dict]:
    payload = {**payload, "claude_binary": str(STUB)}
    env = {**os.environ, "STUB_MODE": stub_mode, "STUB_MAP": stub_map}
    proc = subprocess.run(
        ["uv", "run", str(RUN_PY)],
        input=json.dumps(payload), capture_output=True, text=True, env=env,
    )
    try:
        out = json.loads(proc.stdout)
    except json.JSONDecodeError:
        out = {"_raw": proc.stdout, "_stderr": proc.stderr}
    return proc.returncode, out


PASS = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def test_map_applied_and_facts_preserved():
    text = "It really matters that we ship. The pull had 42 signals today."
    smap = json.dumps([{"find": "It really matters", "replace": "It matters", "why": "adverb"}])
    code, out = invoke({"input_text": text}, stub_map=smap)
    check("exit 0", code == 0, str(code))
    check("substitution applied", out.get("substitutions_applied") == 1, str(out))
    check("adverb removed", "It matters that we ship" in out.get("corrected_text", ""))
    check("fact preserved (42 signals)", "42 signals" in out.get("corrected_text", ""))


def test_emdash_backstop_fires_on_empty_map():
    text = "Model capability is one thing — runtime control is another."
    code, out = invoke({"input_text": text}, stub_map="[]")
    check("exit 0", code == 0, str(code))
    check("no subs applied", out.get("substitutions_applied") == 0)
    check("emdash_fixed true", out.get("emdash_fixed") is True, str(out))
    check("em-dash gone", "—" not in out.get("corrected_text", ""))
    check("comma inserted", "one thing, runtime control" in out.get("corrected_text", ""))


def test_best_effort_on_cli_failure():
    text = "A clean sentence with an em-dash here — and there."
    code, out = invoke({"input_text": text}, stub_mode="exit1")
    check("exit 0 despite CLI fail", code == 0, str(code))
    check("subs 0", out.get("substitutions_applied") == 0)
    check("backstop still ran", out.get("emdash_fixed") is True, str(out))


def test_best_effort_on_garbage_envelope():
    text = "Garbage envelope but content still flows through."
    code, out = invoke({"input_text": text}, stub_mode="garbage")
    check("exit 0 on garbage", code == 0, str(code))
    check("content returned", "flows through" in out.get("corrected_text", ""))


def test_missed_substitution_counted_not_guessed():
    text = "The actual content here is fine."
    smap = json.dumps([{"find": "NONEXISTENT PHRASE", "replace": "x", "why": "test"}])
    code, out = invoke({"input_text": text}, stub_map=smap)
    check("exit 0", code == 0)
    check("missed counted", out.get("substitutions_missed") == 1, str(out))
    check("applied 0", out.get("substitutions_applied") == 0)
    check("text unchanged", out.get("corrected_text") == text)


def test_output_path_written():
    with tempfile.TemporaryDirectory() as d:
        outp = Path(d) / "corrected.txt"
        text = "Write me to a file with an em-dash — gone."
        code, out = invoke({"input_text": text, "output_path": str(outp)}, stub_map="[]")
        check("exit 0", code == 0)
        check("corrected_path returned", out.get("corrected_path") == str(outp), str(out))
        check("no inline text when path set", "corrected_text" not in out)
        check("file written + backstopped", outp.is_file() and "—" not in outp.read_text())


def test_input_text_path_mode():
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "src.txt"
        src.write_text("Path mode content with an em-dash — here.")
        code, out = invoke({"input_text_path": str(src)}, stub_map="[]")
        check("exit 0", code == 0)
        check("backstop applied to file content", out.get("emdash_fixed") is True, str(out))


def test_bad_input_both_set():
    code, out = invoke({"input_text": "x", "input_text_path": "/tmp/y"})
    check("exit 2 when both set", code == 2, str(code))


def test_bad_input_neither_set():
    code, out = invoke({})
    check("exit 2 when neither set", code == 2, str(code))


def main() -> int:
    for fn in [
        test_map_applied_and_facts_preserved,
        test_emdash_backstop_fires_on_empty_map,
        test_best_effort_on_cli_failure,
        test_best_effort_on_garbage_envelope,
        test_missed_substitution_counted_not_guessed,
        test_output_path_written,
        test_input_text_path_mode,
        test_bad_input_both_set,
        test_bad_input_neither_set,
    ]:
        print(fn.__name__)
        fn()
    print(f"\n{PASS}/{PASS + FAIL} passed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
