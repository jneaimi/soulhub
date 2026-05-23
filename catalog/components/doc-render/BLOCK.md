---
name: doc-render
version: 0.1.0
type: component
kind: subprocess
category: render
runtime: python
tier: 1
description: "Render an ordered composition of kind:presentation components to a single PDF via WeasyPrint. Naseej-owned document engine; replaces the external katib-build dependency."
when_to_use: "Produce a branded PDF from a sequence of presentation components (cover, module, callout, ...). Pass the ordered composition + a brand token map + lang; get back a rendered PDF path. The render engine for any document recipe."
when_not_to_use: "Score or rewrite prose (use stop-slop or inline-llm-pass). Run a non-presentation subprocess primitive (this only composes kind:presentation catalog entries). Generate charts or fetch remote images — the image/cover provider layer is Phase 2, not in this engine yet."
author: jasem
project: naseej

inputs:
  - name: composition
    type: array
    required: false
    description: "Ordered list of presentation-component instances. Each entry is an object with `component` (a kind:presentation slug in the catalog) and `inputs` (the data slots that component's template fills). Rendered top to bottom into one document. Required unless `composition_path` is supplied."
  - name: composition_path
    type: string
    required: false
    description: "Path to a JSON file holding the composition — either a bare array or an object with a `composition` key. Use when the composition is too large for the caller's inline value limit (e.g. a recipe step's 10KB stdout cap): the producer writes it to a file and passes the path. Ignored when `composition` is supplied inline."
  - name: brand
    type: object
    required: false
    description: "Brand layer merged over the shipped base tokens. Three forms: an inline token map (colors/fonts/identity/logo); a string path to a brand YAML file (has / or .yaml/.yml); or a bare brand SLUG resolved against the catalog brands dir (ADR-031). Omit for the neutral defaults."
  - name: brands_dir
    type: string
    required: false
    description: "Override the dir a brand SLUG resolves against. Defaults to the `brands` sibling of catalog_root (catalog/brands). Used by tests."
  - name: lang
    type: string
    enum: [en, ar]
    default: en
    description: "Render language. Picks template.ar when present (else falls back to the en template under dir=rtl, with a warning) and the ar font stack + per-language identity."
  - name: out_pdf
    type: string
    required: true
    description: "Output path for the rendered PDF. Parent dirs are created. Returned, resolved, as `pdf_path`."
  - name: catalog_root
    type: string
    required: false
    description: "Override the component search dir. Defaults to this component's parent (catalog/components/). Used by tests to point at a fixture catalog."

outputs:
  - name: pdf_path
    type: string
    description: Absolute path to the rendered PDF.
  - name: bytes
    type: integer
    description: Size of the rendered PDF in bytes.
  - name: components_rendered
    type: integer
    description: Count of composition entries rendered into the document.
  - name: warnings
    type: array
    description: "Non-fatal notes (e.g. an ar render that fell back to the en template, or a declared styles file that was missing). Empty on a clean render."

invocation:
  protocol: stdin-json
  request: '{ composition, brand?, lang?, out_pdf, catalog_root?, brands_dir? }'
  response: '{ pdf_path, bytes, components_rendered, warnings }'
  exit_codes:
    0: rendered ok
    2: bad input (missing/invalid composition, lang, out_pdf, brand, or catalog_root)
    5: compose or render error (component not found, not kind:presentation, missing template/styles, WeasyPrint failure)
---

# doc-render

The Naseej document render engine. Takes an ordered **composition** of `kind: presentation` components and renders them into a single branded PDF — no external `~/dev/katib` dependency. This is the component that replaces `katib-build`.

## How it works

1. Resolve tokens: shipped base tokens (`render_core/tokens.base.yaml`) ← `brand` (inline map or YAML file).
2. For each composition entry, load the named `kind: presentation` component from the catalog (`<catalog_root>/<slug>/BLOCK.md`), read its declared `template` + `styles`.
3. Render the language-appropriate Jinja template (`template.en` / `template.ar`) with the brand context (`colors`, `fonts`, `identity`, `logo`, `name`, `lang`, `dir`) plus the entry's `inputs`.
4. Collect each component's CSS (deduped by name), resolve brand tokens to `:root { --… }` CSS variables, wrap everything in an A4 page shell, and render to PDF via WeasyPrint.

## Composition shape

```json
{
  "composition": [
    { "component": "cover-page", "inputs": { "title": "Peer Brief", "date": "2026-05-20" } },
    { "component": "module",     "inputs": { "heading": "Why this brief", "body": "…" } },
    { "component": "callout",    "inputs": { "tone": "info", "title": "Summary", "body": "…" } }
  ],
  "brand": { "colors": { "accent": "#1F3A68" } },
  "lang": "en",
  "out_pdf": "/tmp/peer-brief.pdf"
}
```

## The vendored render core

`render_core/` is ported (not copied) from katib's `core/` — token resolution (`tokens.py`), composition (`compose.py`), and the WeasyPrint wrapper (`render.py`), plus the shipped `tokens.base.yaml`. The single adaptation seam is **component loading**: `compose.load_presentation_component` reads Naseej's flat `kind: presentation` catalog instead of katib recipes + tier dirs. Everything katib-product (recipe schema, image/cover provider layer, capability index, two-tier resolution) was left behind.

## Relationship to the `presentation` kind

`doc-render` is a `kind: subprocess` engine. The things it renders are `kind: presentation` components (ADR-030 CP1 added the discriminator + the `template` / `styles` / `tokens` manifest fields). Presentation components are pure templates with no run entry — they are catalog data this engine consumes.
