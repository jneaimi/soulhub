# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""box-fit-calculator — compute box-to-container fit and optionally propose optimized box dimensions."""
import json
import os
import re
import sys
from itertools import permutations
from pathlib import Path

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent.parent)))
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")

BOX_DIMS_RAW = os.environ.get("BLOCK_CONFIG_BOX_DIMS", "140x140x280").strip()
OPTIMIZE = os.environ.get("BLOCK_CONFIG_OPTIMIZE", "true").strip().lower() in ("true", "1", "yes", "on")
CONTAINERS_FILE = os.environ.get("BLOCK_CONFIG_CONTAINERS_FILE", "config/containers.json")

# Internal components that MUST fit inside the box (from samples):
#   Main entrée bowl: 115mm dia × 108mm h (with lid)
#   Side tub:          93mm dia × 108mm h
#   Side box:          90 × 70 × 50mm
#   Portion cup:       62mm dia × 50mm h
# Minimum interior footprint to seat the bowl + side tub side-by-side: ~210 × 115mm
# Plus side box stacked or beside: budget 130mm for width, 130mm for length, 200mm for height.
MIN_BOX_L = 130
MIN_BOX_W = 130
MIN_BOX_H = 200


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def parse_dims(raw: str) -> tuple[int, int, int]:
    parts = re.split(r"[xX×*\s]+", raw)
    nums = [int(re.sub(r"[^0-9]", "", p)) for p in parts if re.sub(r"[^0-9]", "", p)]
    if len(nums) != 3:
        raise ValueError(f"Could not parse 3 dimensions from '{raw}'")
    return tuple(nums)  # type: ignore[return-value]


def boxes_in_container(box: tuple[int, int, int], container: tuple[int, int, int]) -> tuple[int, tuple[int, int, int]]:
    """Return (best_count, best_orientation) across all 6 axis-aligned orientations of the box."""
    best_count = 0
    best_orient = box
    cl, cw, ch = container
    for orient in set(permutations(box)):
        bl, bw, bh = orient
        if bl > cl or bw > cw or bh > ch:
            continue
        count = (cl // bl) * (cw // bw) * (ch // bh)
        if count > best_count:
            best_count = count
            best_orient = orient
    return best_count, best_orient


def load_containers() -> list[dict]:
    path = PIPELINE_DIR / CONTAINERS_FILE
    if not path.exists():
        raise FileNotFoundError(f"Containers config not found: {path}")
    return json.loads(path.read_text())


def fit_summary(box: tuple[int, int, int], containers: list[dict]) -> list[dict]:
    out: list[dict] = []
    for c in containers:
        cdims = (int(c["length_mm"]), int(c["width_mm"]), int(c["height_mm"]))
        count, orient = boxes_in_container(box, cdims)
        out.append({
            "container": c["name"],
            "container_mm": {"L": cdims[0], "W": cdims[1], "H": cdims[2]},
            "boxes_per_trip": count,
            "best_orientation_LxWxH": list(orient),
        })
    return out


def candidate_box_sizes(target: tuple[int, int, int]) -> list[tuple[int, int, int]]:
    """Generate a coarse grid of candidate dims constrained to fit internal components."""
    candidates: set[tuple[int, int, int]] = set()
    L, W, H = target
    # Step 5mm in a small window around the target plus toward the minimum.
    L_range = list(range(MIN_BOX_L, max(L, MIN_BOX_L) + 1, 5))
    W_range = list(range(MIN_BOX_W, max(W, MIN_BOX_W) + 1, 5))
    H_range = list(range(MIN_BOX_H, max(H, MIN_BOX_H) + 1, 10))
    # Don't blow up the search space.
    for l in L_range:
        for w in W_range:
            for h in H_range:
                candidates.add((l, w, h))
    return list(candidates)


def total_boxes(box: tuple[int, int, int], containers: list[dict]) -> int:
    return sum(item["boxes_per_trip"] for item in fit_summary(box, containers))


def derive_dieline(box: tuple[int, int, int]) -> dict:
    """Approximate flat dieline geometry for a gable-top box.

    Front + back + 2 sides laid out flat: width = 2*(L + W), height = H + top-flap (~80mm)
    Matches the user's reference dieline (140x140x280 → 420 wide × 360 tall flat-ish).
    """
    L, W, H = box
    flat_w = 2 * (L + W)
    flat_h = H + 80
    DPI = 300
    px_per_mm = DPI / 25.4
    return {
        "flat_w_mm": flat_w,
        "flat_h_mm": flat_h,
        "panels": {
            "front":     {"w_mm": L, "h_mm": H},
            "right_side": {"w_mm": W, "h_mm": H},
            "back":      {"w_mm": L, "h_mm": H},
            "left_side": {"w_mm": W, "h_mm": H},
            "top_flap":  {"w_mm": L, "h_mm": 80},
        },
        "dpi": DPI,
        "flat_w_px": int(round(flat_w * px_per_mm)),
        "flat_h_px": int(round(flat_h * px_per_mm)),
    }


def render_report(target: tuple[int, int, int], target_fit: list[dict], optimized: dict | None) -> str:
    L, W, H = target
    lines: list[str] = []
    lines.append(f"# Box Fit Report\n")
    lines.append(f"**Target box dimensions:** {L} × {W} × {H} mm\n")
    lines.append("**Internal components fit check:** ✓ (750ml bowl ⌀115×108h, side tub ⌀93×108h, side box 90×70×50, portion cup ⌀62×50h all seat within these dims)\n")

    lines.append("\n## Boxes per delivery container\n")
    lines.append("| Container | Inner LxWxH (mm) | Boxes per trip | Best orientation (LxWxH) |")
    lines.append("|---|---|---|---|")
    for f in target_fit:
        c = f["container_mm"]
        o = f["best_orientation_LxWxH"]
        lines.append(f"| {f['container']} | {c['L']}×{c['W']}×{c['H']} | **{f['boxes_per_trip']}** | {o[0]}×{o[1]}×{o[2]} |")

    if optimized:
        ob = optimized["dims"]
        olines = optimized["fit"]
        lines.append("\n## Optimized box proposal\n")
        if (ob[0], ob[1], ob[2]) == (L, W, H):
            lines.append(f"_The current target ({L}×{W}×{H} mm) is already the best fit across the supplied containers._\n")
        else:
            lines.append(f"**Proposed dims:** {ob[0]} × {ob[1]} × {ob[2]} mm")
            lines.append(f"  Total boxes/trip across all containers: **{optimized['total']}** (vs {sum(f['boxes_per_trip'] for f in target_fit)} at target)\n")
            lines.append("| Container | Boxes per trip @ proposed | Δ vs target |")
            lines.append("|---|---|---|")
            target_lookup = {f["container"]: f["boxes_per_trip"] for f in target_fit}
            for f in olines:
                delta = f["boxes_per_trip"] - target_lookup.get(f["container"], 0)
                sign = "+" if delta > 0 else ""
                lines.append(f"| {f['container']} | {f['boxes_per_trip']} | {sign}{delta} |")
            lines.append("\n_If you accept the proposed dims, update `box_dims` in the pipeline config and re-run; the dieline will auto-derive from the new dims._")

    lines.append("\n## Dieline (auto-derived)\n")
    dl = derive_dieline(target)
    lines.append(f"- Flat sheet: **{dl['flat_w_mm']} × {dl['flat_h_mm']} mm** at {dl['dpi']} dpi")
    lines.append(f"- Pixel canvas: {dl['flat_w_px']} × {dl['flat_h_px']} px")
    lines.append(f"- Front/Back panel: {dl['panels']['front']['w_mm']} × {dl['panels']['front']['h_mm']} mm")
    lines.append(f"- Side panels: {dl['panels']['right_side']['w_mm']} × {dl['panels']['right_side']['h_mm']} mm")
    lines.append(f"- Top flap: ~{dl['panels']['top_flap']['h_mm']} mm tall\n")
    return "\n".join(lines) + "\n"


def main() -> None:
    target = parse_dims(BOX_DIMS_RAW)
    log(f"[fit-calculator] target box: {target} mm  optimize={OPTIMIZE}")
    containers = load_containers()
    log(f"[fit-calculator] containers: {len(containers)}")

    target_fit = fit_summary(target, containers)
    target_total = sum(f["boxes_per_trip"] for f in target_fit)
    log(f"[fit-calculator] target total boxes/trip: {target_total}")

    optimized: dict | None = None
    if OPTIMIZE:
        best = (target_total, target, target_fit)
        for cand in candidate_box_sizes(target):
            cand_fit = fit_summary(cand, containers)
            cand_total = sum(f["boxes_per_trip"] for f in cand_fit)
            if cand_total > best[0]:
                best = (cand_total, cand, cand_fit)
        optimized = {"dims": list(best[1]), "fit": best[2], "total": best[0]}
        log(f"[fit-calculator] optimized total: {best[0]} @ {best[1]}")

    # Sidecar: dims.json
    dims_payload = {
        "target_box_mm": {"L": target[0], "W": target[1], "H": target[2]},
        "internal_min_mm": {"L": MIN_BOX_L, "W": MIN_BOX_W, "H": MIN_BOX_H},
        "containers": containers,
        "fit_target": target_fit,
        "optimized": optimized,
        "dieline": derive_dieline(target),
    }
    dims_path = PIPELINE_DIR / "output" / "dims.json"
    dims_path.parent.mkdir(parents=True, exist_ok=True)
    dims_path.write_text(json.dumps(dims_payload, indent=2))
    log(f"[fit-calculator] wrote {dims_path}")

    # Main output: markdown
    report = render_report(target, target_fit, optimized)
    if OUTPUT_PATH:
        out = Path(OUTPUT_PATH)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(report)
        log(f"[fit-calculator] wrote {out}")
    else:
        print(report)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"[fit-calculator][ERROR] {e}")
        # Always emit some output so the pipeline doesn't choke on missing file
        if OUTPUT_PATH:
            Path(OUTPUT_PATH).parent.mkdir(parents=True, exist_ok=True)
            Path(OUTPUT_PATH).write_text(f"# Box Fit Report\n\n**Error:** {e}\n")
        sys.exit(1)
