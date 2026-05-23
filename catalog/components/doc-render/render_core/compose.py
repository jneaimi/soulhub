"""Composition: an ordered list of presentation-component instances → one HTML document.

Vendored + adapted from katib core/compose.py (ADR-030 CP2). The adaptation
seam is component loading: this engine reads Naseej's flat `kind: presentation`
catalog (catalog/components/<name>/BLOCK.md + the template/styles it declares)
instead of katib's recipe YAML + tier dirs.

Left behind (katib-product / Phase-2): recipe YAML + schema validation, the
image provider layer + brand-preset resolution, capability index, two-tier
user/bundled component resolution.

Public API:
    compose(composition, tokens, lang, catalog_root) -> tuple[str, dict]

`composition` is the doc-render `composition` input: an ordered list of
`{ "component": <slug>, "inputs": {...} }`. Each slug resolves to a
`kind: presentation` component in `catalog_root`.
"""
from __future__ import annotations

import html
from pathlib import Path
from typing import Any

import yaml
from jinja2 import Environment, FileSystemLoader, Undefined, select_autoescape

from .tokens import render_context, tokens_css


class ComposeError(ValueError):
    pass


def _parse_block_frontmatter(path: Path) -> dict[str, Any]:
    """Read the YAML frontmatter block from a BLOCK.md file.

    BLOCK.md is `---\\n<yaml>\\n---\\n<markdown body>`. We only need the
    frontmatter. Mirrors the TS manifest parser's contract (frontmatter is
    authoritative; body is human-readable prose).
    """
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise ComposeError(f"{path}: no frontmatter (file must start with `---`)")
    # Split on the first two `---` fences.
    parts = text.split("\n---", 1)
    # parts[0] still has the leading `---`; strip it.
    fm = parts[0]
    if fm.startswith("---"):
        fm = fm[3:]
    try:
        data = yaml.safe_load(fm) or {}
    except yaml.YAMLError as e:
        raise ComposeError(f"{path}: frontmatter is not valid YAML: {e}") from e
    if not isinstance(data, dict):
        raise ComposeError(f"{path}: frontmatter must be a YAML mapping")
    return data


def load_presentation_component(name: str, catalog_root: Path) -> dict[str, Any]:
    """Resolve a `kind: presentation` component by slug under catalog_root.

    Returns the parsed manifest augmented with `__dir__`. Raises ComposeError
    if the component is missing, is not `kind: presentation`, or omits the
    template/styles a presentation component must declare (CP1 schema enforces
    this on publish; we re-check here so the engine fails loudly on a hand-rolled
    catalog).
    """
    cdir = catalog_root / name
    block = cdir / "BLOCK.md"
    if not block.exists():
        raise ComposeError(
            f"component {name!r} not found at {block} "
            f"(catalog_root={catalog_root})"
        )
    manifest = _parse_block_frontmatter(block)
    kind = manifest.get("kind", "subprocess")
    if kind != "presentation":
        raise ComposeError(
            f"component {name!r} is kind={kind!r}; doc-render only composes "
            f"`kind: presentation` components"
        )
    template = manifest.get("template")
    if not isinstance(template, dict) or not template.get("en"):
        raise ComposeError(
            f"component {name!r}: presentation manifest must declare template.en"
        )
    if not manifest.get("styles"):
        raise ComposeError(
            f"component {name!r}: presentation manifest must declare `styles`"
        )
    manifest["__dir__"] = str(cdir)
    return manifest


def _jinja_env(component_dir: Path) -> Environment:
    """Jinja env rooted at a component dir, with katib's item-first getattr so
    `{{ input.title }}` resolves the 'title' KEY of the inputs dict (and a
    missing key evaluates falsy in `{%- if input.x %}`), not dict.title()."""
    env = Environment(
        loader=FileSystemLoader(str(component_dir)),
        undefined=Undefined,
        autoescape=select_autoescape(enabled_extensions=("html", "htm"), default=True),
        keep_trailing_newline=True,
    )
    original_getattr = env.getattr

    def _getattr_item_first(obj: Any, attribute: Any) -> Any:
        if isinstance(obj, dict):
            try:
                return obj[attribute]
            except KeyError:
                return env.undefined(name=attribute)
        try:
            return obj[attribute]
        except (TypeError, LookupError):
            return original_getattr(obj, attribute)

    env.getattr = _getattr_item_first
    return env


_RAW_HTML_INPUTS = ("raw_body", "sidebar_html", "main_html")


def _render_raw_html_inputs(inputs: dict, ctx: dict, component_dir: Path) -> dict:
    """Pre-render Jinja in raw-HTML pass-through inputs so inline-SVG palette
    interpolation (`{{ colors.accent }}`) resolves to literal hex — WeasyPrint's
    SVG parser cannot resolve CSS var(). Only the three known raw-HTML slots,
    only when `{{` is present, to leave literal-brace content untouched."""
    out = dict(inputs)
    env = _jinja_env(component_dir)
    for key in _RAW_HTML_INPUTS:
        val = out.get(key)
        if isinstance(val, str) and "{{" in val:
            out[key] = env.from_string(val).render(**ctx)
    return out


def compose(
    composition: list[dict[str, Any]],
    tokens: dict[str, Any],
    lang: str,
    catalog_root: Path,
) -> tuple[str, dict[str, Any]]:
    """Render a composition (ordered presentation-component instances) → HTML.

    Returns (page_html, meta). meta carries components_rendered + warnings.
    """
    ctx = render_context(tokens, lang)

    body_parts: list[str] = []
    style_parts: list[str] = []
    seen_styles: set[str] = set()
    warnings: list[str] = []
    rendered_count = 0

    for idx, entry in enumerate(composition):
        if not isinstance(entry, dict) or "component" not in entry:
            raise ComposeError(
                f"composition[{idx}] must be an object with a `component` key"
            )
        comp_name = entry["component"]
        comp = load_presentation_component(comp_name, catalog_root)
        comp_dir = Path(comp["__dir__"])

        # Language support: a presentation manifest may declare `languages`.
        langs = comp.get("languages")
        if isinstance(langs, list) and lang not in langs:
            raise ComposeError(
                f"component {comp_name!r} declares languages {langs}; "
                f"requested render lang {lang!r} is not supported"
            )

        # Template path comes from the manifest (template.en / template.ar),
        # falling back to en when the ar variant is absent.
        template_map = comp["template"]
        template_rel = template_map.get(lang) or template_map["en"]
        if lang == "ar" and not template_map.get("ar"):
            warnings.append(
                f"component {comp_name!r} has no ar template; rendered the en template under dir=rtl"
            )
        env = _jinja_env(comp_dir)
        template = env.get_template(template_rel)

        inputs = dict(entry.get("inputs", {}) or {})
        inputs = _render_raw_html_inputs(inputs, ctx, comp_dir)

        rendered = template.render(
            **ctx,
            input=inputs,
            inputs=inputs,
            variant=entry.get("variant"),
            component={"name": comp_name, "version": comp.get("version")},
        )
        # Page-break protection: a component declaring `break_inside: avoid`
        # is kept whole on one page (atomic blocks — pull-quote, callout,
        # figure, cover). Long prose (modules) leave it unset and flow. The
        # document template may OVERRIDE per composition entry (e.g. a module
        # instance that IS an atomic box, like an About-the-Author card).
        break_inside = entry.get("break_inside") or comp.get("break_inside")
        wrap_style = ""
        if break_inside == "avoid":
            wrap_style = ' style="break-inside: avoid; page-break-inside: avoid;"'
        body_parts.append(
            f'<div id="naseej-section-{idx}"{wrap_style}>\n'
            f"<!-- section[{idx}]: {comp_name} -->\n{rendered.rstrip()}\n"
            f"</div>\n"
        )
        rendered_count += 1

        # Component styles, deduped by name (a component used twice contributes once).
        if comp_name not in seen_styles:
            seen_styles.add(comp_name)
            styles_file = comp_dir / comp["styles"]
            if styles_file.exists():
                style_parts.append(
                    f"/* {comp_name} */\n{styles_file.read_text(encoding='utf-8')}"
                )
            else:
                warnings.append(
                    f"component {comp_name!r}: declared styles {comp['styles']!r} not found at {styles_file}"
                )

    page_html = _wrap_page(
        body="\n".join(body_parts),
        token_css=tokens_css(tokens),
        component_css="\n\n".join(style_parts),
        lang=lang,
        direction=ctx["dir"],
        fonts=ctx["fonts"],
        title=ctx.get("name") or "document",
    )

    return page_html, {
        "components_rendered": rendered_count,
        "warnings": warnings,
        "lang": lang,
    }


def _wrap_page(
    *,
    body: str,
    token_css: str,
    component_css: str,
    lang: str,
    direction: str,
    fonts: dict,
    title: str,
) -> str:
    """Minimal page shell with token CSS + base typography. Vendored verbatim
    from katib core/compose._wrap_page."""
    primary = fonts.get("primary") or "system-ui"
    display = fonts.get("display") or primary
    mono = fonts.get("mono") or "JetBrains Mono"
    fallback = fonts.get("fallback") or "sans-serif"
    safe_title = html.escape(title, quote=True)

    font_vars = (
        f'    --font-primary: "{primary}", {fallback};\n'
        f'    --font-display: "{display}", {fallback};\n'
        f'    --font-mono: "{mono}", monospace;\n'
    )
    token_css_with_fonts = (
        token_css.replace("}", font_vars + "}", 1)
        if token_css.endswith("}")
        else token_css
    )

    base_css = f"""
@page {{
    size: A4;
    margin: 20mm;
    background: var(--page-bg);
}}
html, body {{
    background: var(--page-bg);
    color: var(--text);
    margin: 0;
    padding: 0;
}}
body {{
    font-family: var(--font-primary);
    direction: {direction};
    font-size: 11pt;
    line-height: 1.6;
}}

h1, h2, h3, h4 {{
    font-family: var(--font-display);
    line-height: 1.25;
    margin: 1em 0 0.4em 0;
    color: var(--text);
}}
h1 {{ font-size: 22pt; font-weight: 700; }}
h2 {{ font-size: 15pt; font-weight: 700; }}
h3 {{ font-size: 12pt; font-weight: 700; }}
h4 {{ font-size: 11pt; font-weight: 700; }}

p {{ margin: 0.5em 0; }}

ul, ol {{
    margin: 0.6em 0;
    padding-left: 1.4em;
}}
[dir="rtl"] ul,
[dir="rtl"] ol {{
    padding-left: 0;
    padding-right: 1.4em;
}}
li {{ margin: 0.3em 0; }}

code {{
    font-family: var(--font-mono, "JetBrains Mono", monospace);
    background: var(--code-bg);
    color: var(--code-fg);
    padding: 1pt 4pt;
    border-radius: 2pt;
    font-size: 9.5pt;
}}

a {{ color: var(--accent); text-decoration: none; }}
""".strip()

    return f"""<!DOCTYPE html>
<html lang="{lang}" dir="{direction}">
<head>
<meta charset="utf-8">
<title>{safe_title}</title>
<style>
{token_css_with_fonts}

{base_css}

{component_css}
</style>
</head>
<body>
{body}
</body>
</html>
"""
