---
name: horizontal-bar-chart
version: 0.1.0
type: component
kind: presentation

break_inside: avoid
category: chart
tier: 1
description: "Generic horizontal bar chart drawn as inline SVG. Bars auto-scale to the largest value and are color-coded by intensity tier (high / mid / low). Value labels render next to each bar. Domain-neutral: framing comes from inputs."
languages: [en, ar]
template:
  en: en.html
  ar: ar.html
styles: styles.css
tokens:
  - "--text"
  - "--accent"
  - "--text-secondary"
  - "--border"
sample_inputs:
  eyebrow: "Volume by category"
  x_axis_label: "TOTAL VIEWS"
  items:
    - { label: "Category A", value: 1830000, value_display: "1.83M", intensity: "high" }
    - { label: "Category B", value: 920000, value_display: "920K", intensity: "mid" }
    - { label: "Category C", value: 340000, value_display: "~340K", intensity: "low" }
  caption: "Values by category; bars scale to the largest."
inputs:
  - name: eyebrow
    type: string
    required: false
  - name: title
    type: string
    required: false
  - name: x_axis_label
    type: string
    required: false
  - name: items
    type: array
    required: true
    description: "Bars to plot. Each is {label, value, value_display, intensity: high|mid|low}."
  - name: caption
    type: string
    required: false
---

# horizontal-bar-chart

A generic horizontal bar chart (ADR-034 CP1). Renders inline SVG from `items` ({label, value, value_display, intensity}); bars auto-scale to the largest value and tier-color by intensity. Domain-neutral and reusable for any ranked-value comparison.
