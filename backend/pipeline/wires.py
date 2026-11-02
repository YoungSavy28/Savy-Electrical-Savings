"""Trace dashed wire runs (e.g. "switch control connection") from the plan.

The legend's own sample of the line is the answer key: its colour, dash length and dash pitch say what to
look for on the plan. Dashes are found as small same-coloured blobs, chained by distance into runs, and each
run's two ends are attached to the nearest detected device.
"""
import heapq
import math

import cv2
import numpy as np


def _ink_color(crop):
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    m = g < 200
    if int(m.sum()) < 5:
        return None
    return crop[m].astype(np.float32).mean(axis=0)


def _components(mask, min_area=3):
    n, _, st, cen = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    out = []
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if a >= min_area:
            out.append({"x": int(x), "y": int(y), "w": int(w), "h": int(h), "area": int(a),
                        "cx": float(cen[i][0]), "cy": float(cen[i][1])})
    return out


def sample_stats(crop):
    """dash length, dash area, pitch (centre to centre) and ink colour from the legend crop."""
    col = _ink_color(crop)
    if col is None:
        return None
    dist = np.linalg.norm(crop.astype(np.float32) - col, axis=2)
    comps = _components(dist < 60, min_area=2)
    if len(comps) < 3:   # not a dashed sample (bad crop): caller falls back to learning the style from the plan
        return None
    lens = [max(c["w"], c["h"]) for c in comps]
    dash_len = float(np.median(lens))
    area = float(np.median([c["area"] for c in comps]))
    pts = sorted(((c["cx"], c["cy"]) for c in comps))
    gaps = [math.dist(a, b) for a, b in zip(pts, pts[1:])]
    pitch = float(np.median(gaps)) if gaps else 2.0 * dash_len
    return {"color": col, "dash_len": dash_len, "area": area, "pitch": max(pitch, dash_len * 1.2)}


def _rect_dist(px, py, b):
    x, y, w, h = b
    dx = max(x - px, 0, px - (x + w))
    dy = max(y - py, 0, py - (y + h))
    return math.hypot(dx, dy)


def _tree_path(pts, idxs):
    """Longest path (by length) through the minimum spanning tree of these points."""
    n = len(idxs)
    P = pts[idxs]
    adj = {i: [] for i in range(n)}
    seen = {0}
    heap = [(float(np.hypot(*(P[0] - P[j]))), 0, j) for j in range(1, n)]
    heapq.heapify(heap)
    while heap and len(seen) < n:
        d, i, j = heapq.heappop(heap)
        if j in seen:
            continue
        seen.add(j)
        adj[i].append((j, d)); adj[j].append((i, d))
        for k in range(n):
            if k not in seen:
                heapq.heappush(heap, (float(np.hypot(*(P[j] - P[k]))), j, k))

    def far(src):
        dist, prev, stack = {src: 0.0}, {src: None}, [src]
        while stack:
            u = stack.pop()
            for v, w in adj[u]:
                if v not in dist:
                    dist[v] = dist[u] + w; prev[v] = u; stack.append(v)
        t = max(dist, key=dist.get)
        return t, prev

    a, _ = far(0)
    b, prev = far(a)
    path, u = [], b
    while u is not None:
        path.append(u); u = prev[u]
    path.reverse()
    return [idxs[i] for i in path]


def trace(color_img, line_crop, label, detections, exclude=(), min_dashes=3, id_prefix="w", stats=None):
    """color_img: BGR plan. line_crop: BGR legend sample (or None when stats are given). detections: dicts with
    bbox/label/id/status. Tries the legend's sample first, then looser settings, so a poor crop still finds the dashes.
    Returns a list of runs [{id,label,points,length_px,dashes,from,to,flags}]."""
    st = stats if stats is not None else (sample_stats(line_crop) if line_crop is not None else None)
    if st is None:
        return []
    for cd, ar, ln, link, md in ((60, (0.3, 3.2), (0.45, 2.2), 1.9, min_dashes),
                                  (90, (0.15, 6.0), (0.35, 3.0), 2.4, min_dashes),
                                  (110, (0.1, 9.0), (0.3, 4.0), 2.8, 2)):
        runs = _trace_once(color_img, st, label, detections, exclude, md, id_prefix, cd, ar, ln, link)
        if runs:
            return runs
    return []


def infer_style(color_img, detections, exclude=()):
    """No usable legend sample: learn the dashed-line style from the plan itself. Looks for the colour that has
    many small same-sized strokes laid out in lines (coloured dashes); returns stats like sample_stats, or None."""
    hsv = cv2.cvtColor(color_img, cv2.COLOR_BGR2HSV)
    sat = (hsv[:, :, 1] > 90) & (hsv[:, :, 2] > 90)
    for x, y, w, h in exclude:
        sat[max(0, y):y + h, max(0, x):x + w] = False
    for d in detections:
        if d.get("status") == "deleted":
            continue
        x, y, w, h = d["bbox"]
        sat[max(0, y - 2):y + h + 2, max(0, x - 2):x + w + 2] = False
    best = None
    hue = hsv[:, :, 0]
    for h0 in range(0, 180, 12):
        m = sat & (((hue.astype(int) - h0) % 180) < 12)
        comps = [c for c in _components(m, min_area=4) if c["area"] <= 500 and 5 <= max(c["w"], c["h"]) <= 45]
        if len(comps) < 8:
            continue
        pts = np.array([[c["cx"], c["cy"]] for c in comps])
        lens = np.array([max(c["w"], c["h"]) for c in comps], dtype=float)
        L = float(np.median(lens))
        keep = [i for i, c in enumerate(comps) if 0.6 * L <= lens[i] <= 1.6 * L]
        if len(keep) < 8:
            continue
        P = pts[keep]
        nn = []
        for i in range(len(P)):
            d = np.hypot(P[:, 0] - P[i, 0], P[:, 1] - P[i, 1]); d[i] = 1e9
            nn.append(d.min())
        pitch = float(np.median(nn))
        if pitch > 4 * L:
            continue
        score = len(keep)
        if best is None or score > best[0]:
            col = color_img[m].astype(np.float32).mean(axis=0)
            best = (score, {"color": col, "dash_len": L, "area": float(np.median([comps[i]["area"] for i in keep])),
                            "pitch": max(pitch, L * 1.2)})
    return best[1] if best else None


def _trace_once(color_img, st, label, detections, exclude, min_dashes, id_prefix, cdist, area_rng, len_rng, link_k):
    dist = np.linalg.norm(color_img.astype(np.float32) - st["color"], axis=2)
    mask = dist < cdist
    H, W = mask.shape
    for x, y, w, h in exclude:
        mask[max(0, y):y + h, max(0, x):x + w] = False
    for d in detections:
        if d.get("status") == "deleted":
            continue
        x, y, w, h = d["bbox"]
        mask[max(0, y - 2):y + h + 2, max(0, x - 2):x + w + 2] = False

    L, A = st["dash_len"], st["area"]
    dashes = [c for c in _components(mask)
              if area_rng[0] * A <= c["area"] <= area_rng[1] * A and len_rng[0] * L <= max(c["w"], c["h"]) <= len_rng[1] * L]
    if len(dashes) < min_dashes:
        return []
    pts = np.array([[c["cx"], c["cy"]] for c in dashes], dtype=np.float32)

    # union-find on distance
    link = link_k * st["pitch"]
    parent = list(range(len(pts)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for i in range(len(pts)):
        d = np.hypot(pts[:, 0] - pts[i, 0], pts[:, 1] - pts[i, 1])
        for j in np.where(d <= link)[0]:
            if j > i:
                parent[find(int(j))] = find(i)
    groups = {}
    for i in range(len(pts)):
        groups.setdefault(find(i), []).append(i)

    devs = [d for d in detections if d.get("status") != "deleted"]
    reach = max(3.0 * st["pitch"], 14.0)
    runs = []
    for idxs in groups.values():
        if len(idxs) < min_dashes:
            continue
        path = _tree_path(pts, idxs)
        poly = pts[path]
        length = float(sum(np.hypot(*(poly[k + 1] - poly[k])) for k in range(len(poly) - 1))) + L
        ends = [poly[0], poly[-1]]
        cand = []
        for e in ends:
            near = [(_rect_dist(e[0], e[1], d["bbox"]), d) for d in devs]
            cand.append([t for t in near if t[0] <= reach])
        att = [None, None]
        # a switch in reach wins; the other end must be a DIFFERENT device (prefer a non-switch)
        sw_ends = [(min(t[0] for t in c if t[1]["label"] == "switch"), i) for i, c in enumerate(cand)
                   if any(t[1]["label"] == "switch" for t in c)]
        if sw_ends:
            _, si = min(sw_ends)
            sw = min((t for t in cand[si] if t[1]["label"] == "switch"), key=lambda t: t[0])[1]
            att[si] = sw
            other = [t for t in cand[1 - si] if t[1]["id"] != sw["id"]]
            non_sw = [t for t in other if t[1]["label"] != "switch"]
            pick = min(non_sw or other, key=lambda t: t[0], default=None)
            att[1 - si] = pick[1] if pick else None
        else:
            for i, c in enumerate(cand):
                if c:
                    att[i] = min(c, key=lambda t: t[0])[1]
            if att[0] is not None and att[1] is not None and att[0]["id"] == att[1]["id"]:
                att[1] = None
        flags = []
        if att[0] is None or att[1] is None:
            flags.append("one end is not attached to a device")
        # put a switch first when there is one
        if att[1] is not None and att[1]["label"] == "switch" and (att[0] is None or att[0]["label"] != "switch"):
            att.reverse(); poly = poly[::-1]
        # the wire really runs into the device: extend each attached end to the device's edge
        poly = [list(map(float, q)) for q in poly]
        for end, dev in ((0, att[0]), (-1, att[1])):
            if dev is None:
                continue
            bx, by, bw, bh = dev["bbox"]
            px, py = poly[end]
            qx, qy = min(max(px, bx), bx + bw), min(max(py, by), by + bh)
            length += math.hypot(qx - px, qy - py)
            if end == 0:
                poly.insert(0, [qx, qy])
            else:
                poly.append([qx, qy])
        poly = np.array(poly, dtype=np.float32)
        approx = cv2.approxPolyDP(poly.reshape(-1, 1, 2).astype(np.float32), 2.5, False).reshape(-1, 2)
        runs.append({"label": label, "points": [[int(round(x)), int(round(y))] for x, y in approx],
                     "length_px": round(length, 1), "dashes": len(idxs),
                     "from": att[0]["id"] if att[0] else None, "to": att[1]["id"] if att[1] else None,
                     "from_label": att[0]["label"] if att[0] else None, "to_label": att[1]["label"] if att[1] else None,
                     "flags": flags})
    runs.sort(key=lambda r: (r["points"][0][1] // 150, r["points"][0][0]))
    for i, r in enumerate(runs):
        r["id"] = f"{id_prefix}{i + 1}"
    return runs
