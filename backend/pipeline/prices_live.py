"""Live price lookup for the parts a plan needs.

For each part: search the web, collect the result snippets, and have the Meta model read the unit price OFF those
snippets (it must cite which result). A price only counts as web-sourced if the number really appears in the cited
snippet; otherwise it is downgraded to a plain model estimate and labelled that way.

Search backend (first that works):  TAVILY_API_KEY -> BRAVE_API_KEY -> free DuckDuckGo search (package `ddgs`).
"""
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor

import requests

from . import vlm

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["price", "low", "high", "store", "url", "note"],
          "properties": {"price": {"type": ["number", "null"]}, "low": {"type": ["number", "null"]},
                         "high": {"type": ["number", "null"]}, "store": {"type": "string"},
                         "url": {"type": "string"}, "note": {"type": "string"}}}


def backend_name():
    if os.environ.get("TAVILY_API_KEY"):
        return "tavily"
    if os.environ.get("BRAVE_API_KEY"):
        return "brave"
    try:
        import ddgs  # noqa: F401
        return "duckduckgo"
    except Exception:
        return "duckduckgo-html"   # needs nothing beyond `requests`


def _parse_ddg_html(html, n):
    import html as H
    from urllib.parse import parse_qs, unquote, urlparse
    out = []
    for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>(.*?)(?=<a[^>]+class="result__a"|$)', html, re.S):
        href, title, rest = m.group(1), m.group(2), m.group(3)
        if href.startswith("//"):
            href = "https:" + href
        q = parse_qs(urlparse(href).query)
        url = unquote(q["uddg"][0]) if "uddg" in q else href
        sn = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', rest, re.S)
        clean = lambda t: H.unescape(re.sub(r"<[^>]+>", "", t)).strip()
        out.append({"title": clean(title), "url": url, "snippet": clean(sn.group(1)) if sn else ""})
        if len(out) >= n:
            break
    return out


def _ddg_html(query, n):
    r = requests.post("https://html.duckduckgo.com/html/", data={"q": query},
                      headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}, timeout=30)
    r.raise_for_status()
    res = _parse_ddg_html(r.text, n)
    if not res:
        raise RuntimeError("search returned nothing (DuckDuckGo may be blocking this request; set TAVILY_API_KEY or BRAVE_API_KEY in .env)")
    return res


def search(query, n=6):
    """-> [{title, url, snippet}]; raises if the backend fails."""
    b = backend_name()
    if b == "tavily":
        r = requests.post("https://api.tavily.com/search", json={"api_key": os.environ["TAVILY_API_KEY"], "query": query,
                          "max_results": n, "search_depth": "basic"}, timeout=30)
        r.raise_for_status()
        return [{"title": x.get("title", ""), "url": x.get("url", ""), "snippet": x.get("content", "")} for x in r.json().get("results", [])]
    if b == "brave":
        r = requests.get("https://api.search.brave.com/res/v1/web/search", params={"q": query, "count": n},
                         headers={"X-Subscription-Token": os.environ["BRAVE_API_KEY"], "Accept": "application/json"}, timeout=30)
        r.raise_for_status()
        return [{"title": x.get("title", ""), "url": x.get("url", ""), "snippet": re.sub("<[^>]+>", "", x.get("description", ""))}
                for x in r.json().get("web", {}).get("results", [])]
    if b == "duckduckgo":
        try:
            from ddgs import DDGS
        except Exception:
            from duckduckgo_search import DDGS
        with DDGS() as d:
            return [{"title": x.get("title", ""), "url": x.get("href", ""), "snippet": x.get("body", "")} for x in d.text(query, max_results=n)]
    if b == "duckduckgo-html":
        return _ddg_html(query, n)
    raise RuntimeError("no web search backend available")


def _money_in(text, price):
    """True if this dollar amount appears in the text (as $4, $4.00, $4.5, $1,299.00 ...)."""
    for m in re.finditer(r"\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)", text):
        try:
            if abs(float(m.group(1).replace(",", "")) - price) < 0.011:
                return True
        except ValueError:
            pass
    return False


def price_one(item, unit, api_key, model, today):
    query = f"{item} {'per foot ' if unit == 'ft' else ''}residential electrical price home depot lowes"
    try:
        hits = search(query)
    except Exception as exc:
        return {"error": f"search failed: {str(exc)[:120]}"}
    hits = [h for h in hits if h["url"] and h["snippet"]][:6]
    if not hits:
        return {"error": "no search results"}
    block = "\n".join(f"[{i + 1}] {h['title']} | {h['url']}\n{h['snippet'][:500]}" for i, h in enumerate(hits))
    prompt = (f"Today is {today}. I need the current US retail price of ONE unit of: \"{item}\" (priced per {unit}), a standard "
              "residential-grade product. Below are web search results. Read the price ONLY from these results; never guess. "
              "Give price = the most typical single-unit price (if a result shows a multi-pack, divide by the pack count), "
              "low/high = the range you see, store = the retailer, url = the exact result URL the price came from. "
              "If the results show no usable price, set price to null.\n\n" + block)
    try:
        data = vlm.ask_model(api_key, model, [{"type": "text", "text": prompt}], SCHEMA)
        out = json.loads(data["choices"][0]["message"]["content"])
    except Exception as exc:
        return {"error": f"model failed: {str(exc)[:120]}"}
    p = out.get("price")
    if p is None or p < 0:
        return {"error": out.get("note") or "no price in results"}
    cited = next((h for h in hits if h["url"] == out.get("url")), None)
    grounded = bool(cited and _money_in(cited["title"] + " " + cited["snippet"], float(p))) or \
        any(_money_in(h["snippet"], float(p)) for h in hits)
    res = {"price": round(float(p), 2), "low": out.get("low"), "high": out.get("high"), "store": out.get("store", ""),
           "url": (cited or hits[0])["url"], "note": out.get("note", ""), "basis": "web" if grounded else "model"}
    if not grounded:
        res["note"] = ("price not found verbatim in the search results; treat as an estimate. " + res["note"]).strip()
    return res


def lookup(items, api_key, model, today):
    """items: [{item, unit, qty}] -> (found {item: result}, errors {item: msg}, backend)"""
    b = backend_name()
    if not b:
        raise RuntimeError("no web search backend: run  python -m pip install ddgs  (or set TAVILY_API_KEY / BRAVE_API_KEY in .env)")
    found, errors = {}, {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {i["item"]: ex.submit(price_one, i["item"], i.get("unit", "each"), api_key, model, today) for i in items}
        for name, f in futs.items():
            r = f.result()
            if "error" in r:
                errors[name] = r["error"]
            else:
                found[name] = r
    return found, errors, b
