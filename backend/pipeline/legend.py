"""Auto-find the legend on a plan and cut one reference crop per symbol.

Two model calls (both use schema-enforced JSON, so no free-text parsing):
  1. locate the legend block on the whole page
  2. zoom into that block and box each symbol's drawn graphic (not its text)
The model's boxes are approximate, so each one is snapped to the real ink and cut away from
neighbouring text before being saved. The user can still Redo any crop by hand.
"""
import re

import cv2
import numpy as np
from PIL import Image

from . import vlm

BOX = {"type": "array", "items": {"type": "integer"}, "minItems": 4, "maxItems": 4}


def _fit(img, long_side, allow_up=1.0):
    k = min(long_side / max(img.size), allow_up)
    if abs(k - 1) < 0.02:
        return img, 1.0
    return img.resize((max(1, int(img.width * k)), max(1, int(img.height * k))), Image.LANCZOS), k


def _call(api_key, model, text, img, schema):
    content = [{"type": "text", "text": text}, {"type": "image_url", "image_url": {"url": vlm._data_url_from_pil(img)}}]
    import json
    data = vlm.ask_model(api_key, model, content, schema)
    return json.loads(data["choices"][0]["message"]["content"])


def _clamp_box(b, w, h):
    """model box is [x0, y0, x1, y1] on a 0-1000 grid -> pixel (x0, y0, x1, y1) in a w x h image"""
    x0, y0, x1, y1 = [max(0, min(1000, int(v))) for v in b]
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    return int(x0 * w / 1000), int(y0 * h / 1000), int(x1 * w / 1000), int(y1 * h / 1000)


def snap_to_symbol(gray, box, ink=170, split=True, pad_frac=0.12):
    """Shrink-wrap to ink inside `box` (padded a little), keep only the ink cluster under the box
    centre so text printed beside the symbol is not included. Returns (x, y, w, h) or None."""
    H, W = gray.shape
    x0, y0, x1, y1 = box
    px = max(2, int(pad_frac * (x1 - x0)))
    py = max(2, int(pad_frac * (y1 - y0)))
    X0, Y0, X1, Y1 = max(0, x0 - px), max(0, y0 - py), min(W, x1 + px), min(H, y1 + py)
    roi = gray[Y0:Y1, X0:X1] < ink
    if roi.sum() < 6:
        return None
    cols = roi.any(axis=0)
    if not split:      # line styles (dashes) must stay in one piece
        rows = np.where(roi.any(axis=1))[0]
        xs = np.where(cols)[0]
        gx0, gx1, gy0, gy1 = X0 + xs.min(), X0 + xs.max() + 1, Y0 + rows.min(), Y0 + rows.max() + 1
        p = 2
        return int(max(0, gx0 - p)), int(max(0, gy0 - p)), int(min(W, gx1 + p) - max(0, gx0 - p)), int(min(H, gy1 + p) - max(0, gy0 - p))
    gap = max(5, int(0.35 * roi.shape[0]))          # a blank run this wide separates symbol from text
    groups, start, blank = [], None, 0
    for i, on in enumerate(cols):
        if on:
            if start is None:
                start = i
            blank, last = 0, i
        elif start is not None:
            blank += 1
            if blank >= gap:
                groups.append((start, last)); start = None
    if start is not None:
        groups.append((start, last))
    if not groups:
        return None
    cx = (x0 + x1) / 2 - X0
    best = min(groups, key=lambda g: 0 if g[0] <= cx <= g[1] else min(abs(g[0] - cx), abs(g[1] - cx)))
    sub = roi[:, best[0]:best[1] + 1]
    rows = np.where(sub.any(axis=1))[0]
    gx0, gx1 = X0 + best[0], X0 + best[1] + 1
    gy0, gy1 = Y0 + rows.min(), Y0 + rows.max() + 1
    p = 3
    gx0, gy0, gx1, gy1 = max(0, gx0 - p), max(0, gy0 - p), min(W, gx1 + p), min(H, gy1 + p)
    if gx1 - gx0 < 8 or gy1 - gy0 < 8:
        return None
    return int(gx0), int(gy0), int(gx1 - gx0), int(gy1 - gy0)


PALETTE = ["#bc6c25", "#606c38", "#5e60ce", "#d00000", "#0077b6", "#7209b7", "#ff006e", "#3a86ff",
           "#06d6a0", "#fb5607", "#8d99ae", "#588157", "#9b5de5", "#f15bb5", "#00bbf9", "#ad2e24"]


LINE_WORDS = re.compile(r"control|connection|wire|wiring|circuit|conduit|home ?run|dash|cable|travel", re.I)


def _looks_dashed(gray, box):
    """A wide, short crop made of 3+ similar small strokes in a row is a dashed line, not a device."""
    try:
        x, y, w, h = [int(v) for v in box]   # snap_to_symbol returns x, y, width, height
        crop = gray[max(0, y):y + h, max(0, x):x + w] < 170
        if crop.size == 0 or crop.shape[0] < 2 or crop.shape[1] < 2.5 * crop.shape[0]:
            return False
    except Exception:
        return False
    n, _, st, _ = cv2.connectedComponentsWithStats(crop.astype("uint8"), connectivity=8)
    comps = [st[i] for i in range(1, n) if st[i][4] >= 3]
    if len(comps) < 3:
        return False
    w = np.array([c[2] for c in comps], dtype=float)
    return float(w.std() / (w.mean() + 1e-6)) < 0.5


def _slug(name, taken):
    base = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:24] or "symbol"
    sid, n = base, 2
    while sid in taken:
        sid, n = f"{base}_{n}", n + 1
    return sid


def extract_legend(plan_img: Image.Image, known: list, api_key: str, model: str):
    """Read EVERY entry of the plan's own legend.

    Returns {"region": [x,y,w,h] | None,
             "symbols": [symbol dicts for this plan, in legend order],
             "boxes": {symbol_id: [x,y,w,h]},      # where each crop was cut
             "notes": [str]}
    Entries the model maps to one of our known types keep that type's tuned settings and materials;
    everything else becomes a custom symbol named after its printed legend text.
    """
    W, H = plan_img.size
    gray_full = np.array(plan_img.convert("L"))
    notes = []

    # 1. where is the legend?
    small, _ = _fit(plan_img, 1600)
    r1 = _call(api_key, model,
               "This is an electrical floor plan. Find the LEGEND / SYMBOL LIST: the block that lists the electrical "
               "symbols next to their names (often titled LEGEND or SYMBOLS, usually in a margin or corner). "
               "Return found=true and its bounding box as [x0, y0, x1, y1] on a 0-1000 grid "
               "(0,0 = top-left of the image, 1000,1000 = bottom-right). Include the whole list. If there is none, found=false.",
               small,
               {"type": "object", "properties": {"found": {"type": "boolean"}, "box": BOX},
                "required": ["found", "box"], "additionalProperties": False})
    if not r1.get("found"):
        return {"region": None, "symbols": [], "boxes": {}, "notes": ["No legend found on the page."]}
    rx0, ry0, rx1, ry1 = _clamp_box(r1["box"], W, H)
    pad_x, pad_y = int(0.02 * W), int(0.02 * H)
    rx0, ry0, rx1, ry1 = max(0, rx0 - pad_x), max(0, ry0 - pad_y), min(W, rx1 + pad_x), min(H, ry1 + pad_y)
    if rx1 - rx0 < 40 or ry1 - ry0 < 40:
        return {"region": None, "symbols": [], "boxes": {}, "notes": ["Legend box came back too small."]}
    region = plan_img.crop((rx0, ry0, rx1, ry1))

    # 2. list every legend row with a box around its drawn symbol
    zoom, k = _fit(region, 1800, allow_up=3.0)
    zw, zh = zoom.size
    kinds = [s["id"] for s in known]
    lines = "\n".join(f'- "{s["id"]}": {s["legend_label"]}. {s["description"]}' for s in known)
    schema = {"type": "object", "properties": {"items": {"type": "array", "maxItems": 60, "items": {
        "type": "object",
        "properties": {"name": {"type": "string"}, "kind": {"type": "string", "enum": kinds + ["other"]},
                       "shape": {"type": "string", "enum": ["symbol", "line"]}, "box": BOX},
        "required": ["name", "kind", "shape", "box"], "additionalProperties": False}}},
        "required": ["items"], "additionalProperties": False}
    r2 = _call(api_key, model,
               "This is the legend of an electrical plan. List EVERY symbol entry in it, top to bottom, one item per legend row "
               "that has a drawn symbol. For each item give: name = the printed text next to it, copied exactly; "
               "box = tight bounding box of the drawn SYMBOL GRAPHIC only (not the text), as [x0, y0, x1, y1] on a 0-1000 grid "
               "over this image; kind = the id from the list below that is the SAME kind of device, or \"other\" if none fits "
               "(be strict: GFCI/AFCI/duplex are different kinds even though they look alike); "
               "shape = \"line\" when the entry is a LINE STYLE (a dashed or solid wire/circuit run) and \"symbol\" for a device.\nKnown kinds:\n" + lines,
               zoom, schema)

    by_id = {s["id"]: s for s in known}
    taken, used_kinds, symbols, boxes = set(kinds), set(), [], {}
    taken_new = set()
    for n, it in enumerate(r2.get("items", [])):
        name = (it.get("name") or "").strip() or f"Symbol {n + 1}"
        bx0, by0, bx1, by1 = _clamp_box(it["box"], zw, zh)
        box = (rx0 + int(bx0 / k), ry0 + int(by0 / k), rx0 + int(bx1 / k), ry0 + int(by1 / k))
        is_line = it.get("shape") == "line" or bool(LINE_WORDS.search(name))
        snapped = snap_to_symbol(gray_full, box, split=not is_line, pad_frac=0.04 if is_line else 0.12)
        if snapped is not None and not is_line and _looks_dashed(gray_full, snapped):
            is_line = True
        if snapped is None:
            notes.append(f'"{name}": nothing drawn where the model pointed')
            continue
        kind = it.get("kind")
        if is_line:
            sid = _slug(name, taken | taken_new)
            taken_new.add(sid)
            sym = {"id": sid, "label": name.title() if name.isupper() else name, "legend_label": name,
                   "color": "#f59e0b", "rotations": [0], "line": True, "custom": True,
                   "description": f'line style "{name}" (a wire run, traced instead of counted)', "hints": [],
                   "materials": [["14/2 NM-B cable", 1]]}
        elif kind in by_id and kind not in used_kinds:
            sym = dict(by_id[kind])
            sym["legend_label"] = name
            used_kinds.add(kind)
        else:
            sid = _slug(name, taken | taken_new)
            taken_new.add(sid)
            sym = {"id": sid, "label": name.title() if name.isupper() else name, "legend_label": name,
                   "color": PALETTE[len(symbols) % len(PALETTE)], "rotations": [0],
                   "description": f'symbol labelled "{name}" in the legend', "hints": [],
                   "materials": [[name.title() if name.isupper() else name, 1]], "custom": True}
        symbols.append(sym)
        boxes[sym["id"]] = list(snapped)
    if not symbols:
        notes.append("The legend was found but no symbols could be cut out of it.")
    return {"region": [rx0, ry0, rx1 - rx0, ry1 - ry0], "symbols": symbols, "boxes": boxes, "notes": notes}