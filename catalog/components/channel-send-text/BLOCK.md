---
name: channel-send-text
version: 1.0.0
kind: subprocess
type: component
category: channel
runtime: node
description: Send a text message via a channel adapter (telegram | whatsapp). Routes through POST /api/channels/send — the soul-hub adapter registry.
when_to_use: Notify a person via Telegram or WhatsApp from a recipe — completion alert, ping, link to an artefact. Plain text or markdown (per adapter's parseMode).
when_not_to_use: You need to send media (images, audio, files — no media support yet). You need a structured reply back from the user (use `human-form` or a gate component, not a channel). You're writing inside soul-hub app code with adapter access — call adapter.send directly.
author: jasem
project: naseej

inputs:
  - name: channel
    type: string
    enum: [telegram, whatsapp]
    required: true
    description: Channel adapter id. Must be enabled + configured in soul-hub settings.json.
  - name: text
    type: string
    required: true
    description: The message body. Plain text or markdown (per adapter's configured parseMode in settings.json). Long messages are chunked by the adapter.
  - name: api_base
    type: string
    default: http://localhost:2400
    description: Override the Soul Hub base URL.

outputs:
  - name: message_id
    type: string
    description: Adapter-assigned message id (Telegram message_id, WhatsApp serialized id). Empty string when adapter doesn't return one.
  - name: delivered_at
    type: string
    description: ISO timestamp captured on the soul-hub side after adapter.send resolved.
  - name: ok
    type: boolean
    description: Always true on exit 0 — kept for symmetry with other components and forward-compat with multi-recipient sends.

invocation:
  protocol: stdin-json
  request: '{ channel, text, api_base? }'
  response: '{ message_id, delivered_at, ok }'
  exit_codes:
    0: success
    1: api unreachable (soul-hub not running)
    2: bad input (missing field, invalid JSON, empty text)
    4: unknown channel
    5: adapter refused (disabled, unconfigured, send failed upstream)
---

# channel-send-text

The Naseej component for "tell the operator (or a chat) that something happened". Replaces the legacy pipeline `channel` step with a typed, versioned component. Routes through `POST /api/channels/send` — a thin endpoint added alongside this component that wraps the existing `sendViaChannel` registry helper.

## Why this component is small

The adapter abstraction (`adapter.send(message, attachPath?)`) is intentionally narrow. Recipes that need more — file attachments, inline keyboards, reply-threading — get dedicated components, not parameters bolted onto this one. That keeps each component single-purpose and its tests fast.

## Invocation

```bash
echo '{"channel":"telegram","text":"Recipe done. Output at projects/naseej/outputs/abc/"}' | node run.mjs
```

Output:

```json
{
  "message_id": "12345",
  "delivered_at": "2026-05-16T17:32:18.214Z",
  "ok": true
}
```

## NOT in v1.0.0 (deferred)

The ADR-003 spec listed two extra inputs that the adapter contract doesn't expose:

- `reply_to_message_id` — the Telegram `sendText` helper accepts `opts.replyToMessageId`, but `ChannelAdapter.send` (the registry-level interface) does not. Wiring it through would change the adapter contract on both Telegram and WhatsApp adapters. Out of scope for v1.0.0.
- `parse_mode` — Telegram has `delivery.parseMode` per-channel in `settings.json`, applied to every message. WhatsApp doesn't have a parse-mode concept. Per-call override would require both an adapter signature change and asymmetric handling. Out of scope for v1.0.0.

Recipes that need either today should use the underlying script (or a custom one-shot script step) until v1.1 ships the extended contract.

## Sad paths

- **Soul Hub down** — exit 1, error "cannot reach <api_base>"
- **Channel not enabled** in `settings.json` — exit 5, error "Channel \"X\" is disabled"
- **Channel unconfigured** (missing env) — exit 5, error lists the missing env vars
- **Adapter `.send` fails upstream** (network, rate limit, recipient deleted) — exit 5, error mirrored from the adapter
- **Unknown channel id** — exit 4

## Files

- `BLOCK.md` — this manifest
- `run.mjs` — entry point (Node ESM, no compile step)
- `tests/test_channel_send_text.mjs` — integration tests against live :2400

## Provenance

`POST /api/channels/send` (added with this component) at `src/routes/api/channels/send/+server.ts` wraps `sendViaChannel` from `src/lib/channels/registry.ts:64`. The same registry powers the inline `channel` step of the legacy pipeline runner, the orchestrator's `channel-send-message` tool, and the peer-brief daily render.

## Versioning

- `1.0.0` — initial. Channel + text only.
- Future `1.1` — `reply_to_message_id` + `parse_mode` after the adapter contract is extended.
- Future `1.x` — `dry_run: true` (preview without sending).
- `channel-send-file@1.0.0` — separate component for media attachments (v2).
