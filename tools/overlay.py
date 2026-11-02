"""Debug helper: draw a result.json over its plan image.
Usage: python tools/overlay.py <plan.png> <result.json> <out.png> [--rejected]
"""
import json
import sys

from PIL import Image, ImageDraw

plan, result, out = sys.argv[1:4]
show_rej = "--rejected" in sys.argv
res = json.load(open(result))
im = Image.open(plan).convert("RGB")
d = ImageDraw.Draw(im)
for det in res["detections"]:
    x, y, w, h = det["bbox"]
    col = (220, 30, 30) if det["flags"] else (20, 140, 40)
    d.rectangle([x, y, x + w, y + h], outline=col, width=4)
    d.text((x, y - 14), f'{det["label"]} {det["confidence"]:.2f}', fill=col)
if show_rej:
    for det in res["rejected"]:
        x, y, w, h = det["bbox"]
        d.rectangle([x, y, x + w, y + h], outline=(150, 150, 150), width=3)
im.save(out)
