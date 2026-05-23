---
name: callout
version: 0.1.0
type: component
kind: presentation

break_inside: avoid
category: primitive
tier: 1
description: "Boxed message with an accent border and tinted background. Tones map to conventional UX patterns — info/warn/danger/tip for status messages; neutral for non-status highlights (subject lines, non-binding notices)."
languages: [en, ar]
template:
  en: en.html
  ar: ar.html
styles: styles.css
tokens:
  - "--text"
  - "--accent"
  - "--tag-bg"
  - "--callout-info-bg"
  - "--callout-info-accent"
  - "--callout-warn-bg"
  - "--callout-warn-accent"
  - "--callout-danger-bg"
  - "--callout-danger-accent"
  - "--callout-tip-bg"
  - "--callout-tip-accent"
sample_inputs:
  tone: info
  title: Summary
  body: "A short highlighted note that draws the reader's attention to a key point."
inputs:
  - name: tone
    type: string
    required: true
    description: "info | warn | danger | tip | neutral. neutral uses tag_bg + accent, for non-status highlights."
  - name: title
    type: string
    required: false
    description: Optional bolded first line.
  - name: body
    type: string
    required: true
    description: The message body — plain text or minimal inline HTML.
---

# callout

A boxed message with a colored accent border and tinted background, ported into Naseej as a `kind: presentation` component (ADR-030 CP3). Rendered by `doc-render` — no run entry.

Tones: `info` (teal), `warn` (amber), `danger` (red), `tip` (green) for status messages; `neutral` (tag background + accent border) for non-status highlights. The accent border sits on the left in LTR and the right in RTL.
