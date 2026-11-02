"""Stage 1: propose candidate symbols.

Symbols differ from drawing to drawing, so the plan's OWN legend crops are used as
templates (multi-scale, optional rotations). This is deterministic, free, and gives
high recall; the later stages (OCR rules, optional VLM) fix precision.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

SCALES = tuple(round(x, 2) for x in np.arange(0.7, 1.76, 0.1))
INK = 170  # pixels darker than this count as ink
BLUR = 1.5  # gaussian sigma applied to plan AND template: thin lines tolerate 1px misalignment


def tight_crop(gray: np.ndarray, pad: int = 3) -> np.ndarray:
    ys, xs = np.where(gray < INK)
    if len(xs) == 0:
        return gray
    y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad + 1, gray.shape[0])
    x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad + 1, gray.shape[1])
    return gray[y0:y1, x0:x1]


def load_templates(legend_dir: Path, symbols: list) -> list:
    out = []
    for s in symbols:
        if s.get("line"):
            continue   # line styles (wire runs) are traced by wires.py, not template-matched
        p = Path(legend_dir) / f"{s['id']}.png"
        if not p.exists():
            continue
        g = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
        if g is None:
            continue
        g = tight_crop(g)
        for rot in s.get("rotations", [0]):
            out.append({"id": s["id"], "rot": rot, "img": np.ascontiguousarray(np.rot90(g, rot // 90))})
    return out


def _match_one(gray_b, ink, mask_ex, t, sx, sy, thr, max_ink):
    H, W = gray_b.shape
    tpl = cv2.resize(t["img"], None, fx=sx, fy=sy, interpolation=cv2.INTER_AREA)
    th, tw = tpl.shape
    if th < 12 or tw < 12 or th >= H or tw >= W:
        return []
    tink = float((tpl < INK).sum())
    tpl = cv2.GaussianBlur(tpl, (0, 0), BLUR)
    res = cv2.matchTemplate(gray_b, tpl, cv2.TM_CCOEFF_NORMED)
    res = np.nan_to_num(res, nan=0.0, posinf=0.0, neginf=0.0)
    # Window must contain a plausible amount of ink (kills flat-white and solid-black artefacts).
    win = cv2.boxFilter(ink, -1, (tw, th), normalize=False, anchor=(0, 0))[: H - th + 1, : W - tw + 1]
    res[(win < 0.5 * tink) | (win > max_ink * tink)] = 0.0
    k = max(3, int(min(tw, th) * 0.5)) | 1
    dil = cv2.dilate(res, np.ones((k, k), np.uint8))
    ys, xs = np.where((res >= thr) & (res >= dil - 1e-6))
    out = []
    for y, x in zip(ys, xs):
        cx, cy = x + tw // 2, y + th // 2
        if mask_ex[cy, cx]:
            continue
        out.append({"label": t["id"], "score": float(res[y, x]), "bbox": [int(x), int(y), int(tw), int(th)],
                    "scale": [round(sx, 2), round(sy, 2)], "rot": t["rot"]})
    out.sort(key=lambda c: -c["score"])
    return out[:400]


ANISO = tuple(round(x, 2) for x in np.arange(0.75, 1.16, 0.1))
ANISO_Y = tuple(round(x, 2) for x in np.arange(0.7, 1.11, 0.1))


def propose(gray, templates, exclude=(), threshold=0.7, scales=SCALES, workers=4, opts=None):
    """opts: {symbol_id: {threshold_offset, max_ink_ratio, aniso}} per-symbol tuning.
    threshold_offset: solid/tiny shapes need a stricter cut.
    max_ink_ratio:    reject windows far inkier than the template (thick walls).
    aniso:            let width and height scale independently (box-style symbols)."""
    opts = opts or {}
    H, W = gray.shape
    ink = (gray < INK).astype(np.float32)
    gray_b = cv2.GaussianBlur(gray, (0, 0), BLUR)
    mask_ex = np.zeros((H, W), np.uint8)
    for x, y, w, h in exclude:
        mask_ex[max(int(y), 0): int(y + h), max(int(x), 0): int(x + w)] = 1
    jobs = []
    for t in templates:
        o = opts.get(t["id"], {})
        thr = threshold + o.get("threshold_offset", 0.0)
        mi = o.get("max_ink_ratio", 3.0)
        if o.get("aniso"):
            jobs += [(t, sx, sy, thr, mi) for sx in ANISO for sy in ANISO_Y]
        else:
            jobs += [(t, sc, sc, thr, mi) for sc in scales]
    with ThreadPoolExecutor(workers) as ex:
        parts = list(ex.map(lambda j: _match_one(gray_b, ink, mask_ex, j[0], j[1], j[2], j[3], j[4]), jobs))
    return [c for p in parts for c in p]
