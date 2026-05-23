# /// script
# requires-python = ">=3.12"
# dependencies = ["Pillow>=10.0.0"]
# ///
"""box-direction-analyzer — extract dominant palette per A/B/C direction from reference imagery."""
import json
import os
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent.parent)))
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")

SAMPLES_FOLDER = os.environ.get("BLOCK_CONFIG_SAMPLES_FOLDER", "samples")
DIRECTIONS_FILE = os.environ.get("BLOCK_CONFIG_DIRECTIONS_FILE", "config/directions.json")
DIRECTIONS_IMAGE = os.environ.get("BLOCK_CONFIG_DIRECTIONS_IMAGE", "04-directions-abc.jpeg")

TOP_N = 5
QUANT_COLORS = 16  # adaptive palette size before counting top-N
SAMPLE_SIZE = 400  # downscale before quantization (speed + noise reduction)


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def load_directions() -> list[dict]:
    p = PIPELINE_DIR / DIRECTIONS_FILE
    if not p.exists():
        raise FileNotFoundError(f"Directions config not found: {p}")
    return json.loads(p.read_text())


def crop_thirds(img: Image.Image) -> list[Image.Image]:
    """Split into three vertical strips (left, center, right). Returns up to N crops."""
    w, h = img.size
    third = w // 3
    # Trim 5% off each side of each crop to avoid panel-edge bleed and labels at the bottom.
    bottom_trim = int(h * 0.18)  # the A/B/C labels sit beneath the boxes
    side_trim = int(third * 0.05)
    crops = []
    for i in range(3):
        x0 = i * third + side_trim
        x1 = (i + 1) * third - side_trim
        crops.append(img.crop((x0, 0, x1, h - bottom_trim)))
    return crops


def dominant_colors(img: Image.Image, top_n: int = TOP_N) -> list[tuple[str, float]]:
    """Return [(hex, share)] for top-N quantized colors, sorted by frequency."""
    img = img.convert("RGB")
    img.thumbnail((SAMPLE_SIZE, SAMPLE_SIZE))
    quantized = img.quantize(colors=QUANT_COLORS, method=Image.Quantize.FASTOCTREE)
    palette = quantized.getpalette()
    counts: Counter[int] = Counter()
    for px in quantized.getdata():
        counts[px] += 1
    total = sum(counts.values())
    out: list[tuple[str, float]] = []
    for idx, n in counts.most_common(top_n):
        r, g, b = palette[idx * 3 : idx * 3 + 3]
        out.append((f"#{r:02x}{g:02x}{b:02x}", n / total))
    return out


def render_report(directions: list[dict], analyses: list[dict | None], image_path: Path | None) -> str:
    lines: list[str] = []
    lines.append("# Direction Style Fingerprints\n")
    if image_path is None or not image_path.exists():
        lines.append(f"_Reference image not found at `{image_path}` — palette descriptions are declared-only._\n")
    else:
        lines.append(f"_Source: `{image_path.relative_to(PIPELINE_DIR)}`. Crops extracted left→right as A | B | C, palette quantized via Pillow FASTOCTREE._\n")

    for d, a in zip(directions, analyses):
        lines.append(f"\n## {d['code']} — {d['name']}\n")
        lines.append(f"**Declared palette:** {d['palette']}")
        lines.append(f"**Line style:** {d['line_style']}")
        lines.append(f"**Texture / pattern:** {d['texture_notes']}\n")
        if a and a.get("colors"):
            lines.append("**Extracted hex codes (top 5 by area share):**\n")
            lines.append("| Hex | Approx share |")
            lines.append("|---|---|")
            for hexcode, share in a["colors"]:
                lines.append(f"| `{hexcode}` | {share*100:.1f}% |")
            lines.append("")
        else:
            lines.append("_No extracted colors available for this direction._\n")

    lines.append("\n## How the designer must use this\n")
    lines.append("1. The motif brief MUST cite at least 3 hex codes per direction VERBATIM from the table above.")
    lines.append("2. Line-style descriptors must be quoted exactly (etched line-art / hand-drawn organic / flat geometric icon).")
    lines.append("3. Generation prompts for direction A cannot reference direction B or C palette/style fields. Drift is the #1 risk.")
    lines.append("4. All motif prompts MUST end with: `no text, no logo, no labels, no typography of any kind`.\n")
    return "\n".join(lines) + "\n"


def main() -> None:
    directions = load_directions()
    image_path = PIPELINE_DIR / SAMPLES_FOLDER / DIRECTIONS_IMAGE
    log(f"[direction-analyzer] directions: {[d['code'] for d in directions]}")
    log(f"[direction-analyzer] reference: {image_path}")

    analyses: list[dict | None] = []
    if image_path.exists():
        try:
            img = Image.open(image_path)
            crops = crop_thirds(img)
            for d, crop in zip(directions, crops):
                colors = dominant_colors(crop)
                analyses.append({"colors": colors})
                log(f"[direction-analyzer] {d['code']}: {colors[:3]}")
        except Exception as e:
            log(f"[direction-analyzer][WARN] palette extraction failed: {e}")
            analyses = [None] * len(directions)
    else:
        log(f"[direction-analyzer][WARN] reference image not found")
        analyses = [None] * len(directions)

    # Sidecar JSON for downstream agents that prefer structured data
    sidecar = {
        "directions": [
            {**d, "extracted_colors": a["colors"] if a else []}
            for d, a in zip(directions, analyses)
        ],
        "reference_image": str(image_path) if image_path.exists() else None,
    }
    sidecar_path = PIPELINE_DIR / "output" / "directions.json"
    sidecar_path.parent.mkdir(parents=True, exist_ok=True)
    sidecar_path.write_text(json.dumps(sidecar, indent=2))
    log(f"[direction-analyzer] wrote {sidecar_path}")

    report = render_report(directions, analyses, image_path)
    if OUTPUT_PATH:
        out = Path(OUTPUT_PATH)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(report)
        log(f"[direction-analyzer] wrote {out}")
    else:
        print(report)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"[direction-analyzer][ERROR] {e}")
        if OUTPUT_PATH:
            Path(OUTPUT_PATH).parent.mkdir(parents=True, exist_ok=True)
            Path(OUTPUT_PATH).write_text(f"# Direction Style Fingerprints\n\n**Error:** {e}\n")
        sys.exit(1)
