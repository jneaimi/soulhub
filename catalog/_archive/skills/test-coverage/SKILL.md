---
name: test-coverage
description: Run tests and generate coverage reports with threshold enforcement. Triggers on /test-coverage or when reviewing test quality.
user-invocable: true
---

# Test Coverage (/test-coverage)

Run the project's test suite and report coverage metrics.

## Behavior
1. Detect test framework (jest, vitest, pytest, go test)
2. Run tests with coverage enabled
3. Parse coverage output
4. Report: lines, branches, functions
5. Flag files below threshold (default: 80%)

## Output
- Summary table of coverage by file
- List of uncovered lines for files below threshold
- Suggested test cases for critical gaps
