---
name: module
version: 0.1.0
type: component
kind: presentation
category: section
tier: 1
description: "Flexible body unit — optional numbered eyebrow, heading, intro, and body. All heading fields are optional; use without a title for continuous prose. `body` is auto-escaped plain text; `raw_body` accepts trusted HTML (tables, pull-quotes, nested callouts)."
languages: [en, ar]
template:
  en: en.html
  ar: ar.html
styles: styles.css
tokens:
  - "--text"
  - "--text-secondary"
  - "--accent"
  - "--accent-on"
  - "--border"
sample_inputs:
  eyebrow: "Section 1"
  title: Section heading
  intro: "A short paragraph that sets context for what follows."
  body: "Body text for the section — plain prose that flows under the heading."
inputs:
  - name: number
    type: int
    required: false
    description: Module number rendered as a large accent-colored digit (numbered variant only).
  - name: eyebrow
    type: string
    required: false
    description: "Above-title category label (e.g. Module 1 · Foundations)."
  - name: title
    type: string
    required: false
    description: Module heading. Omit for continuous prose sections (letter bodies, abstracts).
  - name: intro
    type: string
    required: false
    description: Paragraph under the title setting context for the body.
  - name: body
    type: string
    required: false
    description: Plain-text body. Auto-escaped — safe for any source.
  - name: raw_body
    type: string
    required: false
    description: Trusted HTML body. NOT auto-escaped — recipe-authored content only. Takes precedence over body.
---

# module

The workhorse body unit, ported into Naseej as a `kind: presentation` component (ADR-030 CP3). An optional numbered eyebrow + heading + intro head, then either an auto-escaped `body` or trusted `raw_body` HTML. Variants: `plain`, `numbered` (set at the composition entry's `variant`). Rendered by `doc-render`.
