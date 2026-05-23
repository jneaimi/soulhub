# /// script
# requires-python = ">=3.12"
# dependencies = ["Pillow>=10.0.0"]
# ///
"""box-packing-spec — produce ops-ready packing markdown with diagrams."""
import json
import os
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent.parent)))
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")

AVG_KG = float(os.environ.get("BLOCK_CONFIG_AVG_BOX_WEIGHT_KG", "1.5"))


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def get_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def render_top_down(container: dict, box_lwh: tuple[int, int, int], orient: tuple[int, int, int], out_path: Path) -> None:
    """Render the lowest layer of boxes packed inside the container, top-down view."""
    cl = int(container["length_mm"])
    cw = int(container["width_mm"])
    bl, bw, _ = orient

    # Canvas: scale so longest side fits 700px
    max_px = 700
    scale = max_px / max(cl, cw)
    canvas_w = int(cl * scale) + 80
    canvas_h = int(cw * scale) + 120
    img = Image.new("RGB", (canvas_w, canvas_h), (250, 250, 250))
    draw = ImageDraw.Draw(img)

    cx0, cy0 = 40, 60
    cx1 = cx0 + int(cl * scale)
    cy1 = cy0 + int(cw * scale)
    # Container outline
    draw.rectangle((cx0, cy0, cx1, cy1), outline=(80, 80, 80), width=3)
    title_font = get_font(16, bold=True)
    label_font = get_font(11)

    draw.text((cx0, 20), f"{container['name']} — top-down (one layer)", fill=(40, 40, 40), font=title_font)
    draw.text((cx0, 38), f"container {cl}×{cw} mm  ·  box {bl}×{bw} mm  (best orientation)", fill=(110, 110, 110), font=label_font)

    # Boxes
    cols = cl // bl if bl else 0
    rows = cw // bw if bw else 0
    for r in range(rows):
        for c in range(cols):
            bx0 = cx0 + int(c * bl * scale)
            by0 = cy0 + int(r * bw * scale)
            bx1 = bx0 + int(bl * scale)
            by1 = by0 + int(bw * scale)
            draw.rectangle((bx0 + 1, by0 + 1, bx1 - 1, by1 - 1), fill=(255, 144, 60), outline=(180, 80, 20), width=1)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "PNG", optimize=True)


def main() -> None:
    dims_path = PIPELINE_DIR / "output" / "dims.json"
    if not dims_path.exists():
        raise FileNotFoundError(f"dims.json not found at {dims_path}")
    dims = json.loads(dims_path.read_text())

    box = dims["target_box_mm"]
    box_lwh = (box["L"], box["W"], box["H"])
    diagrams_dir = PIPELINE_DIR / "output" / "packing-diagrams"
    diagrams_dir.mkdir(parents=True, exist_ok=True)

    lines: list[str] = []
    lines.append("# Gnomadme Delivery Packing Spec\n")
    lines.append(f"**Target box:** {box['L']} × {box['W']} × {box['H']} mm")
    lines.append(f"**Avg filled-box weight (assumed):** {AVG_KG} kg\n")

    lines.append("## Per-container packing\n")
    for f in dims["fit_target"]:
        c_meta = next((c for c in dims["containers"] if c["name"] == f["container"]), None)
        if not c_meta:
            continue
        orient = tuple(f["best_orientation_LxWxH"])
        boxes_per_trip = f["boxes_per_trip"]
        payload_kg = boxes_per_trip * AVG_KG
        max_kg = c_meta.get("max_weight_kg", 0)
        weight_warn = ""
        if max_kg and payload_kg > max_kg:
            weight_warn = f" ⚠️ exceeds container max {max_kg} kg — cap at {int(max_kg / AVG_KG)} boxes/trip by weight"

        diag_path = diagrams_dir / f"{slug(f['container'])}.png"
        try:
            render_top_down(c_meta, box_lwh, orient, diag_path)
        except Exception as e:
            log(f"[packing] diagram failed for {f['container']}: {e}")
            diag_path = None  # type: ignore[assignment]

        cm = f["container_mm"]
        lines.append(f"### {f['container']}\n")
        lines.append(f"- Container: {cm['L']} × {cm['W']} × {cm['H']} mm  ·  max {max_kg} kg")
        lines.append(f"- Best orientation (LxWxH): {orient[0]} × {orient[1]} × {orient[2]} mm")
        lines.append(f"- **Boxes per trip:** {boxes_per_trip}")
        lines.append(f"- Estimated payload: {payload_kg:.1f} kg{weight_warn}")
        if diag_path:
            rel = diag_path.relative_to(PIPELINE_DIR)
            lines.append(f"\n![{f['container']}](./{rel})\n")
        else:
            lines.append("")

    if dims.get("optimized") and tuple(dims["optimized"]["dims"]) != box_lwh:
        opt = dims["optimized"]
        lines.append("## If you adopt the optimized box\n")
        lines.append(f"**Proposed:** {opt['dims'][0]} × {opt['dims'][1]} × {opt['dims'][2]} mm  ·  total {opt['total']} boxes/trip across all containers (vs current {sum(f['boxes_per_trip'] for f in dims['fit_target'])}).\n")
        lines.append("| Container | Boxes/trip @ proposed | Δ |")
        lines.append("|---|---|---|")
        cur = {f["container"]: f["boxes_per_trip"] for f in dims["fit_target"]}
        for f in opt["fit"]:
            d = f["boxes_per_trip"] - cur.get(f["container"], 0)
            sign = "+" if d > 0 else ""
            lines.append(f"| {f['container']} | {f['boxes_per_trip']} | {sign}{d} |")
        lines.append("")

    lines.append("## Notes\n")
    lines.append("- Diagrams show the lowest layer only; vertical stacking shown in the box-fit-calculator report.")
    lines.append("- The orange rectangles represent the box footprint in its best orientation.")
    lines.append("- Hand this spec to your delivery partner alongside the dieline artwork.")

    report = "\n".join(lines) + "\n"
    if OUTPUT_PATH:
        Path(OUTPUT_PATH).parent.mkdir(parents=True, exist_ok=True)
        Path(OUTPUT_PATH).write_text(report)
        log(f"[packing] wrote {OUTPUT_PATH}")
    else:
        print(report)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"[packing][ERROR] {e}")
        if OUTPUT_PATH:
            Path(OUTPUT_PATH).parent.mkdir(parents=True, exist_ok=True)
            Path(OUTPUT_PATH).write_text(f"# Gnomadme Delivery Packing Spec\n\n**Error:** {e}\n")
        sys.exit(1)
