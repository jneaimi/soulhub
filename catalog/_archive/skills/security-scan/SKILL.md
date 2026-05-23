---
name: security-scan
description: Scan codebase for vulnerabilities, exposed secrets, and OWASP issues. Use when the user says /security-scan or before security review.
disable-model-invocation: true
user-invocable: true
---

# Security Scan (/security-scan)

Scan project files for common security vulnerabilities.

## Checks
- Hardcoded API keys, tokens, passwords
- SQL injection patterns
- XSS vulnerabilities
- Path traversal risks
- Insecure dependencies (if lock file present)
- Overly permissive file permissions
- CORS misconfigurations

## Output
Findings with OWASP category, severity (critical/high/medium/low), file:line, and remediation.
