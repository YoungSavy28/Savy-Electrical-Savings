"""Stage 2: deterministic checks in code (the model never decides these).

- NMS / dedupe overlapping candidates, remembering close runner-up labels
- OCR rule: a circle-with-ticks is RECESSED only if "RCLT" is printed beneath it
- OCR rule: a lone "S" inside a printed word (room names etc.) is text, not a switch
- flags for low confidence and ambiguous pairs (e.g. dimmer vs door bell)
"""
import cv2
import numpy as np


def _iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    return inter / float(aw * ah + bw * bh - inter + 1e-9)


def _center_in(a, b):
    cx, cy = a[0] + a[2] / 2, a[1] + a[3] / 2
    return b[0] <= cx <= b[0] + b[2] and b[1] <= cy <= b[1] + b[3]


def nms(cands, iou_thr=0.2):
    keep = []
    for c in sorted(cands, key=lambda c: -c["score"]):
        dup = None
        for k in keep:
            if _iou(c["bbox"], k["bbox"]) > iou_thr or _center_in(c["bbox"], k["bbox"]) or _center_in(k["bbox"], c["bbox"]):
                dup = k
                break
        if dup is None:
            c["alts"] = []
            keep.append(c)
        elif dup["label"] != c["label"]:
            dup["alts"].append({"label": c["label"], "score": round(c["score"], 3)})
    return keep


def ocr_available():
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


def _word_boxes(gray):
    import pytesseract
    d = pytesseract.image_to_data(gray, config="--psm 11", output_type=pytesseract.Output.DICT)
    words = []
    for i, txt in enumerate(d["text"]):
        txt = (txt or "").strip()
        try:
            conf = float(d["conf"][i])
        except Exception:
            conf = -1
        if len(txt) >= 3 and conf >= 60 and sum(ch.isalpha() for ch in txt) >= 3:
            words.append((d["left"][i], d["top"][i], d["width"][i], d["height"][i], txt))
    return words


def _has_rclt(gray, bbox):
    """True if 'RCLT' is printed beneath the symbol. Tries two preprocessings; OCR on tiny text is flaky."""
    import pytesseract
    x, y, w, h = bbox
    y0, y1 = int(y + 0.5 * h), min(gray.shape[0], y + h + 30)
    x0, x1 = max(0, x - 14), min(gray.shape[1], x + w + 14)
    roi = gray[y0:y1, x0:x1]
    if roi.size == 0:
        return False
    roi = cv2.resize(roi, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    _, binar = cv2.threshold(roi, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    for img, psm in ((roi, 7), (binar, 7), (binar, 6)):
        txt = pytesseract.image_to_string(img, config=f"--psm {psm} -c tessedit_char_whitelist=RCLT").upper()
        if "RCL" in txt or "CLT" in txt or len(set(txt) & set("RCLT")) >= 3:
            return True
    return False


# Symbols whose drawing itself contains letters (SA, WH, HPU, GFCI...). Everything else is a pure
# shape, so a hit sitting in a row of letters or on a printed word is text, not an icon.
LETTERED = {"hpu", "water_heater", "smoke_alarm", "gfci", "afci", "pendant"}
SHAPE_ONLY = {"ceiling_light", "recessed", "fan", "duplex", "telephone", "switch", "dimmer", "doorbell",
              "wall_light", "panel", "exhaust_fan"}   # custom (per-plan) symbols are never auto-removed as text
TEXT_PRONE = ("switch", "dimmer", "doorbell")   # look like letters; OCR word check applies only to these


def text_row_suppress(gray, cands, log, labels=None):
    """OCR-free text filter. A hit whose neighbours are letter-sized ink blobs on the same baseline
    (a blob on both sides, or two on one side) is a letter in a word, not a symbol."""
    labels = labels or ({c["label"] for c in cands} & SHAPE_ONLY)
    todo = [c for c in cands if c["label"] in labels]
    if not todo:
        return cands, []
    binar = (gray < 170).astype("uint8")
    n, _, st, cen = cv2.connectedComponentsWithStats(binar, connectivity=8)
    comps = [(st[i][0], st[i][1], st[i][2], st[i][3], cen[i][1]) for i in range(1, n) if st[i][4] >= 6]
    kept, rejected = [], []
    for c in cands:
        if c["label"] not in labels:
            kept.append(c)
            continue
        x, y, w, h = c["bbox"]
        cx, cy = x + w / 2, y + h / 2
        left = right = 0
        for (bx, by, bw, bh, bcy) in comps:
            if bx < x + w and bx + bw > x and by < y + h and by + bh > y:
                continue   # overlaps the candidate itself
            if not (0.45 * h <= bh <= 2.0 * h and bw <= 2.2 * h and abs(bcy - cy) <= 0.6 * h):
                continue
            if x - 0.9 * h <= bx + bw <= x + 2 and bx < x:
                left += 1
            elif x + w - 2 <= bx <= x + w + 0.9 * h:
                right += 1
        if (left >= 1 and right >= 1) or left >= 2 or right >= 2:
            c["reject_reason"] = "looks like a letter inside printed text"
            rejected.append(c)
        else:
            kept.append(c)
    if rejected:
        log.append(f"text filter removed {len(rejected)} hits that sit in text rows")
    return kept, rejected


def apply_rules(gray, cands, log):
    """Mutates cands (adds flags / relabels) and returns (kept, rejected)."""
    rejected = []
    for c in cands:
        c.setdefault("flags", [])
    cands, rej0 = text_row_suppress(gray, cands, log)
    rejected.extend(rej0)
    if not ocr_available():
        log.append("OCR unavailable (tesseract not installed): RCLT rule and word-level text check skipped")
        return cands, rejected

    # 1. 'S' hits that sit inside printed words are text
    if any(c["label"] in TEXT_PRONE for c in cands):
        words = _word_boxes(gray)
        kept = []
        for c in cands:
            if c["label"] in TEXT_PRONE:
                cx, cy = c["bbox"][0] + c["bbox"][2] / 2, c["bbox"][1] + c["bbox"][3] / 2
                hit = next((w for w in words if w[0] - 4 <= cx <= w[0] + w[2] + 4 and w[1] - 4 <= cy <= w[1] + w[3] + 4
                           and w[2] >= 2.5 * c["bbox"][2]), None)
                if hit:
                    c["reject_reason"] = f'inside printed word "{hit[4]}"'
                    rejected.append(c)
                    continue
            kept.append(c)
        cands = kept

    # 2. RCLT text decides recessed vs ceiling light.
    #    OCR may CONFIRM recessed, but a failed read never overrides a template that already said recessed.
    for c in cands:
        if c["label"] in ("ceiling_light", "recessed"):
            found = _has_rclt(gray, c["bbox"])
            if found and c["label"] != "recessed":
                c["flags"].append("rule: RCLT text found -> recessed")
                c["label"] = "recessed"
            elif not found and c["label"] == "recessed":
                c["flags"].append("RCLT text not confirmed by OCR")
    return cands, rejected


def add_flags(cands, low_conf=0.72, amb_margin=0.05):
    for c in cands:
        c.setdefault("flags", [])
        if c["confidence"] < low_conf:
            c["flags"].append(f'low confidence ({c["confidence"]:.2f})')
        for a in c.get("alts", []):
            if a["score"] >= c["score"] - amb_margin:
                c["flags"].append(f'ambiguous: also looks like {a["label"]} ({a["score"]:.2f} vs {c["score"]:.2f})')
                break
    return cands
