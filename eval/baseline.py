"""Baseline: ask a VLM to count everything from the whole drawing in ONE prompt.

This is the lazy approach your pipeline has to beat. Run it several times: if the counts change
from run to run, that variance alone is an argument for the pipeline.

    export MODEL_API_KEY=...
    python eval/baseline.py samples/plan_01 --runs 3

Reads <plan folder>/ground_truth.json if present and prints the error against it.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from PIL import Image  # noqa: E402
from pipeline import vlm  # noqa: E402
from pipeline.run import load_symbols  # noqa: E402

PROMPT = (
    "This is an electrical floor plan with a legend. Count every electrical symbol in the plan area "
    "(NOT the legend or title block) by type, using the legend to tell the symbols apart. "
    "Symbol types: {types}. Return only JSON with one integer count per type."
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("plan_dir")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--model", default=os.environ.get("MODEL_NAME", "muse-wonder-1.0"))
    ap.add_argument("--max-side", type=int, default=2400, help="downscale long side before sending")
    args = ap.parse_args()
    key = os.environ.get("MODEL_API_KEY")
    if not key:
        sys.exit("Set MODEL_API_KEY first.")

    d = Path(args.plan_dir)
    img_path = next(p for p in d.glob("plan.*") if p.suffix.lower() in (".png", ".jpg", ".jpeg"))
    img = Image.open(img_path).convert("RGB")
    if max(img.size) > args.max_side:
        k = args.max_side / max(img.size)
        img = img.resize((int(img.width * k), int(img.height * k)), Image.LANCZOS)

    syms = load_symbols()
    types = ", ".join(f'{s["id"]} ({s["legend_label"]})' for s in syms)
    schema = {"type": "object", "properties": {s["id"]: {"type": "integer"} for s in syms},
              "required": [s["id"] for s in syms], "additionalProperties": False}
    content = [{"type": "text", "text": PROMPT.format(types=types)},
               {"type": "image_url", "image_url": {"url": vlm._data_url_from_pil(img)}}]
    truth = json.loads((d / "ground_truth.json").read_text())["counts"] if (d / "ground_truth.json").exists() else None

    runs = []
    for i in range(args.runs):
        t0 = time.time()
        data = vlm.ask_model(key, args.model, content, schema)
        counts = json.loads(data["choices"][0]["message"]["content"])
        runs.append(counts)
        u = data.get("usage", {})
        err = sum(abs(counts.get(s["id"], 0) - int(truth.get(s["id"], 0))) for s in syms) if truth else None
        print(f"run {i + 1}: {round(time.time() - t0, 1)}s  tokens {u.get('prompt_tokens', 0)}/{u.get('completion_tokens', 0)}"
              f"  abs error vs truth: {err}\n   {counts}")

    spread = {s["id"]: max(r.get(s["id"], 0) for r in runs) - min(r.get(s["id"], 0) for r in runs) for s in syms}
    print("\nrun-to-run spread (max - min) per type:", {k: v for k, v in spread.items() if v})
    if all(v == 0 for v in spread.values()):
        print("(identical every run; the baseline is at least stable on this plan)")


if __name__ == "__main__":
    main()
