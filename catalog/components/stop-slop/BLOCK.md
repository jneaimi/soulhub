---
name: stop-slop
version: 1.0.0
kind: subprocess
type: component
category: gate
runtime: python
description: Content quality gate — deterministic anti-slop scanner with 0-50 score and HARD-violation blocking
when_to_use: Score prose against the anti-slop rubric before publish/send. Block (exit 6) on score below threshold OR any hard violation. Cheap, fast, deterministic — no model cost.
when_not_to_use: Need qualitative rewriting / model-driven polish (use `inline-llm-pass` with a stop-slop framing prompt). Need a human approval rather than a rubric (use `approval-gate`). Need to score a non-English language other than the rubric covers — only `default` is implemented in v1.
author: jasem
project: naseej

inputs:
  - name: text
    type: string
    required: true
    description: The prose to score. UTF-8. Newlines preserved. HTML tags stripped before scanning.
  - name: rubric
    type: string
    enum: [default, analytical, linkedin, arabic]
    default: default
    description: Banned-phrase set to apply. v1.0.0 only implements `default`; other values accepted as forward-compat but route to `default`.
  - name: min_score
    type: integer
    default: 35
    min: 0
    max: 50
    description: Minimum total score (0-50). Below this, `passed` is false.
  - name: block_on_fail
    type: boolean
    default: true
    description: When true, non-zero exit code (6) on fail. When false, always exit 0 and let the caller decide.

outputs:
  - name: score
    type: integer
    description: Total 0-50. Sum of 5 dimensions (each 0-10, floored).
  - name: passed
    type: boolean
    description: True iff score >= min_score AND hard_violation_count == 0.
  - name: per_dimension
    type: object
    description: '{ directness, rhythm, trust, authenticity, density } — each 0-10'
  - name: hard_violations
    type: array
    description: Array of `{ kind, phrase, context }` for every HARD violation found. Empty when text is clean.
  - name: soft_violation_count
    type: integer
    description: Count of soft (non-blocking) violations detected. Lower the dimension score but do not block.
  - name: by_kind
    type: object
    description: 'Histogram `{ <violation_kind>: count }` aggregating both hard + soft violations. Empty when clean.'
  - name: min_score
    type: integer
    description: Echo of the input min_score (or default 35) — convenient for recipe authors who want to log the gate threshold without re-templating the input.
  - name: rubric
    type: string
    description: Echo of the input rubric (or default `default`) — same convenience as min_score.

invocation:
  protocol: stdin-json
  request: '{ text, rubric?, min_score?, block_on_fail? }'
  response: '{ score, passed, per_dimension, hard_violations, soft_violation_count, by_kind, min_score, rubric }'
  exit_codes:
    0: pass (or block_on_fail=false)
    6: fail (score below min_score OR hard violations present, only when block_on_fail=true)
    2: bad input (missing text, invalid JSON, etc.)
---

# stop-slop

Deterministic content quality gate. Scans prose for the same anti-slop violations the `~/.claude/skills/stop-slop` skill enforces, and produces a structured score that any Naseej recipe can branch on.

## How it works

Five 0-10 dimensions sum to a 0-50 score:

| Dimension | Demerits from |
|---|---|
| Directness | throat-clearing.HARD + emphasis-crutch.HARD + meta-commentary.HARD |
| Rhythm | em-dash.HARD + rhythm.metronomic (3 consecutive same-length sentences) |
| Trust | vague-declarative.HARD + lazy-extreme |
| Authenticity | filler-phrase + adverb + not-x-its-y.HARD |
| Density | inanimate-subject |

Each dimension floors at 0. Total floors at 0.

**HARD violations** (em-dashes, throat-clearing openers, emphasis crutches, meta-commentary, vague declaratives, "not X, it's Y") count toward the dimension and also set the `passed: false` flag regardless of score — one HARD violation fails the gate.

**Soft violations** (adverbs, filler phrases, lazy extremes, inanimate subjects, rhythm) count toward the dimension but don't independently fail the gate.

## Invocation

The runner pipes JSON on stdin and reads JSON from stdout:

```bash
echo '{"text": "Here is the thing. The implications are significant."}' | uv run run.py
```

Output (formatted):

```json
{
  "score": 38,
  "passed": false,
  "per_dimension": { "directness": 8, "rhythm": 10, "trust": 9, "authenticity": 10, "density": 10 },
  "hard_violations": [
    { "kind": "throat-clearing.HARD", "phrase": "here's the thing", "context": "..." },
    { "kind": "vague-declarative.HARD", "phrase": "the implications are significant", "context": "..." }
  ],
  "soft_violation_count": 0,
  "by_kind": { "throat-clearing.HARD": 1, "vague-declarative.HARD": 1 }
}
```

Exit code 6 (because `block_on_fail` defaults to true and two HARD violations are present).

## Files

- `BLOCK.md` — this manifest
- `run.py` — entry point; reads stdin JSON, writes stdout JSON
- `tests/` — pytest deterministic scoring tests

## Provenance

Banned-phrase lists and dimension formulas are extracted from `~/dev/soul-hub/scripts/peer-brief/stop-slop-scan.py` (the production peer-brief gate) so the two scanners stay aligned. When the peer-brief pipeline ports to a Naseej recipe, the two will dedupe into a shared `lib_stop_slop.py`. Until then, the lists are duplicated by design.

## Versioning

- `1.0.0` — initial. `rubric: default` only.
- Future `1.x` — add `analytical`, `linkedin`, `arabic` rubrics with phrase-list overlays (content-style categories, not single reports).
- Future `2.x` — breaking I/O changes (none planned).
