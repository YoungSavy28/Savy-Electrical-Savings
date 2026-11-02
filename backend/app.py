"""Takeoff API + static frontend.

    pip install -r requirements.txt
    export MODEL_API_KEY=...        # optional: enables the VLM verification pass
    python backend/app.py           # http://127.0.0.1:5000
"""
import io
import json
import os
import re
import shutil
import sys
import uuid
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import legend as legend_mod  # noqa: E402
from pipeline.run import load_symbols, run_plan  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def _load_env_file(path):
    """Tiny .env reader (no extra dependency). Real environment variables win over the file."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env_file(ROOT / ".env")
DATA = Path(os.environ.get("TAKEOFF_DATA", ROOT / "data"))
PLANS = DATA / "plans"
SAMPLES = ROOT / "samples"
PLANS.mkdir(parents=True, exist_ok=True)
MAX_SIDE = 4500

app = Flask(__name__, static_folder=str(ROOT / "frontend"), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 40 * 1024 * 1024


# ---------- helpers ----------
def plan_dir(pid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{8}", pid or ""):
        abort(404)
    d = PLANS / pid
    if not d.exists():
        abort(404)
    return d


def read_json(p: Path, default=None):
    return json.loads(p.read_text()) if p.exists() else default


def write_json(p: Path, obj):
    p.write_text(json.dumps(obj))


def new_plan(img: Image.Image, name: str, exclude=None, legend_src: Path = None) -> str:
    img = img.convert("RGB")
    if max(img.size) > MAX_SIDE:
        k = MAX_SIDE / max(img.size)
        img = img.resize((int(img.width * k), int(img.height * k)), Image.LANCZOS)
    pid = uuid.uuid4().hex[:8]
    d = PLANS / pid
    (d / "legend").mkdir(parents=True)
    img.save(d / "plan.png")
    if legend_src and legend_src.exists():
        for f in legend_src.glob("*.png"):
            shutil.copy(f, d / "legend" / f.name)
    write_json(d / "meta.json", {"name": name, "width": img.width, "height": img.height, "exclude": exclude or []})
    return pid


def plan_symbols(pid: str):
    return load_symbols(plan_dir(pid))


def payload(pid: str) -> dict:
    d = plan_dir(pid)
    meta = read_json(d / "meta.json", {})
    refs = sorted(p.stem for p in (d / "legend").glob("*.png"))
    return {
        "plan_id": pid, "name": meta.get("name", pid), "symbols": plan_symbols(pid),
        "image_url": f"/files/{pid}/plan.png",
        "width": meta["width"], "height": meta["height"],
        "exclude": meta.get("exclude", []), "legend_refs": refs, "scale": meta.get("scale"), "est": meta.get("est"),
        "reviewed": read_json(d / "reviewed.json"), "result": read_json(d / "result.json"),
    }


# ---------- pages & files ----------
@app.route("/")
def landing():
    return send_from_directory(app.static_folder, "landing.html")


@app.route("/app")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/files/<pid>/<path:rest>")
def files(pid, rest):
    return send_from_directory(plan_dir(pid), rest, max_age=0)


# ---------- api ----------
@app.route("/api/config")
def config():
    return jsonify({
        "hasKey": bool(os.environ.get("MODEL_API_KEY")),
        "model": os.environ.get("MODEL_NAME", "muse-wonder-1.0"),
        "symbols": load_symbols(),
        "samples": sorted(p.name for p in SAMPLES.iterdir() if p.is_dir()) if SAMPLES.exists() else [],
    })


def render_pdf(data: bytes) -> Image.Image:
    """First page at ~200 dpi. pypdfium2 ships its own renderer (pip only); poppler is the fallback."""
    try:
        import pypdfium2 as pdfium
    except ImportError:
        pdfium = None
    if pdfium is not None:
        pdf = pdfium.PdfDocument(data)
        try:
            return pdf[0].render(scale=200 / 72).to_pil().convert("RGB")
        finally:
            pdf.close()
    try:
        from pdf2image import convert_from_bytes
        return convert_from_bytes(data, dpi=200, first_page=1, last_page=1)[0]
    except Exception as exc:
        raise RuntimeError("PDF support is not installed. Run:  python -m pip install pypdfium2") from exc


@app.route("/api/plans", methods=["POST"])
def upload():
    f = request.files.get("file")
    if not f:
        return jsonify(error="No file uploaded"), 400
    data = f.read()
    name = f.filename or "plan"
    try:
        if name.lower().endswith(".pdf"):
            img = render_pdf(data)
        else:
            img = Image.open(io.BytesIO(data))
            img.load()
    except Exception as exc:
        return jsonify(error=f"Could not read that file: {exc}"), 400
    return jsonify(payload(new_plan(img, name)))


@app.route("/api/samples/<name>", methods=["POST"])
def load_sample(name):
    src = SAMPLES / re.sub(r"[^A-Za-z0-9_\-]", "", name)
    img_path = next((p for p in src.glob("plan.*") if p.suffix.lower() in (".png", ".jpg", ".jpeg")), None)
    if not img_path:
        return jsonify(error="Unknown sample"), 404
    meta = read_json(src / "meta.json", {})
    pid = new_plan(Image.open(img_path), meta.get("name", name), meta.get("exclude"), src / "legend")
    have = {p.stem for p in (src / "legend").glob("*.png")}
    write_json(plan_dir(pid) / "symbols.json", {"symbols": [s for s in load_symbols() if s["id"] in have]})
    return jsonify(payload(pid))


@app.route("/api/plans/<pid>")
def get_plan(pid):
    return jsonify(payload(pid))


@app.route("/api/plans/<pid>/legend", methods=["POST"])
def set_legend(pid):
    d = plan_dir(pid)
    body = request.get_json(force=True)
    sym = body.get("symbol")
    if sym not in {s["id"] for s in plan_symbols(pid)}:
        return jsonify(error="Unknown symbol id"), 400
    x, y, w, h = [int(v) for v in body["bbox"]]
    img = Image.open(d / "plan.png")
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(img.width, x + w), min(img.height, y + h)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return jsonify(error="That box is too small"), 400
    img.crop((x0, y0, x1, y1)).save(d / "legend" / f"{sym}.png")
    return jsonify(payload(pid))


@app.route("/api/plans/<pid>/auto_legend", methods=["POST"])
def auto_legend(pid):
    key = os.environ.get("MODEL_API_KEY")
    if not key:
        return jsonify(error="MODEL_API_KEY is not set on the server. Put it in the .env file and restart."), 400
    d = plan_dir(pid)
    img = Image.open(d / "plan.png").convert("RGB")
    model = (request.get_json(force=True, silent=True) or {}).get("model") or os.environ.get("MODEL_NAME", "muse-wonder-1.0")
    try:
        found = legend_mod.extract_legend(img, load_symbols(), key, model)
    except Exception as exc:  # network / API / bad JSON: tell the user, do not crash
        print("\n[legend] FAILED:", repr(exc), flush=True)
        return jsonify(error=f"Legend search failed: {exc}"), 502
    meta = read_json(d / "meta.json", {})
    if found["symbols"]:
        # this plan now has ITS OWN symbol list; replace the previous auto crops
        for old in (d / "legend").glob("*.png"):
            old.unlink()
        for sym in found["symbols"]:
            x, y, w, h = found["boxes"][sym["id"]]
            img.crop((x, y, x + w, y + h)).save(d / "legend" / f"{sym['id']}.png")
        write_json(d / "symbols.json", {"symbols": found["symbols"]})
    if found["region"]:
        rx, ry, rw, rh = found["region"]
        ex = meta.get("exclude", [])
        if not any(abs(e[0] - rx) < 20 and abs(e[1] - ry) < 20 for e in ex):
            ex.append([rx, ry, rw, rh])   # the legend itself must not be counted as devices
        meta["exclude"] = ex
        write_json(d / "meta.json", meta)
    out = payload(pid)
    out.update(auto={"count": len(found["symbols"]), "notes": found["notes"], "region": found["region"]})
    return jsonify(out)


@app.route("/api/plans/<pid>/legend/<sym>", methods=["DELETE"])
def delete_legend(pid, sym):
    d = plan_dir(pid)
    p = d / "legend" / f"{re.sub(r'[^a-z0-9_]', '', sym)}.png"
    if p.exists():
        p.unlink()
    return jsonify(payload(pid))


@app.route("/api/plans/<pid>/process", methods=["POST"])
def process(pid):
    d = plan_dir(pid)
    body = request.get_json(force=True, silent=True) or {}
    exclude = [[int(v) for v in b] for b in body.get("exclude", [])]
    meta = read_json(d / "meta.json", {})
    meta["exclude"] = exclude
    write_json(d / "meta.json", meta)
    try:
        res = run_plan(
            d, exclude=exclude, threshold=float(body.get("threshold", 0.7)),
            use_vlm=bool(body.get("use_vlm")), api_key=os.environ.get("MODEL_API_KEY"),
            model=body.get("model") or os.environ.get("MODEL_NAME", "muse-wonder-1.0"),
        )
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    res.update(plan_id=pid, image_url=f"/files/{pid}/plan.png", exclude=exclude)
    write_json(d / "result.json", res)
    (d / "reviewed.json").unlink(missing_ok=True)
    return jsonify(res)


@app.route("/api/plans/<pid>/price_lookup", methods=["POST"])
def price_lookup(pid):
    """Search the web for current prices of exactly the parts this plan needs; the Meta model reads them off the results."""
    key = os.environ.get("MODEL_API_KEY")
    if not key:
        return jsonify(error="MODEL_API_KEY is not set on the server. Put it in the .env file and restart."), 400
    body = request.get_json(force=True, silent=True) or {}
    items = [i for i in body.get("items", []) if i.get("item")][:40]
    if not items:
        return jsonify(error="No parts to price yet."), 400
    model = body.get("model") or os.environ.get("MODEL_NAME", "muse-wonder-1.0")
    from datetime import date
    from pipeline import prices_live
    try:
        found, errors, backend = prices_live.lookup(items, key, model, date.today().isoformat())
    except Exception as exc:
        return jsonify(error=str(exc)[:300]), 502
    return jsonify(found=found, errors=errors, backend=backend, as_of=date.today().isoformat(), model=model, asked=len(items))


@app.route("/api/prices")
def prices():
    return send_from_directory(Path(__file__).resolve().parent, "prices.json", max_age=0)


@app.route("/api/plans/<pid>/reviewed", methods=["PUT"])
def save_reviewed(pid):
    d = plan_dir(pid)
    body = request.get_json(force=True)
    write_json(d / "reviewed.json", {
        "detections": body.get("detections", []), "rejected": body.get("rejected", []),
        "exclude": body.get("exclude", []), "meta": body.get("meta", {}), "wires": body.get("wires", []),
    })
    m = read_json(d / "meta.json", {})          # scale and estimate settings live with the plan, not the run
    mm = body.get("meta", {}) or {}
    for k in ("scale", "est"):
        if k in mm:
            m[k] = mm[k]
    write_json(d / "meta.json", m)
    return jsonify(ok=True)


if __name__ == "__main__":
    host, port = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "5000"))
    print("\n  Plan Takeoff is running:  http://%s:%d" % (host, port))
    print("  Meta model key:           %s" % ("loaded" if os.environ.get("MODEL_API_KEY") else "NOT FOUND (put it in the .env file)"))
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
        print("  OCR (tesseract):          found")
    except Exception:
        print("  OCR (tesseract):          not installed (optional; the app still works)")
    print("  Close this window or press Ctrl+C to stop.\n")
    if os.environ.get("TAKEOFF_OPEN") == "1":
        import threading
        import webbrowser
        threading.Timer(1.5, lambda: webbrowser.open(f"http://{host}:{port}")).start()
    app.run(host=host, port=port, threaded=True)