---
name: cover-page
version: 0.1.0
type: component
kind: presentation
category: cover
tier: 1
description: "Full-page document opener. Defaults to a minimalist-typographic layout (CSS-only); supply an `image` path and it full-bleeds that photo with a dark gradient overlay for legible white text. Optional logo + author from the brand layer; eyebrow, title, subtitle, and a footer reference code from inputs."
languages: [en, ar]
template:
  en: en.html
  ar: ar.html
styles: styles.css
tokens:
  - "--text"
  - "--text-secondary"
  - "--text-tertiary"
  - "--accent-2"
  - "--border-strong"
sample_inputs:
  eyebrow: Report
  title: Document Title
  subtitle: "A supporting subtitle line that sets context for the document."
  reference_code: REF-001
inputs:
  - name: eyebrow
    type: string
    required: false
    slot_class: static
    description: "Category label above the title (e.g. Tutorial, Strategy brief). Usually a standing series label — set once."
  - name: title
    type: string
    required: true
    slot_class: judgment
    description: The cover title.
  - name: subtitle
    type: string
    required: false
    slot_class: judgment
    description: Supporting line under the title.
  - name: reference_code
    type: string
    required: false
    slot_class: deterministic
    description: Monospace code rendered in the footer strip. Usually computed (date / sequence) each run.
  - name: image
    type: string
    required: false
    slot_class: deterministic
    description: "Absolute path (or file:// URI) to a full-bleed background photo. When present the cover switches to the image-background layout: the photo covers the page, a dark gradient overlay keeps the white title legible. Omit for the minimalist-typographic layout. Typically a deterministic slot — a pipeline picks today's image from a pool by date, no model call."
---

# cover-page

The document opener, ported into Naseej as a `kind: presentation` component (ADR-030 CP3). The logo and author come from the active brand layer (`logo.primary`, `identity.author_name`); the eyebrow, title, subtitle, and footer reference code come from inputs.

Two layouts, selected by the presence of the `image` input:

- **minimalist-typographic** (default, no `image`): pure CSS, title on the page background.
- **image-background** (`image` supplied): the photo full-bleeds to the page edges (a negative margin cancels the 20mm page margin), a dark gradient overlay sits over it, and the title/subtitle/footer render in white. No image **provider** layer is involved — the caller supplies a ready image path, so a pipeline can rotate through a pool of pre-generated covers by date (a deterministic slot) without any generation cost.
