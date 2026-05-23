---
name: callout-en-only
version: 0.1.0
type: component
kind: presentation
category: primitive
tier: 1
description: "Test fixture — declares languages [en, ar] but ships only an en template, to exercise doc-render's ar→en fallback warning."
languages: [en, ar]
template:
  en: en.html
styles: styles.css
tokens:
  - "--text"
  - "--accent"
  - "--tag-bg"
inputs:
  - name: tone
    type: string
    required: true
  - name: body
    type: string
    required: true
---

# callout-en-only (test fixture)

Same template as the callout fixture but with no `template.ar`. Rendering this
under `lang: ar` must succeed with a fallback warning, not an error.
