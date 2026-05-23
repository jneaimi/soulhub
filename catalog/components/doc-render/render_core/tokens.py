"""Token resolution for the Naseej doc-render engine.

Vendored + trimmed from katib core/tokens.py (ADR-030 CP2). Naseej owns this
copy; zero runtime dependency on ~/dev/katib.

Layered merge (lowest → highest priority):
    1. render_core/tokens.base.yaml   shipped defaults
    2. brand                          token-map dict OR brand YAML file path
    3. overrides                      per-invocation (future)

Public API:
    load_base_tokens() -> dict
    load_brand(map_or_path) -> dict | None
    merge_tokens(base, brand, overrides=None) -> dict
    render_context(tokens, lang) -> dict      template context vars
    tokens_css(tokens) -> str                  `:root { --accent: ...; }` block

Dropped from the katib original (left behind as katib-product / Phase-2):
    - user-tier env dirs (KATIB_BRANDS_DIR etc.)
    - covers / brand-preset image presets (Phase-2 image layer)

Kept: the CSS-color whitelist (injection guard — `brand` may carry
operator-supplied color values), logo resolution, per-language identity.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

CORE_DIR = Path(__file__).resolve().parent
BASE_TOKENS_FILE = CORE_DIR / "tokens.base.yaml"

_COLOR_PATTERNS = (
    re.compile(r"^#[0-9a-fA-F]{3,8}$"),
    re.compile(r"^rgba?\(\s*[\d.,\s%/]+\s*\)$"),
    re.compile(r"^hsla?\(\s*[\d.,\s%/deg]+\s*\)$"),
    re.compile(r"^[a-zA-Z][a-zA-Z0-9-]*$"),
)
_LOGO_EXTENSIONS = {".png", ".jpg", ".jpeg", ".svg"}
_LOGO_HEIGHT_RANGE = (1, 200)


class TokenError(ValueError):
    """Raised when a base token file or brand profile is invalid."""


def _validate_color(key: str, val: Any) -> str:
    if not isinstance(val, str):
        raise TokenError(f"colors.{key} must be a string, got {type(val).__name__}")
    for pat in _COLOR_PATTERNS:
        if pat.match(val):
            return val
    raise TokenError(
        f"colors.{key} = {val!r} is not a recognized CSS color "
        f"(accepted: #hex, rgb()/rgba(), hsl()/hsla(), or a named color)"
    )


def load_base_tokens() -> dict[str, Any]:
    with BASE_TOKENS_FILE.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    colors = data.get("colors", {})
    for key, val in list(colors.items()):
        colors[key] = _validate_color(key, val)
    return data


def _validate_brand_dict(data: dict[str, Any], origin: str) -> dict[str, Any]:
    """Shared validation for a brand whether it arrived as a dict or a file.

    `origin` is used only for error messages (a path string or "<inline brand>").
    """
    colors = data.get("colors", {})
    if colors and not isinstance(colors, dict):
        raise TokenError(f"{origin}: `colors` must be a mapping")
    for key, val in list(colors.items()):
        colors[key] = _validate_color(key, val)

    logo = data.get("logo")
    if isinstance(logo, str):
        logo = {"primary": logo}
        data["logo"] = logo
    if isinstance(logo, dict):
        primary = logo.get("primary")
        if primary:
            logo_path = Path(primary).expanduser()
            # Resolve relative logo paths against the brand file dir when known.
            base_dir = data.get("__source_dir__")
            if not logo_path.is_absolute() and base_dir:
                logo_path = Path(base_dir) / logo_path
            if not logo_path.exists():
                raise TokenError(f"{origin}: logo.primary not found at {logo_path}")
            if logo_path.suffix.lower() not in _LOGO_EXTENSIONS:
                raise TokenError(
                    f"{origin}: logo.primary {logo_path.suffix!r} not in "
                    f"{sorted(_LOGO_EXTENSIONS)}"
                )
            logo["primary"] = str(logo_path.resolve())
        max_h = logo.get("max_height_mm", 18)
        if not isinstance(max_h, int) or not (
            _LOGO_HEIGHT_RANGE[0] <= max_h <= _LOGO_HEIGHT_RANGE[1]
        ):
            raise TokenError(
                f"{origin}: logo.max_height_mm must be int in "
                f"[{_LOGO_HEIGHT_RANGE[0]}, {_LOGO_HEIGHT_RANGE[1]}]"
            )
    return data


def _looks_like_path(s: str) -> bool:
    """A brand string is a file path if it has a path separator or a YAML
    extension; otherwise it's a catalog brand slug (ADR-031)."""
    return "/" in s or s.endswith(".yaml") or s.endswith(".yml")


def _load_brand_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise TokenError(f"brand file not found: {path}")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise TokenError(f"{path}: brand file must be a YAML mapping")
    data["__source_dir__"] = str(path.parent)
    return _validate_brand_dict(data, str(path))


def load_brand(map_or_path: Any, brands_dir: Path | str | None = None) -> dict[str, Any] | None:
    """Resolve the `brand` input. Accepts:

      - None        → no brand layer
      - dict        → an inline token-override map (validated in place)
      - str path    → a YAML brand file on disk (has `/` or .yaml/.yml ext)
      - str slug    → a catalog brand: <brands_dir>/<slug>/brand.yaml (ADR-031)
    """
    if map_or_path is None:
        return None
    if isinstance(map_or_path, dict):
        data = dict(map_or_path)
        return _validate_brand_dict(data, "<inline brand>")
    if isinstance(map_or_path, str):
        if _looks_like_path(map_or_path):
            return _load_brand_file(Path(map_or_path).expanduser())
        # Bare slug → resolve against the catalog brands dir.
        if brands_dir is None:
            raise TokenError(
                f"brand slug {map_or_path!r} given but no brands_dir to resolve it against"
            )
        slug = map_or_path
        brand_path = Path(brands_dir).expanduser() / slug / "brand.yaml"
        if not brand_path.exists():
            raise TokenError(f"brand slug {slug!r} not found at {brand_path}")
        return _load_brand_file(brand_path)
    raise TokenError(
        f"`brand` must be a token map, a file path, a brand slug, or null; "
        f"got {type(map_or_path).__name__}"
    )


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for k, v in override.items():
        if k.startswith("__"):
            continue
        if isinstance(v, dict) and isinstance(merged.get(k), dict):
            merged[k] = _deep_merge(merged[k], v)
        else:
            merged[k] = v
    return merged


def merge_tokens(
    base: dict[str, Any],
    brand: dict[str, Any] | None = None,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    merged = dict(base)
    if brand:
        merged = _deep_merge(merged, brand)
    if overrides:
        merged = _deep_merge(merged, overrides)
    return merged


def _lang_field(value: Any, lang: str, fallback_lang: str = "en") -> str:
    if isinstance(value, dict):
        if lang in value and value[lang]:
            return value[lang]
        if fallback_lang in value and value[fallback_lang]:
            return value[fallback_lang]
        return ""
    return value if isinstance(value, str) else ""


def render_context(tokens: dict[str, Any], lang: str) -> dict[str, Any]:
    identity_raw = tokens.get("identity", {}) or {}
    identity: dict[str, str] = {}
    for key, val in identity_raw.items():
        if key.endswith("_ar"):
            continue
        if lang == "ar":
            ar_sibling = identity_raw.get(f"{key}_ar")
            if ar_sibling:
                identity[key] = ar_sibling
                continue
        identity[key] = _lang_field(val, lang)

    fonts_block = tokens.get("fonts", {}) or {}
    fonts = fonts_block.get(lang, fonts_block.get("en", {})) or {}

    name_val = tokens.get("name", "")
    name = (
        _lang_field({"en": tokens.get("name", ""), "ar": tokens.get("name_ar", "")}, lang)
        if isinstance(name_val, str)
        else _lang_field(name_val, lang)
    )

    return {
        "colors": tokens.get("colors", {}),
        "fonts": fonts,
        "identity": identity,
        "logo": tokens.get("logo", {}) or {},
        "name": name,
        "legal_name": _lang_field(
            {"en": tokens.get("legal_name", ""), "ar": tokens.get("legal_name_ar", "")},
            lang,
        ),
        "lang": lang,
        "dir": "rtl" if lang == "ar" else "ltr",
    }


_COLOR_KEY_TO_VAR = {
    "page_bg": "--page-bg",
    "text": "--text",
    "text_secondary": "--text-secondary",
    "text_tertiary": "--text-tertiary",
    "accent": "--accent",
    "accent_2": "--accent-2",
    "accent_on": "--accent-on",
    "border": "--border",
    "border_strong": "--border-strong",
    "tag_bg": "--tag-bg",
    "tag_fg": "--tag-fg",
    "code_bg": "--code-bg",
    "code_fg": "--code-fg",
    "callout_info_bg": "--callout-info-bg",
    "callout_info_accent": "--callout-info-accent",
    "callout_warn_bg": "--callout-warn-bg",
    "callout_warn_accent": "--callout-warn-accent",
    "callout_danger_bg": "--callout-danger-bg",
    "callout_danger_accent": "--callout-danger-accent",
    "callout_tip_bg": "--callout-tip-bg",
    "callout_tip_accent": "--callout-tip-accent",
    "step_circle_bg": "--step-circle-bg",
    "step_circle_fg": "--step-circle-fg",
}


def tokens_css(tokens: dict[str, Any]) -> str:
    colors = tokens.get("colors", {}) or {}
    lines = [":root {"]
    for key, val in colors.items():
        var = _COLOR_KEY_TO_VAR.get(key, f"--{key.replace('_', '-')}")
        lines.append(f"    {var}: {val};")
    lines.append("}")
    return "\n".join(lines)
