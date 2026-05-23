# /// script
# requires-python = ">=3.12"
# dependencies = ["Pillow>=10.0.0", "arabic-reshaper>=3.0.0", "python-bidi>=0.4.2"]
# ///
"""box-dieline-exporter — render print-ready dieline artwork per (category × direction)."""
import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

try:
    import arabic_reshaper
    from bidi.algorithm import get_display
    HAS_ARABIC = True
except ImportError:
    HAS_ARABIC = False

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent.parent)))
INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")

DPI = int(os.environ.get("BLOCK_CONFIG_DPI", "300"))
WORDMARK = os.environ.get("BLOCK_CONFIG_WORDMARK", "NOMAD").strip()
LABEL_EN_ON = os.environ.get("BLOCK_CONFIG_CATEGORY_LABEL_EN", "true").lower() in ("true", "1", "yes", "on")
AR_OVERRIDE = os.environ.get("BLOCK_CONFIG_CATEGORY_LABEL_AR", "").strip()
BLEED_MM = int(os.environ.get("BLOCK_CONFIG_BLEED_MM", "3"))

# Default per-category Arabic labels (used if categories.json lacks label_ar and no override is supplied)
AR_DEFAULTS = {
    "meat": "لحم",
    "fish-seafood": "سمك ومأكولات بحرية",
    "camel-meat": "لحم الإبل",
    "general": "تشكيلة",
}

DIRECTION_STYLE = {
    "A": {"bg": (240, 230, 210), "ink": (31, 48, 86), "pattern": "single"},
    "B": {"bg": (200, 165, 120), "ink": (60, 35, 20), "pattern": "tile-3x3"},
    "C": {"bg": (15, 16, 11), "ink": (231, 106, 40), "pattern": "tile-6x6"},
}


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def get_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def get_arabic_font(size: int) -> ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/GeezaPro.ttc",
        "/System/Library/Fonts/Supplemental/Damascus.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return get_font(size)


def render_arabic(text: str) -> str:
    if not HAS_ARABIC:
        return text
    try:
        reshaped = arabic_reshaper.reshape(text)
        return get_display(reshaped)
    except Exception:
        return text


def fill_panel(panel: Image.Image, motif: Image.Image, pattern: str) -> None:
    pw, ph = panel.size
    if pattern == "single":
        target_w = int(pw * 0.65)
        scale = target_w / motif.width
        target_h = int(motif.height * scale)
        m = motif.resize((target_w, target_h), Image.Resampling.LANCZOS)
        x = (pw - target_w) // 2
        y = int(ph * 0.18)
        panel.paste(m, (x, y), m if m.mode == "RGBA" else None)
    elif pattern.startswith("tile-"):
        cols, rows = (int(s) for s in pattern.removeprefix("tile-").split("x"))
        tile_w = max(1, pw // cols)
        tile_h = max(1, ph // rows)
        m = motif.resize((tile_w, tile_h), Image.Resampling.LANCZOS)
        for r in range(rows):
            for c in range(cols):
                panel.paste(m, (c * tile_w, r * tile_h), m if m.mode == "RGBA" else None)


def render_dieline(category: str, direction: str, motif_path: Path, label_en: str, label_ar: str, dims: dict) -> Image.Image:
    style = DIRECTION_STYLE.get(direction, DIRECTION_STYLE["A"])
    px_per_mm = DPI / 25.4
    flat_w_mm = dims["dieline"]["flat_w_mm"] + 2 * BLEED_MM
    flat_h_mm = dims["dieline"]["flat_h_mm"] + 2 * BLEED_MM
    canvas_w = max(1, int(flat_w_mm * px_per_mm))
    canvas_h = max(1, int(flat_h_mm * px_per_mm))

    canvas = Image.new("RGB", (canvas_w, canvas_h), style["bg"])

    # Fill the entire flat sheet with the motif pattern (printer crops to dieline).
    if motif_path.exists():
        try:
            motif = Image.open(motif_path).convert("RGBA")
            fill_panel(canvas, motif, style["pattern"])
        except Exception as e:
            log(f"[dieline] motif load failed for {category}/{direction}: {e}")

    draw = ImageDraw.Draw(canvas)

    # Front panel center (panel 0, leftmost — front per CONTRACT-ish layout)
    front_w_mm = dims["dieline"]["panels"]["front"]["w_mm"]
    front_h_mm = dims["dieline"]["panels"]["front"]["h_mm"]
    bleed_px = int(BLEED_MM * px_per_mm)
    front_x0 = bleed_px
    front_y0 = bleed_px
    front_x1 = front_x0 + int(front_w_mm * px_per_mm)
    front_y1 = front_y0 + int(front_h_mm * px_per_mm)

    cx = (front_x0 + front_x1) // 2
    cy = (front_y0 + front_y1) // 2

    # Wordmark plate — semi-opaque rectangle to keep typography readable over busy patterns
    plate_w = int((front_x1 - front_x0) * 0.78)
    plate_h = int((front_y1 - front_y0) * 0.34)
    plate_x0 = cx - plate_w // 2
    plate_y0 = cy - plate_h // 2
    plate_x1 = plate_x0 + plate_w
    plate_y1 = plate_y0 + plate_h
    plate = Image.new("RGBA", (plate_w, plate_h), (*style["bg"], 215))
    canvas.paste(plate, (plate_x0, plate_y0), plate)

    # Wordmark
    wm_size = int(plate_h * 0.42)
    wm_font = get_font(wm_size, bold=True)
    if WORDMARK:
        wm_w = draw.textlength(WORDMARK, font=wm_font)
        wm_y = plate_y0 + int(plate_h * 0.18)
        draw.text((cx - wm_w // 2, wm_y), WORDMARK, fill=style["ink"], font=wm_font)

    # English category label
    en_font = get_font(int(plate_h * 0.16))
    en_y = plate_y0 + int(plate_h * 0.62)
    if LABEL_EN_ON and label_en:
        en_w = draw.textlength(label_en, font=en_font)
        draw.text((cx - en_w // 2, en_y), label_en, fill=style["ink"], font=en_font)

    # Arabic category label (always shown when available)
    if label_ar:
        ar_font = get_arabic_font(int(plate_h * 0.16))
        ar_text = render_arabic(label_ar)
        ar_w = draw.textlength(ar_text, font=ar_font)
        ar_y = en_y + int(plate_h * 0.20)
        draw.text((cx - ar_w // 2, ar_y), ar_text, fill=style["ink"], font=ar_font)

    # Soft cut-line indicators at panel boundaries (not a substitute for vector dieline)
    panel_widths_mm = [
        dims["dieline"]["panels"]["front"]["w_mm"],
        dims["dieline"]["panels"]["right_side"]["w_mm"],
        dims["dieline"]["panels"]["back"]["w_mm"],
        dims["dieline"]["panels"]["left_side"]["w_mm"],
    ]
    x = bleed_px
    for w_mm in panel_widths_mm[:-1]:
        x += int(w_mm * px_per_mm)
        draw.line([(x, bleed_px), (x, canvas_h - bleed_px)], fill=(255, 0, 255, 80), width=1)

    return canvas


def category_labels(cat: str) -> tuple[str, str]:
    cats_path = PIPELINE_DIR / "config" / "categories.json"
    label_en = cat
    label_ar = AR_DEFAULTS.get(cat, "")
    if cats_path.exists():
        try:
            cats = json.loads(cats_path.read_text())
            for c in cats:
                if c.get("name") == cat:
                    label_en = c.get("label", cat)
                    label_ar = c.get("label_ar", label_ar)
                    break
        except Exception:
            pass
    if AR_OVERRIDE:
        label_ar = AR_OVERRIDE
    return label_en, label_ar


def main() -> None:
    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        raise FileNotFoundError(f"PIPELINE_INPUT not found: {INPUT_PATH}")
    payload = load_json(Path(INPUT_PATH))
    finals = payload.get("finals", [])
    if not finals:
        raise ValueError("No finals in input manifest")

    dims_path = PIPELINE_DIR / "output" / "dims.json"
    if not dims_path.exists():
        raise FileNotFoundError(f"dims.json not found at {dims_path}; box-fit-calculator must run first")
    dims = load_json(dims_path)

    out_dir = PIPELINE_DIR / "output" / "print-ready"
    out_dir.mkdir(parents=True, exist_ok=True)

    index: list[dict] = []
    for f in finals:
        cat = f.get("category", "?")
        direction = f.get("direction", "?")
        motif_rel = f.get("final_path") or (f.get("fallback_concept_path") or "")
        motif_path = (PIPELINE_DIR / motif_rel) if motif_rel else Path("/dev/null")
        label_en, label_ar = category_labels(cat)
        try:
            img = render_dieline(cat, direction, motif_path, label_en, label_ar, dims)
            out_path = out_dir / f"{cat}__{direction}_dieline.png"
            img.save(out_path, "PNG", dpi=(DPI, DPI), optimize=True)
            index.append({
                "category": cat,
                "direction": direction,
                "dieline_path": str(out_path.relative_to(PIPELINE_DIR)),
                "dpi": DPI,
                "size_px": [img.width, img.height],
                "size_mm": [
                    dims["dieline"]["flat_w_mm"] + 2 * BLEED_MM,
                    dims["dieline"]["flat_h_mm"] + 2 * BLEED_MM,
                ],
                "bleed_mm": BLEED_MM,
                "label_en": label_en,
                "label_ar": label_ar,
            })
            log(f"[dieline] {cat}/{direction} -> {out_path.name} ({img.width}×{img.height}px)")
        except Exception as e:
            log(f"[dieline][WARN] {cat}/{direction} failed: {e}")

    out = {
        "dpi": DPI,
        "bleed_mm": BLEED_MM,
        "size_mm": [
            dims["dieline"]["flat_w_mm"] + 2 * BLEED_MM,
            dims["dieline"]["flat_h_mm"] + 2 * BLEED_MM,
        ],
        "items": index,
        "total": len(index),
        "note": "Raster artwork only — pair with the printer's vector cut/crease file before press.",
    }
    if OUTPUT_PATH:
        Path(OUTPUT_PATH).parent.mkdir(parents=True, exist_ok=True)
        Path(OUTPUT_PATH).write_text(json.dumps(out, indent=2))
        log(f"[dieline] wrote {OUTPUT_PATH}")
    else:
        print(json.dumps(out, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"[dieline][ERROR] {e}")
        if OUTPUT_PATH:
            Path(OUTPUT_PATH).parent.mkdir(parents=True, exist_ok=True)
            Path(OUTPUT_PATH).write_text(json.dumps({"error": str(e), "items": []}, indent=2))
        sys.exit(1)
