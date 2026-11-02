"""Count-level evaluation of the pipeline against YOUR hand counts.

    python eval/run_eval.py                      # every samples/*/ground_truth.json, template mode
    python eval/run_eval.py --vlm                # also verify hits with the Meta VLM (needs MODEL_API_KEY)
    python eval/run_eval.py --plans my_plans --threshold 0.72

Each plan folder looks like samples/plan_01:
    plan.png|jpg            the drawing
    legend/<symbol_id>.png  one crop per legend symbol (same ids as backend/symbols.json)
    meta.json               optional: {"exclude": [[x, y, w, h]]}  (title block / legend area)
    ground_truth.json       {"counts": {"duplex": 12, "switch": 7, ...}}   <- you hand-count this

This measures COUNT error (the number an estimator actually uses). It cannot tell you whether a
box sits on the right symbol; for that, add box-level ground truth later.
"""
import argparse
import csv
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from PIL import Image  # noqa: E402
from pipeline.run import load_symbols, run_plan  # noqa: E402


def find_plans(base: Path):
    for d in sorted(p for p in base.iterdir() if p.is_dir()):
        img = next((p for p in d.glob("plan.*") if p.suffix.lower() in (".png", ".jpg", ".jpeg")), None)
        if img:
            yield d, img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plans", default=str(ROOT / "samples"))
    ap.add_argument("--threshold", type=float, default=0.7)
    ap.add_argument("--vlm", action="store_true")
    ap.add_argument("--model", default=os.environ.get("MODEL_NAME", "muse-wonder-1.0"))
    ap.add_argument("--out", default=str(ROOT / "eval" / "results"))
    args = ap.parse_args()

    ids = [s["id"] for s in load_symbols()]
    rows, per_plan = [], []
    for d, img_path in find_plans(Path(args.plans)):
        gt_path = d / "ground_truth.json"
        if not gt_path.exists():
            print(f"skip {d.name}: no ground_truth.json (hand-count it; see eval/ground_truth.template.json)")
            continue
        truth = json.loads(gt_path.read_text())["counts"]
        meta = json.loads((d / "meta.json").read_text()) if (d / "meta.json").exists() else {}
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            Image.open(img_path).convert("RGB").save(tmp / "plan.png")
            shutil.copytree(d / "legend", tmp / "legend")
            res = run_plan(tmp, exclude=meta.get("exclude", []), threshold=args.threshold,
                           use_vlm=args.vlm, api_key=os.environ.get("MODEL_API_KEY"), model=args.model)
        got = res["totals"]
        abs_err = 0
        for sid in ids:
            t, g = int(truth.get(sid, 0)), int(got.get(sid, 0))
            abs_err += abs(g - t)
            rows.append({"plan": d.name, "symbol": sid, "truth": t, "predicted": g, "error": g - t})
        n_truth = sum(int(truth.get(s, 0)) for s in ids)
        per_plan.append({"plan": d.name, "truth_total": n_truth, "abs_error_total": abs_err,
                         "exact_types": sum(int(truth.get(s, 0)) == int(got.get(s, 0)) for s in ids),
                         "seconds": res["meta"]["seconds"], "vlm": res["meta"].get("vlm", {})})
        print(f"\n{d.name}  ({res['meta']['mode']}, {res['meta']['seconds']}s)")
        print(f"  {'symbol':<15}{'truth':>6}{'got':>6}{'err':>6}")
        for r in rows:
            if r["plan"] == d.name and (r["truth"] or r["predicted"]):
                print(f"  {r['symbol']:<15}{r['truth']:>6}{r['predicted']:>6}{r['error']:>+6}")

    if not per_plan:
        sys.exit("No plans with ground truth found.")
    tot_t = sum(p["truth_total"] for p in per_plan)
    tot_e = sum(p["abs_error_total"] for p in per_plan)
    print("\n== summary ==")
    print(f"plans: {len(per_plan)}   total symbols (truth): {tot_t}   total absolute count error: {tot_e}"
          f"   error rate: {tot_e / max(tot_t, 1):.1%}")
    print(f"symbol types counted exactly right: {sum(p['exact_types'] for p in per_plan)}/{len(per_plan) * len(ids)}")

    out = Path(args.out); out.parent.mkdir(parents=True, exist_ok=True)
    with open(f"{out}.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    Path(f"{out}.json").write_text(json.dumps({"args": vars(args), "per_plan": per_plan}, indent=2))
    print(f"saved {out}.csv and {out}.json")


if __name__ == "__main__":
    main()
