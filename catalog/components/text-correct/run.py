#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
text-correct component v1.0.0 — prescription-pattern AI corrector (ADR-035 P2).

A model reads prose against a ruleset and emits a minimal substitution map
([{find, replace, why}]); this component applies it deterministically + a
regex em-dash backstop. Fact-preserving (only proposed substrings change) and
truncation-proof (the model emits a diff, never the full content).

I/O contract (see BLOCK.md):
  stdin:  { input_text? | input_text_path?, ruleset?, model?, max_budget_usd?,
            emdash_backstop?, output_path?, claude_binary? }
  stdout: { corrected_path? | corrected_text?, substitutions_applied,
            substitutions_missed, emdash_fixed, cost_usd, exit_code }
  exit:   0 ok (incl. best-effort fallthrough) | 2 bad input

Ported from scripts/peer-brief-render.py step_correct. Best-effort: a failed or
empty model map never fails the step — the backstop still runs and the content
is written through. The downstream stop-slop gate is the real safety net.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

# NOTE: we deliberately do NOT pass `--json-schema`. With the installed CLI
# (2.1.x) a json-schema-constrained `-p` run routes the structured output away
# from the envelope `result` field, leaving it EMPTY — the corrector then sees
# no map and silently no-ops. The legacy step_correct never used --json-schema
# for the same reason. The object-shaped prompt below + extract_substitutions()
# (object-first, bare-array fallback) parse the map reliably from `result`.

# Ruleset-driven, NOT slop-hardcoded. The rules to apply come ENTIRELY from the
# --append-system-prompt ruleset, so the same component corrects against any
# style guide (stop-slop, British spelling, brand voice). Hardcoding stop-slop
# categories here made the corrector ambiguous for other rulesets and even made
# different claude binaries diverge (one followed the ruleset, one the literal
# "find slop" task). Defer to the ruleset; the component's em-dash backstop is
# the only hardcoded correction.
PROMPT_TEMPLATE = (
    "Read the file at {path}. Apply the rules in your system prompt to its PROSE "
    "content only. Wherever the prose breaks a rule, propose a minimal fix.\n\n"
    "Output ONLY a JSON object, no prose, no code fence:\n"
    '{{"substitutions": [{{"find": "<exact verbatim substring copied from the '
    'file>", "replace": "<rewrite that satisfies the rule>", "why": "<which rule>"}}]}}\n\n'
    "Rules for the map itself:\n"
    "- `find` MUST be copied VERBATIM from the file (exact characters) so it matches.\n"
    "- Keep each `find` to one phrase or sentence, long enough to be unique in the file.\n"
    "- NEVER change facts: numbers, counts, %, dates, names, source quotes stay identical.\n"
    '- If nothing in the prose breaks a rule, output {{"substitutions": []}}.'
)


def extract_substitutions(raw: str) -> list[dict]:
    """Pull the substitution list out of the model `result` string. Accepts the
    object form `{"substitutions": [...]}` (json-schema constrained) and a bare
    array `[...]` (defensive fallback)."""
    if not isinstance(raw, str) or not raw:
        return []
    # Object form first.
    i, j = raw.find("{"), raw.rfind("}")
    if 0 <= i < j:
        try:
            obj = json.loads(raw[i:j + 1])
            if isinstance(obj, dict) and isinstance(obj.get("substitutions"), list):
                return obj["substitutions"]
        except json.JSONDecodeError:
            pass
    # Bare-array fallback.
    i, j = raw.find("["), raw.rfind("]")
    if 0 <= i < j:
        try:
            arr = json.loads(raw[i:j + 1])
            if isinstance(arr, list):
                return arr
        except json.JSONDecodeError:
            pass
    return []


def fail(msg: str) -> int:
    print(json.dumps({"error": msg, "exit_code": 2}))
    return 2


def prescribe(
    *, path: str, ruleset_text: str, model: str, max_budget_usd: float,
    claude_binary: str,
) -> tuple[list[dict], float]:
    """Run the read-only prescription pass. Returns (substitutions, cost_usd).

    Best-effort: any failure returns ([], 0.0) so the caller falls through to
    the backstop."""
    cmd = [
        claude_binary,
        "--dangerously-skip-permissions",
        "-p", PROMPT_TEMPLATE.format(path=path),
        "--allowedTools", "Read(*),Glob(*),Grep(*),Bash(wc*)",
        "--max-budget-usd", str(max_budget_usd),
        "--model", model,
        "--setting-sources", "",
        "--exclude-dynamic-system-prompt-sections",
        "--output-format", "json",
    ]
    if ruleset_text:
        cmd += ["--append-system-prompt", ruleset_text]

    with tempfile.TemporaryDirectory(prefix="text-correct-cwd-") as clean_cwd:
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, cwd=clean_cwd, check=False,
            )
        except (OSError, ValueError) as e:
            print(f"[text-correct] prescription spawn failed: {e}", file=sys.stderr)
            return [], 0.0

    try:
        env = json.loads(proc.stdout)
    except json.JSONDecodeError:
        print("[text-correct] prescription envelope was not JSON; backstop only",
              file=sys.stderr)
        return [], 0.0

    if not isinstance(env, dict):
        return [], 0.0
    cost = float(env.get("total_cost_usd") or 0.0)
    if env.get("is_error"):
        print(f"[text-correct] prescription returned is_error; backstop only: "
              f"{str(env.get('result'))[:160]}", file=sys.stderr)
        return [], cost
    return extract_substitutions(env.get("result", "")), cost


def apply_substitutions(text: str, subs: list[dict]) -> tuple[str, int, int]:
    applied = missed = 0
    for s in subs:
        if not isinstance(s, dict):
            missed += 1
            continue
        f_, r_ = s.get("find"), s.get("replace")
        if isinstance(f_, str) and isinstance(r_, str) and f_ and f_ in text:
            text = text.replace(f_, r_, 1)
            applied += 1
        else:
            missed += 1
    return text, applied, missed


def strip_emdashes(text: str) -> tuple[str, bool]:
    pre = text
    text = re.sub(r"\s*—\s*", ", ", text)
    text = re.sub(r"(?<=\w)\s+--\s+(?=\w)", ", ", text)
    return text, text != pre


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        return fail(f"stdin is not valid JSON: {e}")
    if not isinstance(payload, dict):
        return fail("stdin JSON must be an object")

    input_text = payload.get("input_text")
    input_text_path = payload.get("input_text_path")
    if (input_text is None) == (input_text_path is None):
        return fail("provide exactly one of `input_text` or `input_text_path`")

    output_path = payload.get("output_path")
    model = payload.get("model", "claude-sonnet-4-6")
    max_budget_usd = payload.get("max_budget_usd", 0.40)
    emdash_backstop = payload.get("emdash_backstop", True)
    claude_binary = payload.get("claude_binary", "claude")
    ruleset = payload.get("ruleset", "~/.claude/skills/stop-slop/SKILL.md")

    # Resolve the content + a path the model can Read.
    tmp_holder: tempfile.TemporaryDirectory | None = None
    if input_text_path is not None:
        if not isinstance(input_text_path, str):
            return fail("`input_text_path` must be a string")
        src = Path(input_text_path).expanduser()
        if not src.is_file():
            return fail(f"input_text_path not found: {src}")
        content = src.read_text()
        read_path = str(src.resolve())
    else:
        if not isinstance(input_text, str):
            return fail("`input_text` must be a string")
        content = input_text
        tmp_holder = tempfile.TemporaryDirectory(prefix="text-correct-in-")
        p = Path(tmp_holder.name) / "input.txt"
        p.write_text(content)
        read_path = str(p)

    ruleset_text = ""
    rs = Path(str(ruleset)).expanduser()
    if rs.is_file():
        ruleset_text = rs.read_text(errors="replace")
    else:
        print(f"[text-correct] ruleset not found ({rs}); proceeding rules-light",
              file=sys.stderr)

    subs, cost = prescribe(
        path=read_path, ruleset_text=ruleset_text, model=model,
        max_budget_usd=float(max_budget_usd), claude_binary=str(claude_binary),
    )

    corrected, applied, missed = apply_substitutions(content, subs)
    emdash_fixed = False
    if emdash_backstop:
        corrected, emdash_fixed = strip_emdashes(corrected)

    if tmp_holder is not None:
        tmp_holder.cleanup()

    result: dict[str, Any] = {
        "substitutions_applied": applied,
        "substitutions_missed": missed,
        "emdash_fixed": emdash_fixed,
        "cost_usd": cost,
        "exit_code": 0,
    }
    if output_path is not None:
        out = Path(str(output_path)).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(corrected)
        result["corrected_path"] = str(out)
    else:
        result["corrected_text"] = corrected

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
