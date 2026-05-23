---
name: callout
version: 0.1.0
type: component
kind: presentation
category: primitive
tier: 1
description: "Test fixture — boxed message with accent border and tinted background. Tones map to info/warn/danger/tip; neutral for non-status highlights."
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
inputs:
  - name: tone
    type: string
    required: true
    description: "info | warn | danger | tip | neutral."
  - name: title
    type: string
    required: false
    description: Optional bolded first line.
  - name: body
    type: string
    required: true
    description: The message body.
---

# callout (test fixture)

Presentation-kind fixture for the doc-render CP2 test suite. Mirrors the spike
callout: a tone-driven boxed message rendered purely from template + styles +
brand tokens, with no run entry.
