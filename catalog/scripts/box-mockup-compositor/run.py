# /// script
# requires-python = ">=3.12"
# dependencies = ["Pillow>=10.0.0"]
# ///
"""box-mockup-compositor — render gable-box product mockups for each final motif."""
import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent.parent)))
INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")

WORDMARK = os.environ.get("BLOCK_CONFIG_NOMAD_WORDMARK", "NOMAD").strip()
TAGLINE = os.environ.get("BLOCK_CONFIG_TAGLINE", "LOGO PLACEHOLDER").strip()

# Mockup canvas
CANVAS_W = 800
CANVAS_H = 1000

# Direction-specific styling
DIRECTION_STYLE = {
    "A": {"bg": (240, 230, 210), "ink": (31, 48, 86), "pattern": "single"},
    "B": {"bg": (200, 165, 120), "ink": (60, 35, 20), "pattern": "tile-3x3"},
    "C": {"bg": (15, 16, 11), "ink": (231, 106, 40), "pattern": "tile-6x6"},
}


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def load_input() -> dict:
    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        raise FileNotFoundError(f"PIPELINE_INPUT not found: {INPUT_PATH}")
    return json.loads(Path(INPUT_PATH).read_text())


def get_font(size: int) -> ImageFont.ImageFont:
    """Try a few common fonts, fall back to default."""
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def gable_silhouette(draw: ImageDraw.ImageDraw, bg: tuple[int, int, int], outline: tuple[int, int, int]) -> tuple[int, int, int, int]:
    """Draw the gable-box body and return the front-panel bbox (x0, y0, x1, y1)."""
    body_x0, body_y0, body_x1, body_y1 = 120, 220, 680, 880
    flap_apex = (CANVAS_W // 2, 100)
    flap_left = (body_x0, body_y0)
    flap_right = (body_x1, body_y0)
    # Flap (gable top)
    draw.polygon([flap_left, flap_apex, flap_right], fill=bg, outline=outline, width=3)
    # Handle cutout
    cx, cy = CANVAS_W // 2, 165
    draw.rounded_rectangle((cx - 50, cy - 12, cx + 50, cy + 12), radius=8, outline=outline, width=2)
    # Body
    draw.rectangle((body_x0, body_y0, body_x1, body_y1), fill=bg, outline=outline, width=3)
    # Subtle perspective edge
    draw.line((body_x1, body_y0, body_x1 + 30, body_y0 - 20), fill=outline, width=2)
    draw.line((body_x1, body_y1, body_x1 + 30, body_y1 - 20), fill=outline, width=2)
    draw.line((body_x1 + 30, body_y0 - 20, body_x1 + 30, body_y1 - 20), fill=outline, width=2)
    return body_x0, body_y0, body_x1, body_y1


def fill_panel(panel: Image.Image, motif: Image.Image, pattern: str) -> Image.Image:
    pw, ph = panel.size
    if pattern == "single":
        # Center the motif at ~70% of panel width
        target_w = int(pw * 0.7)
        scale = target_w / motif.width
        target_h = int(motif.height * scale)
        m = motif.resize((target_w, target_h), Image.Resampling.LANCZOS)
        x = (pw - target_w) // 2
        y = int(ph * 0.18)
        panel.paste(m, (x, y), m if m.mode == "RGBA" else None)
    elif pattern.startswith("tile-"):
        cols, rows = (int(s) for s in pattern.removeprefix("tile-").split("x"))
        tile_w = pw // cols
        tile_h = ph // rows
        m = motif.resize((tile_w, tile_h), Image.Resampling.LANCZOS)
        for r in range(rows):
            for c in range(cols):
                panel.paste(m, (c * tile_w, r * tile_h), m if m.mode == "RGBA" else None)
    return panel


def render_mockup(category: str, direction: str, motif_path: Path) -> Image.Image:
    style = DIRECTION_STYLE.get(direction, DIRECTION_STYLE["A"])
    canvas = Image.new("RGB", (CANVAS_W, CANVAS_H), (245, 245, 245))
    draw = ImageDraw.Draw(canvas)

    bx0, by0, bx1, by1 = gable_silhouette(draw, style["bg"], style["ink"])

    # Front-panel inner area (trim 30px inside the body)
    px0, py0, px1, py1 = bx0 + 30, by0 + 60, bx1 - 30, by1 - 130
    panel = Image.new("RGB", (px1 - px0, py1 - py0), style["bg"])
    if motif_path.exists():
        try:
            motif = Image.open(motif_path).convert("RGBA")
            panel = fill_panel(panel, motif, style["pattern"])
        except Exception as e:
            log(f"[mockup] failed to load motif {motif_path}: {e}")
    canvas.paste(panel, (px0, py0))

    # Wordmark + tagline below the motif
    wordmark_font = get_font(54)
    tagline_font = get_font(20)
    cat_font = get_font(28)

    text_y = py1 + 20
    if WORDMARK:
        wm_w = draw.textlength(WORDMARK, font=wordmark_font)
        draw.text(((CANVAS_W - wm_w) // 2, text_y), WORDMARK, fill=style["ink"], font=wordmark_font)
        text_y += 60
    if TAGLINE:
        tg_w = draw.textlength(TAGLINE, font=tagline_font)
        draw.text(((CANVAS_W - tg_w) // 2, text_y), TAGLINE, fill=style["ink"], font=tagline_font)

    # Caption beneath box
    cap = f"{category}  ·  Direction {direction}"
    cap_w = draw.textlength(cap, font=cat_font)
    draw.text(((CANVAS_W - cap_w) // 2, CANVAS_H - 50), cap, fill=(80, 80, 80), font=cat_font)
    return canvas


def build_contact_sheet(mockups: list[tuple[str, str, Path]]) -> Image.Image:
    """Compose a 4 (cats) × 3 (directions) grid contact sheet."""
    cats = []
    for cat, _, _ in mockups:
        if cat not in cats:
            cats.append(cat)
    dirs = ["A", "B", "C"]
    cell_w = CANVAS_W // 2  # 400
    cell_h = CANVAS_H // 2  # 500
    sheet_w = cell_w * len(dirs)
    sheet_h = cell_h * len(cats)
    sheet = Image.new("RGB", (sheet_w, sheet_h), (255, 255, 255))
    by_key: dict[tuple[str, str], Path] = {(c, d): p for c, d, p in mockups}
    for r, cat in enumerate(cats):
        for cidx, d in enumerate(dirs):
            p = by_key.get((cat, d))
            if not p or not p.exists():
                continue
            try:
                im = Image.open(p).convert("RGB")
                im.thumbnail((cell_w, cell_h), Image.Resampling.LANCZOS)
                ox = cidx * cell_w + (cell_w - im.width) // 2
                oy = r * cell_h + (cell_h - im.height) // 2
                sheet.paste(im, (ox, oy))
            except Exception as e:
                log(f"[mockup] contact sheet skip {p}: {e}")
    return sheet


def main() -> None:
    payload = load_input()
    finals = payload.get("finals", []) or payload.get("concepts", [])
    if not finals:
        raise ValueError("No finals or concepts in input manifest")

    mockup_dir = PIPELINE_DIR / "output" / "mockups"
    mockup_dir.mkdir(parents=True, exist_ok=True)

    mockups: list[tuple[str, str, Path]] = []
    index: list[dict] = []

    for f in finals:
        cat = f.get("category", "?")
        direction = f.get("direction", "?")
        motif_rel = f.get("final_path") or (f.get("variants", [{}])[0].get("path", "") if f.get("variants") else "")
        motif_path = (PIPELINE_DIR / motif_rel) if motif_rel else Path("/dev/null")
        try:
            img = render_mockup(cat, direction, motif_path)
            out_path = mockup_dir / f"{cat}__{direction}_mockup.png"
            img.save(out_path, "PNG", optimize=True)
            mockups.append((cat, direction, out_path))
            index.append({
                "category": cat,
                "direction": direction,
                "mockup_path": str(out_path.relative_to(PIPELINE_DIR)),
                "source_motif": motif_rel,
            })
            log(f"[mockup] {cat}/{direction} -> {out_path.name}")
        except Exception as e:
            log(f"[mockup][WARN] {cat}/{direction} failed: {e}")

    # Contact sheet for the user's review
    contact_path: str | None = None
    if mockups:
        sheet = build_contact_sheet(mockups)
        sheet_path = mockup_dir / "_contact-sheet.png"
        sheet.save(sheet_path, "PNG", optimize=True)
        contact_path = str(sheet_path.relative_to(PIPELINE_DIR))
        log(f"[mockup] contact sheet -> {sheet_path.name}")

    out = {
        "mockups": index,
        "contact_sheet": contact_path,
        "total": len(index),
    }
    if OUTPUT_PATH:
        Path(OUTPUT_PATH).parent.mkdir(parents=True, exist_ok=True)
        Path(OUTPUT_PATH).write_text(json.dumps(out, indent=2))
        log(f"[mockup] wrote {OUTPUT_PATH}")
    else:
        print(json.dumps(out, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"[mockup][ERROR] {e}")
        if OUTPUT_PATH:
            Path(OUTPUT_PATH).parent.mkdir(parents=True, exist_ok=True)
            Path(OUTPUT_PATH).write_text(json.dumps({"error": str(e), "mockups": []}, indent=2))
        sys.exit(1)
