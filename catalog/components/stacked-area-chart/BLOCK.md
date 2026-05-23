---
name: stacked-area-chart
version: 0.1.0
type: component
kind: presentation

break_inside: avoid
category: chart
tier: 1
description: "Generic stacked-area chart drawn as inline SVG from pre-computed polygon bands over an x-axis, with optional ticks, legend, and a highlighted column. Domain-neutral: all framing comes from inputs."
languages: [en, ar]
template:
  en: en.html
  ar: ar.html
styles: styles.css
tokens:
  - "--accent"
  - "--text-secondary"
sample_inputs:
  eyebrow: "Trend"
  title: "Volume over time"
  chart_geometry: { view_w: 600, view_h: 240, chart_top: 20, chart_bottom: 210, chart_left: 40, chart_right: 580 }
  y_ticks:
    - { y: 210, label: "0" }
    - { y: 115, label: "50" }
    - { y: 20, label: "100" }
  x_ticks:
    - { x: 40, label: "T-6" }
    - { x: 310, label: "T-3" }
    - { x: 580, label: "now" }
  bands:
    - { cluster: "Series A", color: "#1F3A68", points: "40,180 310,160 580,150 580,210 40,210", today_value: 42 }
    - { cluster: "Series B", color: "#D4A437", points: "40,150 310,120 580,110 580,150 310,160 40,180", today_value: 18 }
  today_x: 580
  today_index: 6
  caption: "Stacked series volume over the window; latest column highlighted."
inputs:
  - name: eyebrow
    type: string
    required: false
  - name: title
    type: string
    required: false
  - name: bands
    type: array
    required: true
    description: "Stacked area bands, bottom to top. Each is {cluster, color, points, today_value}."
  - name: x_ticks
    type: array
    required: true
    description: "X-axis ticks. Each is {x, label}."
  - name: y_ticks
    type: array
    required: true
    description: "Y-axis ticks. Each is {y, label}."
  - name: today_x
    type: number
    required: false
    description: X coordinate for the highlighted column rule.
  - name: today_index
    type: number
    required: false
  - name: y_max
    type: number
    required: false
  - name: chart_geometry
    type: object
    required: true
    description: "SVG geometry. {view_w, view_h, chart_top, chart_bottom, chart_left, chart_right}."
  - name: caption
    type: string
    required: false
---

# stacked-area-chart

A generic stacked-area chart (ADR-034 CP1). Renders inline SVG from pre-computed `bands` (polygon point strings), `x_ticks`, `y_ticks`, and `chart_geometry`, with an optional highlighted column (`today_x`). Domain-neutral — a caller computes the geometry and supplies the framing (title / eyebrow / caption) via inputs; reusable for any time-series, not just signal volume.
