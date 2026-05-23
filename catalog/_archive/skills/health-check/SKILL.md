---
name: health-check
description: Check service uptime, SSL certs, DNS resolution, and endpoint health. Use when the user says /health-check or wants to verify infrastructure.
user-invocable: true
---

# Health Check (/health-check)

Verify that services and infrastructure are healthy.

## Checks
- HTTP endpoint status codes
- SSL certificate expiry
- DNS resolution
- Response time thresholds
- Service-specific health endpoints

## Output
Status table: service, status (ok/warn/error), response time, details.
