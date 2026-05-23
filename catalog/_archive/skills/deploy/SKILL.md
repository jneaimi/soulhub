---
name: deploy
description: Deploy to production with safety checks and rollback support. Use when the user says /deploy or wants to push to production.
disable-model-invocation: true
user-invocable: true
---

# Deploy (/deploy)

Structured deployment workflow with pre-flight checks.

## Steps
1. Run tests (fail = abort)
2. Build project
3. Show diff since last deploy
4. Confirm with user
5. Deploy (platform-specific)
6. Verify health check
7. Report success/failure

## Rollback
If health check fails after deploy, offer immediate rollback to previous version.
