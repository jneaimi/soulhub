---
name: code-review
description: Automated code review checking style, complexity, and common issues. Use when the user says /review or wants a code quality check.
disable-model-invocation: true
user-invocable: true
---

# Code Review (/review)

Review changed files for quality, consistency, and potential issues.

## Checks
- Naming conventions and code style
- Cyclomatic complexity (flag functions > 10)
- Error handling patterns
- Security anti-patterns (hardcoded secrets, SQL injection, XSS)
- Dead code and unused imports
- Missing edge case handling

## Output
Per-file findings with severity: info, warning, error.
