"""Orchestrates detect -> rules -> (optional VLM) -> flags -> result dict."""
import json
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from . import detect, verify, vlm, wires

SYMBOLS_PATH = Path(__file__).resolve().parent.parent / "symbols.json"


def load_symbols(plan_dir=None):
    """Global symbol list, or this plan's own list if auto-legend wrote plan_dir/symbols.json."""
    if plan_dir is not None and (Path(plan_dir) / "symbols.json").exists():
        return json.loads((Path(plan_dir) / "symbols.json").read_text())["symbols"]
    return json.loads(SYMBOLS_PATH.read_text())["symbols"]


def totals_of(dets):
    t = {}
    for d in dets:
        if d.get("status") != "deleted":
            t[d["label"]] = t.get(d["label"], 0) + 1
    return t


def run_plan(plan_dir: Path, exclude=(), threshold=0.7, use_vlm=False, api_key=None, model="muse-wonder-1.0"):
    t0 = time.time()
    plan_dir = Path(plan_dir)
    symbols = load_symbols(plan_dir)
    by_id = {s["id"]: s for s in symbols}
    legend_dir = plan_dir / "legend"
    log = []

    gray = cv2.imread(str(plan_dir / "plan.png"), cv2.IMREAD_GRAYSCALE)
    H, W = gray.shape
    templates = detect.load_templates(legend_dir, symbols)
    if not templates:
        raise ValueError("No legend reference crops yet. Draw a box around each legend symbol first.")

    opts = {s["id"]: {k: s[k] for k in ("threshold_offset", "max_ink_ratio", "aniso") if k in s} for s in symbols}
    raw = detect.propose(gray, templates, exclude=exclude, threshold=threshold, opts=opts)
    cands = verify.nms(raw)
    n_after_nms = len(cands)
    for c in cands:
        c["confidence"] = round(c["score"], 3)
        c["source"] = "template"
        c["flags"] = []

    # A symbol that is the same drawing plus extra marks (e.g. duplex vs GFCI = duplex + a "G") always scores
    # high on the plain template too. When the bigger template also matches about as well, the extra marks are there.
    area = {t["id"]: t["img"].shape[0] * t["img"].shape[1] for t in templates}
    for c in cands:
        if by_id.get(c["label"], {}).get("aniso"):
            continue   # box symbols are matched with stretched templates, so template size says nothing there
        better = [a for a in c.get("alts", []) if area.get(a["label"], 0) > 1.15 * area.get(c["label"], 1)
                  and a["score"] >= c["score"] - 0.06 and not by_id.get(a["label"], {}).get("aniso")]
        if better:
            a = max(better, key=lambda a: a["score"])
            c["alts"].append({"label": c["label"], "score": round(c["score"], 3)})
            c["alts"] = [x for x in c["alts"] if x is not a]
            c["label"], c["score"] = a["label"], a["score"]
            c["confidence"] = round(c["score"], 3)
    cands, rejected = verify.apply_rules(gray, cands, log)
    stats = {}

    if use_vlm:
        if not api_key:
            raise ValueError("VLM verification requested but MODEL_API_KEY is not set on the server.")
        refs = [(by_id[t["id"]], legend_dir / f'{t["id"]}.png') for t in {t["id"]: t for t in templates}.values()]
        plan_img = Image.open(plan_dir / "plan.png").convert("RGB")
        results, stats = vlm.classify_all(plan_img, cands, refs, api_key, model)
        kept = []
        for c, r in zip(cands, results):
            if "error" in r:
                c["flags"].append("vlm error: " + r["error"][:80])
                kept.append(c)
                continue
            c["reason"] = r["reason"]
            if r["id"] == "none":
                c["reject_reason"] = "vlm: not an electrical symbol (" + r["reason"] + ")"
                rejected.append(c)
                continue
            if r["id"] != c["label"]:
                c["flags"].append(f'vlm says {r["id"]}; template said {c["label"]}')
                if r["confidence"] >= c["confidence"]:
                    c["label"], c["confidence"], c["source"] = r["id"], round(r["confidence"], 3), "vlm"
            else:
                c["confidence"] = round(max(c["confidence"], r["confidence"]), 3)
            kept.append(c)
        cands = kept

    verify.add_flags(cands)
    cands.sort(key=lambda c: (c["bbox"][1] // 100, c["bbox"][0]))

    def pack(c, i, prefix):
        return {"id": f"{prefix}{i + 1}", "bbox": c["bbox"], "label": c["label"], "confidence": c["confidence"],
                "status": "auto", "flags": c.get("flags", []), "source": c.get("source", "template"),
                "reason": c.get("reason") or c.get("reject_reason", "")}

    dets = [pack(c, i, "d") for i, c in enumerate(cands)]
    rej = []
    for i, c in enumerate(rejected):
        c.setdefault("confidence", round(c["score"], 3))
        rej.append(pack(c, i, "r"))

    runs = []
    color = None
    for sym in symbols:
        crop_path = legend_dir / f'{sym["id"]}.png'
        if sym.get("line") and crop_path.exists():
            color = cv2.imread(str(plan_dir / "plan.png"), cv2.IMREAD_COLOR) if color is None else color
            try:
                runs += wires.trace(color, cv2.imread(str(crop_path), cv2.IMREAD_COLOR), sym["id"], dets, exclude,
                                    id_prefix=f"w{len(runs) + 1}_")
            except Exception as exc:   # never let wire tracing sink the symbol count
                log.append(f'wire tracing failed for {sym["label"]}: {exc}')
    # The legend sample may be missing or a poor crop (the model called the dashed entry a symbol, or cut it badly).
    # If nothing was traced, learn the dashed style from the plan itself and trace with that.
    new_symbols = None
    if not runs:
        try:
            color = cv2.imread(str(plan_dir / "plan.png"), cv2.IMREAD_COLOR) if color is None else color
            style = wires.infer_style(color, dets, exclude)
            if style is not None:
                line_sym = next((s for s in symbols if s.get("line")), None)
                lid = line_sym["id"] if line_sym else "switch_control"
                got = wires.trace(color, None, lid, dets, exclude, stats=style)
                if got:
                    runs = got
                    log.append("dashed wire style was learned from the plan itself (legend sample not usable)")
                    if line_sym is None:
                        new_sym = {"id": lid, "label": "Switch control connection", "legend_label": "Switch control connection",
                                   "color": "#f59e0b", "rotations": [0], "line": True, "custom": True,
                                   "description": "dashed wire run found on the plan (traced instead of counted)", "hints": [],
                                   "materials": [["14/2 NM-B cable", 1]]}
                        symbols = symbols + [new_sym]
                        (plan_dir / "symbols.json").write_text(json.dumps({"symbols": symbols}, indent=1))
                        pts = np.array(max(runs, key=lambda r: r["length_px"])["points"])
                        cx, cy = pts.mean(axis=0).astype(int)
                        crop = color[max(0, cy - 14):cy + 14, max(0, cx - 40):cx + 40]
                        if crop.size:
                            legend_dir.mkdir(exist_ok=True)
                            cv2.imwrite(str(legend_dir / f"{lid}.png"), crop)
                        new_symbols = symbols
        except Exception as exc:
            log.append(f"wire style inference failed: {exc}")
    for i, r in enumerate(runs):
        r["id"] = f"w{i + 1}"

    return {
        "width": W, "height": H, "wires": runs, "symbols": new_symbols,
        "detections": dets, "rejected": rej, "totals": totals_of(dets),
        "meta": {"mode": "template+vlm" if use_vlm else "template", "threshold": threshold,
                 "candidates_after_nms": n_after_nms, "seconds": round(time.time() - t0, 1),
                 "vlm": stats, "log": log, "model": model if use_vlm else None},
    }
