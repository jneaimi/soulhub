---
name: comparison-dot-matrix
version: 0.1.0
type: component
kind: presentation

break_inside: avoid
category: chart
tier: 1
description: "Generic two-column dot-grid matrix comparing two intensity scores across rows. Each row shows filled dots per column up to its score; below-score dots are outlined. Column + row-header labels are inputs. Domain-neutral."
languages: [en, ar]
template:
  en: en.html
  ar: ar.html
styles: styles.css
tokens:
  - "--accent"
  - "--text-secondary"
sample_inputs:
  eyebrow: "Comparison"
  row_header_label: "Item"
  column_a_label: "Column A"
  column_b_label: "Column B"
  max_intensity: 5
  rows:
    - { label: "Item one", a: 5, b: 3 }
    - { label: "Item two", a: 3, b: 5 }
    - { label: "Item three", a: 4, b: 2 }
  caption: "Two-axis intensity comparison, 0–5 per row."
inputs:
  - name: eyebrow
    type: string
    required: false
  - name: title
    type: string
    required: false
  - name: row_header_label
    type: string
    required: false
    description: "Header for the row-label column. Defaults to 'Item'."
  - name: column_a_label
    type: string
    required: false
  - name: column_b_label
    type: string
    required: false
  - name: max_intensity
    type: number
    required: false
  - name: rows
    type: array
    required: true
    description: "Rows to plot. Each is {label, a, b} with a/b integers 0..max_intensity."
  - name: caption
    type: string
    required: false
---

# comparison-dot-matrix

A generic two-column dot-grid comparison matrix (ADR-034 CP1). Renders inline SVG from `rows` ({label, a, b}); column and row-header labels are inputs (no domain assumption). Reusable for any two-axis intensity comparison across N rows.
