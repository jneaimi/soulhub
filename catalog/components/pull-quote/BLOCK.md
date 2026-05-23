---
name: pull-quote
version: 0.1.0
type: component
kind: presentation

break_inside: avoid
category: primitive
tier: 1
description: "Emphasized blockquote — larger italic text with an accent rule (rule-leading) or a big opening quote mark (large-quote), plus optional attribution."
languages: [en, ar]
template:
  en: en.html
  ar: ar.html
styles: styles.css
tokens:
  - "--text"
  - "--accent"
  - "--text-secondary"
sample_inputs:
  text: "A concise, emphasized statement that deserves visual weight on the page."
  attribution: "Source or author"
inputs:
  - name: text
    type: string
    required: true
    description: The quote body.
  - name: attribution
    type: string
    required: false
    description: Attribution line (author, source, role).
---

# pull-quote

Emphasized blockquote, ported into Naseej as a `kind: presentation` component (ADR-034 CP1). Variants (set on the composition entry's `variant`): `rule-leading` (accent left/right rule) and `large-quote` (oversized opening quotation mark). Rendered by `doc-render`.
