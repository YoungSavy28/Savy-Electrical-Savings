"""Stage 3 (optional): ask a vision-language model to confirm each candidate.

Uses Meta Model API's Chat Completions endpoint with plain `requests`
(docs: https://dev.meta.ai/docs/image-understanding and /docs/structured-output).
Only `ask_model` knows which provider is called; swap it to try Fireworks/Baseten.
"""
import base64
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

BASE_URL = "https://api.meta.ai/v1"

INSTRUCTIONS = (
    "Compare the candidate crop to the reference symbols by shape, and by any text printed "
    "with the symbol (for example RCLT). Pick the single best matching reference id. If it "
    "matches none of them (plumbing fixtures, furniture, walls, stairs, letters in room names, "
    'partial symbols), answer "none". Give a confidence from 0 to 1 and one short reason about the shapes.'
)


def _data_url_from_file(path: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(Path(path).read_bytes()).decode()


def _data_url_from_pil(img) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def ask_model(api_key: str, model: str, content: list, schema: dict) -> dict:
    body = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "SymbolMatch", "schema": schema}},
        "temperature": 0,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    r = requests.post(f"{BASE_URL}/chat/completions", headers=headers, json=body, timeout=120)
    if r.status_code == 400 and "temperature" in r.text.lower():
        body.pop("temperature")
        r = requests.post(f"{BASE_URL}/chat/completions", headers=headers, json=body, timeout=120)
    if not r.ok:   # keep the server's own explanation: it says exactly what it did not like
        raise RuntimeError(f"Meta API answered {r.status_code}: {r.text[:400]}")
    return r.json()


def build_content(refs: list, cand_img) -> list:
    content = [{"type": "text", "text": "Reference symbols from this plan's legend, each with an id and label:"}]
    for s, path in refs:
        hints = " ".join(s.get("hints", []))
        content.append({"type": "text", "text": f'Reference id "{s["id"]}" ({s["legend_label"]}). {s["description"]} {hints}'})
        content.append({"type": "image_url", "image_url": {"url": _data_url_from_file(path)}})
    content.append({"type": "text", "text": "Candidate crop from the plan:"})
    content.append({"type": "image_url", "image_url": {"url": _data_url_from_pil(cand_img)}})
    content.append({"type": "text", "text": INSTRUCTIONS})
    return content


def classify_all(plan_img, cands: list, refs: list, api_key: str, model: str, workers: int = 6):
    """refs: [(symbol_dict, legend_crop_path)]. Returns (results, stats); results align with cands."""
    ids = [s["id"] for s, _ in refs]
    schema = {
        "type": "object",
        "properties": {
            "id": {"type": "string", "enum": ids + ["none"]},
            "confidence": {"type": "number"},
            "reason": {"type": "string"},
        },
        "required": ["id", "confidence", "reason"],
        "additionalProperties": False,
    }
    W, H = plan_img.size

    def one(c):
        x, y, w, h = c["bbox"]
        pad = max(20, int(0.35 * max(w, h)))
        crop = plan_img.crop((max(0, x - pad), max(0, y - pad), min(W, x + w + pad), min(H, y + h + pad)))
        t0 = time.time()
        try:
            data = ask_model(api_key, model, build_content(refs, crop), schema)
            out = json.loads(data["choices"][0]["message"]["content"])
            u = data.get("usage", {})
            return {"id": out["id"], "confidence": float(out["confidence"]), "reason": out["reason"],
                    "latency": time.time() - t0, "in": u.get("prompt_tokens", 0), "out": u.get("completion_tokens", 0)}
        except Exception as exc:
            return {"error": str(exc)[:200], "latency": time.time() - t0, "in": 0, "out": 0}

    with ThreadPoolExecutor(workers) as ex:
        results = list(ex.map(one, cands))
    stats = {
        "calls": len(results),
        "errors": sum("error" in r for r in results),
        "tokens_in": sum(r["in"] for r in results),
        "tokens_out": sum(r["out"] for r in results),
    }
    return results, stats
