---
name: not-presentation
version: 0.1.0
type: component
kind: subprocess
runtime: python
description: "Test fixture — a subprocess-kind component, used to verify doc-render rejects non-presentation entries in a composition."
---

# not-presentation (test fixture)

Exists only so the CP2 test suite can assert doc-render refuses to compose a
`kind: subprocess` component.
