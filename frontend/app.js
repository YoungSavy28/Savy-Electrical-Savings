"use strict";
// app.js
/* Plan Takeoff UI: pan/zoom viewer, SVG overlay, click-to-correct, legend builder, exports.
   No build step. Talks to the Flask API in backend/app.py. */

const $ = (s, r = document) => r.querySelector(s);
const NS = "http://www.w3.org/2000/svg";
const S = {
  cfg: null, plan: null, dets: [], rej: [], exclude: [], auto: {}, meta: null,
  reviewType: null, wires: [], selWire: null, scale: null, est: null, prices: null, autoWires: {}, scaleLen: null,
  sels: [], selRej: null, mode: "select", drag: null, undo: [],
  view: { x: 0, y: 0, k: 1 }, saveTimer: null, counter: 1, legendStamp: Date.now(),
};

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const se = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const symList = () => (S.plan && S.plan.symbols) || (S.cfg && S.cfg.symbols) || [];
const pointSyms = () => symList().filter(s => !s.line);
const symOf = id => symList().find(s => s.id === id);
const colorOf = id => (symOf(id) || {}).color || "#444";
/* thumbnails: the legend crop for a type, and a crop of what was found on the plan */
const refImg = id => (S.plan && S.plan.legend_refs.includes(id))
  ? `<img class="thumb" src="/files/${S.plan.plan_id}/legend/${id}.png?t=${S.legendStamp}" alt="">` : "";
function cropThumb(d, maxW = 46, maxH = 40) {
  const [x, y, w, h] = d.bbox, k = Math.min(maxW / w, maxH / h, 3);
  return `<span class="crop" style="width:${Math.round(w * k)}px;height:${Math.round(h * k)}px;background-image:url('${S.plan.image_url}');background-size:${Math.round(S.plan.width * k)}px ${Math.round(S.plan.height * k)}px;background-position:${-Math.round(x * k)}px ${-Math.round(y * k)}px"></span>`;
}
const byId = id => S.dets.find(d => d.id === id);
const selDets = () => S.sels.map(byId).filter(Boolean);

/* ---------- api / feedback ---------- */
async function api(path, { method = "GET", body } = {}) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  const r = await fetch(path, opts);
  let j = {};
  try { j = await r.json(); } catch (_) { /* non-json error */ }
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}
function busy(on, msg) { $("#busy").hidden = !on; if (msg) $("#busyMsg").textContent = msg; }
let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast"); t.textContent = msg; t.className = err ? "err" : ""; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 7000 : 4000);
}

function fillAddType() { $("#addType").innerHTML = pointSyms().map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join(""); }

/* ---------- wires + estimate helpers ---------- */
const wireFt = w => (S.scale ? w.length_px / S.scale : null);
function wireStats(labelId) {
  const runs = S.wires.filter(w => w.label === labelId);
  const ft = S.scale ? runs.reduce((a, w) => a + w.length_px / S.scale, 0) : null;
  return { runs: runs.length, ft };
}
const fmt = (n, d = 2) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const money = n => "$" + fmt(n, 2);
function estDefaults() {
  const L = (S.prices && S.prices.labor) || {};
  return { confirmed: false, prices: {}, rate: L.rate_per_hour ?? 85, markup: L.material_markup_pct ?? 15, contingency: L.contingency_pct ?? 10,
    waste: L.wire_waste_pct ?? 10, vertical: L.vertical_ft_per_run ?? 8, hours: {}, found: {}, foundAt: "", foundBy: "", lookup: "" };
}
function countWiresByLabel(list) { const c = {}; for (const w of list || []) c[w.label] = (c[w.label] || 0) + 1; return c; }

/* ---------- plan loading ---------- */
function loadPlan(p) {
  S.plan = p; S.sels = []; S.selRej = null; S.undo = []; S.legendStamp = Date.now();
  S.exclude = (p.exclude || []).map(b => b.slice());
  const src = p.reviewed || p.result;
  S.dets = src ? src.detections : [];
  S.rej = src ? (src.rejected || []) : [];
  S.auto = p.result ? p.result.totals : {};
  S.wires = (src && src.wires) || []; S.selWire = null;
  S.autoWires = countWiresByLabel(p.result && p.result.wires);
  S.scale = p.scale || (p.reviewed && p.reviewed.meta && p.reviewed.meta.scale) || null;
  S.est = Object.assign(estDefaults(), p.est || {});
  $("#scaleForm").hidden = true;
  S.meta = (p.reviewed && p.reviewed.meta && Object.keys(p.reviewed.meta).length ? p.reviewed.meta : (p.result && p.result.meta)) || null;
  S.dets.forEach(d => { if (d.orig_label === undefined) d.orig_label = d.label; });
  const img = $("#img");
  img.setAttribute("href", p.image_url + "?t=" + Date.now());
  img.setAttribute("width", p.width); img.setAttribute("height", p.height);
  $("#empty").hidden = true;
  fillAddType(); setMode("select"); fit(); renderAll();
}

async function loadSample() {
  busy(true, "Loading sample…");
  try {
    const p = await api(`/api/samples/${S.cfg.samples[0]}`, { method: "POST" });
    loadPlan(p); busy(false);
    await run();
  } catch (e) { busy(false); toast(e.message, true); }
}

async function upload(file) {
  const fd = new FormData(); fd.append("file", file);
  busy(true, "Uploading…");
  try {
    loadPlan(await api("/api/plans", { method: "POST", body: fd }));
  } catch (e) { busy(false); return toast(e.message, true); }
  busy(false);
  if (!S.cfg.hasKey) return toast("Step 1: draw a box around each symbol in this plan's legend, then run detection.");
  if (await autoLegend(true)) await run();   // fully automatic: read legend, then detect
}

/* ---------- auto legend ---------- */
async function autoLegend(chain = false) {
  if (!S.plan) { toast("Load or upload a plan first", true); return false; }
  busy(true, "Reading the legend and cutting out every symbol (about 10-30 s)…");
  try {
    const p = await api(`/api/plans/${S.plan.plan_id}/auto_legend`, { method: "POST", body: {} });
    S.plan.legend_refs = p.legend_refs; S.plan.symbols = p.symbols; S.legendStamp = Date.now();
    S.exclude = (p.exclude || []).map(b => b.slice());
    fillAddType(); renderAll(); scheduleSave();
    const h0 = $("#autoHint"); if (h0) h0.style.color = "";
    const a = p.auto;
    if (!a.region || !a.count) { toast((a.notes[0] || "No legend found") + " Draw the symbols by hand instead.", true); return false; }
    if (!chain) toast(`Read ${a.count} legend symbols.` + (a.notes.length ? ` Skipped: ${a.notes.length} (see Redo/Draw).` : "") + " Check the thumbnails, then Run detection.");
    return true;
  } catch (e) { showAutoErr(e.message); return false; } finally { busy(false); }
}
function showAutoErr(msg) {   // stays on screen (a toast fades before you can read it)
  toast(msg, true);
  const h = $("#autoHint"); if (h) { h.textContent = "Reading the legend failed: " + msg + "  You can still draw each symbol by hand (Draw buttons below)."; h.style.color = "#f87171"; }
}

/* ---------- detection ---------- */
async function run() {
  if (!S.plan) return toast("Load a plan first", true);
  if (!S.plan.legend_refs.length) return toast("Draw at least one legend symbol first", true);
  const vlm = $("#useVlm").checked;
  busy(true, vlm ? "Detecting, then verifying each hit with the vision model (can take a minute)…" : "Detecting symbols…");
  try {
    const res = await api(`/api/plans/${S.plan.plan_id}/process`, {
      method: "POST", body: { exclude: S.exclude, threshold: +$("#thr").value, use_vlm: vlm },
    });
    S.dets = res.detections; S.dets.forEach(d => { d.orig_label = d.label; });
    S.rej = res.rejected; S.auto = res.totals; S.meta = res.meta;
    if (res.symbols) { S.plan.symbols = res.symbols; S.plan.legend_refs = [...new Set([...S.plan.legend_refs, ...res.symbols.filter(s => s.line).map(s => s.id)])]; S.legendStamp = Date.now(); }
    S.wires = res.wires || []; S.selWire = null; S.autoWires = countWiresByLabel(S.wires);
    S.sels = []; S.selRej = null; S.undo = [];
    renderAll();
    $("#saveState").textContent = "";
    toast(`Found ${S.dets.length} symbols` + (S.wires.length ? ` and ${S.wires.length} wire runs` : "") + ` in ${res.meta.seconds}s. Click any box to change or remove it.` + (S.wires.length && !S.scale ? " Set the scale to get wire lengths in feet." : ""));
  } catch (e) { toast(e.message, true); } finally { busy(false); }
}

/* ---------- viewer ---------- */
function applyView() { const v = S.view; $("#world").setAttribute("transform", `translate(${v.x} ${v.y}) scale(${v.k})`); renderPopup(); }
function fit() {
  if (!S.plan) return;
  const svg = $("#svg"), w = svg.clientWidth, h = svg.clientHeight;
  const k = Math.min(w / S.plan.width, h / S.plan.height) * 0.96;
  S.view = { k, x: (w - S.plan.width * k) / 2, y: (h - S.plan.height * k) / 2 };
  applyView();
}
function focusOn(d) {
  const svg = $("#svg"), [x, y, w, h] = d.bbox, k = Math.max(S.view.k, 1.4);
  S.view = { k, x: svg.clientWidth / 2 - (x + w / 2) * k, y: svg.clientHeight / 2 - (y + h / 2) * k };
  applyView();
}
function toImg(e) {
  const r = $("#svg").getBoundingClientRect();
  return { x: (e.clientX - r.left - S.view.x) / S.view.k, y: (e.clientY - r.top - S.view.y) / S.view.k };
}
function showDraft(x, y, w, h) {
  const d = $("#draft");
  d.setAttribute("x", x); d.setAttribute("y", y); d.setAttribute("width", w); d.setAttribute("height", h);
  d.setAttribute("vector-effect", "non-scaling-stroke"); d.setAttribute("visibility", "visible");
}

const svg = $("#svg");
svg.addEventListener("wheel", e => {
  if (!S.plan) return;
  e.preventDefault();
  const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, v = S.view;
  const nk = Math.min(Math.max(v.k * Math.exp(-e.deltaY * 0.0015), 0.05), 14);
  v.x = mx - (mx - v.x) * (nk / v.k); v.y = my - (my - v.y) * (nk / v.k); v.k = nk;
  applyView();
}, { passive: false });

svg.addEventListener("pointerdown", e => {
  if (!S.plan || e.button !== 0) return;
  svg.setPointerCapture(e.pointerId);
  const ds = e.target.dataset || {};
  const hit = ds.id ? { id: ds.id, rej: false } : ds.rid ? { id: ds.rid, rej: true } : ds.wid ? { id: ds.wid, wire: true } : null;
  if (S.mode === "wire") {
    S.drag = { type: "pan", cx: e.clientX, cy: e.clientY, vx: S.view.x, vy: S.view.y, moved: false, wireClick: true };
    svg.classList.add("panning");
    return;
  }
  if (S.mode !== "select") {
    const p = toImg(e);
    S.drag = { type: "draw", sx: p.x, sy: p.y };
    showDraft(p.x, p.y, 0, 0);
    return;
  }
  S.drag = { type: "pan", cx: e.clientX, cy: e.clientY, vx: S.view.x, vy: S.view.y, moved: false, hit, shift: e.shiftKey };
  svg.classList.add("panning");
});
svg.addEventListener("pointermove", e => {
  if (S.mode === "wire" && S.wireDraft && !S.drag) { const p = toImg(e); S.wireDraft.cur = [Math.round(p.x), Math.round(p.y)]; renderBoxes(); return; }
  const d = S.drag; if (!d) return;
  if (d.type === "pan") {
    const dx = e.clientX - d.cx, dy = e.clientY - d.cy;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) { S.view.x = d.vx + dx; S.view.y = d.vy + dy; applyView(); }
  } else {
    const p = toImg(e);
    showDraft(Math.min(d.sx, p.x), Math.min(d.sy, p.y), Math.abs(p.x - d.sx), Math.abs(p.y - d.sy));
  }
});
function endDrag(e, cancelled) {
  const d = S.drag; S.drag = null; svg.classList.remove("panning");
  $("#draft").setAttribute("visibility", "hidden");
  if (!d || cancelled) return;
  if (d.type === "pan") {
    if (!d.moved) { if (d.wireClick) wireClick(toImg(e)); else if (d.hit) selectItem(d.hit, d.shift); else if (!d.shift) clearSel(); }
    return;
  }
  const p = toImg(e);
  const r = { x: Math.min(d.sx, p.x), y: Math.min(d.sy, p.y), w: Math.abs(p.x - d.sx), h: Math.abs(p.y - d.sy) };
  if ((r.w >= 8 && r.h >= 8) || (S.mode === "scale" && Math.hypot(r.w, r.h) >= 8)) finishDraw(r);   // scale lines may be perfectly flat
}
/* touch: two-finger pinch zooms and pans the plan */
const ptrs = new Map(); let pinch = null;
svg.addEventListener("pointerdown", e => {
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) {
    S.drag = null; $("#draft").setAttribute("visibility", "hidden"); svg.classList.remove("panning");
    const [a, b] = [...ptrs.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: S.view.k, vx: S.view.x, vy: S.view.y, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }
});
svg.addEventListener("pointermove", e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pinch || ptrs.size !== 2 || !S.plan) return;
  const [a, b] = [...ptrs.values()], r = svg.getBoundingClientRect();
  const nk = Math.min(Math.max(pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, 0.05), 14);
  const wx = (pinch.cx - r.left - pinch.vx) / pinch.k, wy = (pinch.cy - r.top - pinch.vy) / pinch.k;   // plan point under the fingers at the start
  S.view.k = nk; S.view.x = (a.x + b.x) / 2 - r.left - wx * nk; S.view.y = (a.y + b.y) / 2 - r.top - wy * nk;
  applyView();
});
const endPtr = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; };
svg.addEventListener("pointerup", endPtr); svg.addEventListener("pointercancel", endPtr);
svg.addEventListener("pointerup", e => endDrag(e, false));
svg.addEventListener("pointercancel", e => endDrag(e, true));

function setMode(m, hint) {
  S.mode = m; S.wireDraft = null;
  document.querySelectorAll("#toolbar [data-mode]").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  svg.classList.toggle("drawing", m !== "select");
  $("#modeHint").textContent = hint || (m === "add" ? "Drag a box around the missed symbol (Esc to stop)" : m === "exclude" ? "Drag a box around the area to ignore" : m === "multi" ? "Drag a rectangle around the symbols to select them (Esc to stop)" : m === "wire" ? "Click the first device, click each corner of the wire path, then click the last device. Enter = finish here, Esc = cancel" : m === "scale" ? "Drag along a length you know (e.g. the 36 ft overall dimension line), corner to corner" : "");
  renderLegend();
}

function deviceAt(p) {
  const pad = 8;
  let best = null;
  for (const d of S.dets) {
    if (d.status === "deleted") continue;
    const [x, y, w, h] = d.bbox;
    if (p.x >= x - pad && p.x <= x + w + pad && p.y >= y - pad && p.y <= y + h + pad) {
      const dist = Math.hypot(p.x - (x + w / 2), p.y - (y + h / 2));
      if (!best || dist < best.dist) best = { d, dist };
    }
  }
  return best && best.d;
}
const centerOf = d => [Math.round(d.bbox[0] + d.bbox[2] / 2), Math.round(d.bbox[1] + d.bbox[3] / 2)];
function wireLabelId() { const l = symList().find(s => s.line); return l ? l.id : null; }
function wireClick(p) {
  const lid = wireLabelId();
  if (!lid) { toast("This plan's legend has no wire line style to draw with.", true); return; }
  const dev = deviceAt(p);
  if (!S.wireDraft) {
    if (!dev) { toast("Start by clicking the device the wire starts at (usually a switch).", true); return; }
    S.wireDraft = { pts: [centerOf(dev)], from: dev.id, cur: null }; renderBoxes(); return;
  }
  if (dev && dev.id !== S.wireDraft.from) { S.wireDraft.pts.push(centerOf(dev)); saveDraft(dev.id); return; }
  if (dev) return;   // clicked the start device again
  S.wireDraft.pts.push([Math.round(p.x), Math.round(p.y)]); renderBoxes();
}
function saveDraft(toId) {
  const D = S.wireDraft; if (!D) return;
  const pts = D.pts; if (pts.length < 2) { S.wireDraft = null; renderBoxes(); return; }
  let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const a = byId(D.from), b = toId ? byId(toId) : null;
  S.wires.push({ id: "wm" + Date.now().toString(36) + S.counter++, label: wireLabelId(), points: pts, length_px: Math.round(len * 10) / 10, dashes: 0,
    from: D.from, to: toId || null, from_label: a ? a.label : null, to_label: b ? b.label : null, flags: ["drawn by hand"] });
  S.wireDraft = null; S.selWire = S.wires[S.wires.length - 1].id;
  renderAll(); scheduleSave(); toast("Wire run added. Click another device to start the next one.");
}

async function finishDraw(r) {
  const bbox = [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)];
  if (S.mode === "add") {
    mutate(() => {
      const d = { id: "u" + Date.now().toString(36) + S.counter++, bbox, label: $("#addType").value, confidence: 1, status: "added", flags: [], source: "human", reason: "", orig_label: null };
      S.dets.push(d); S.sels = [d.id]; S.selRej = null;
    });
  } else if (S.mode === "multi") {
    const inside = S.dets.filter(d => d.status !== "deleted" && d.bbox[0] + d.bbox[2] / 2 >= bbox[0] && d.bbox[0] + d.bbox[2] / 2 <= bbox[0] + bbox[2] && d.bbox[1] + d.bbox[3] / 2 >= bbox[1] && d.bbox[1] + d.bbox[3] / 2 <= bbox[1] + bbox[3]);
    S.sels = inside.map(d => d.id); S.selRej = null; renderAll();
    toast(inside.length ? `${inside.length} selected. Pick a type or Remove.` : "Nothing inside that rectangle.", !inside.length);
  } else if (S.mode === "scale") {
    S.scaleLen = Math.hypot(r.w, r.h); setMode("select");
    $("#scaleForm").hidden = false; $("#scaleFt").value = ""; $("#scaleFt").focus();
  } else if (S.mode === "exclude") {
    S.exclude.push(bbox); setMode("select"); renderAll(); scheduleSave();
  } else if (S.mode.startsWith("legend:")) {
    const id = S.mode.slice(7);
    busy(true, "Saving legend symbol…");
    try {
      const p = await api(`/api/plans/${S.plan.plan_id}/legend`, { method: "POST", body: { symbol: id, bbox } });
      S.plan.legend_refs = p.legend_refs; S.legendStamp = Date.now();
      setMode("select"); renderAll();
    } catch (e) { toast(e.message, true); } finally { busy(false); }
  }
}

/* ---------- editing ---------- */
function pushUndo() { S.undo.push(JSON.stringify({ dets: S.dets, rej: S.rej })); if (S.undo.length > 100) S.undo.shift(); }
function mutate(fn) { pushUndo(); fn(); renderAll(); scheduleSave(); }
function undo() {
  const snap = S.undo.pop(); if (!snap) return;
  const o = JSON.parse(snap); S.dets = o.dets; S.rej = o.rej;
  S.sels = S.sels.filter(id => byId(id) && byId(id).status !== "deleted");
  renderAll(); scheduleSave();
}
function selectItem(hit, additive) {
  if (hit.wire) { S.selWire = hit.id; S.sels = []; S.selRej = null; renderAll(); return; }
  S.selWire = null;
  if (hit.rej) { S.selRej = hit.id; S.sels = []; }
  else if (additive) { S.sels = S.sels.includes(hit.id) ? S.sels.filter(i => i !== hit.id) : [...S.sels, hit.id]; S.selRej = null; }
  else { S.sels = [hit.id]; S.selRej = null; }
  renderAll();
}
function clearSel() { if (S.sels.length || S.selRej || S.selWire) { S.sels = []; S.selRej = null; S.selWire = null; renderAll(); } }
function relabel(id) {
  const ds = selDets().filter(d => d.label !== id); if (!ds.length) return;
  mutate(() => { for (const d of ds) { d.label = id; d.flags = []; d.status = d.status === "added" ? "added" : (id === d.orig_label ? "auto" : "corrected"); } });
}
function delSel() {
  if (S.selWire && !S.sels.length) { S.wires = S.wires.filter(x => x.id !== S.selWire); S.selWire = null; renderAll(); scheduleSave(); toast("Wire run removed."); return; }
  const ds = selDets(); if (!ds.length) return;
  mutate(() => { for (const d of ds) d.status = "deleted"; S.sels = []; });
  toast(`Removed ${ds.length}. Ctrl+Z to undo.`);
}
function dismissFlags() { const ds = selDets(); if (ds.length) mutate(() => { for (const d of ds) d.flags = []; }); }
function flaggedList() { return S.dets.filter(d => d.status !== "deleted" && d.flags.length).sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]); }
function selectFlagged() {
  const l = flaggedList(); S.sels = l.map(d => d.id); S.selRej = null; renderAll();
  toast(l.length ? `${l.length} flagged selected. Pick a type or Remove.` : "Nothing is flagged.", !l.length);
}
function selectType(id) {
  const l = S.dets.filter(d => d.status !== "deleted" && d.label === id); S.sels = l.map(d => d.id); S.selRej = null; renderAll();
  toast(l.length ? `All ${l.length} ${(symOf(id) || {}).label} selected. Pick a type or Remove.` : "None of that type.", !l.length);
}
function nextFlag() {
  const l = flaggedList(); if (!l.length) { toast("Nothing left to review"); clearSel(); return; }
  const cur = l.findIndex(d => d.id === S.sels[0]);
  const d = l[(cur + 1) % l.length]; S.sels = [d.id]; S.selRej = null; focusOn(d); renderAll();
}
function keepAndNext() { const ds = selDets(); if (ds.length) { mutate(() => { for (const d of ds) d.flags = []; }); } nextFlag(); }
function restoreRejected() {
  const i = S.rej.findIndex(r => r.id === S.selRej); if (i < 0) return;
  mutate(() => {
    const [r] = S.rej.splice(i, 1);
    r.id = "u" + Date.now().toString(36) + S.counter++; r.status = "added"; r.flags = ["restored from rejected"]; r.orig_label = null;
    S.dets.push(r); S.sels = [r.id]; S.selRej = null;
  });
}
function scheduleSave() {
  if (!S.plan) return;
  $("#saveState").textContent = "Saving…";
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(async () => {
    try {
      await api(`/api/plans/${S.plan.plan_id}/reviewed`, { method: "PUT", body: { detections: S.dets, rejected: S.rej, exclude: S.exclude, wires: S.wires, meta: Object.assign({}, S.meta || {}, { scale: S.scale, est: S.est }) } });
      $("#saveState").textContent = "Saved ✓";
    } catch (_) { $("#saveState").textContent = "Not saved"; }
  }, 700);
}

/* ---------- rendering ---------- */
function counts() { const c = {}; for (const d of S.dets) if (d.status !== "deleted") c[d.label] = (c[d.label] || 0) + 1; return c; }

function renderBoxes() {
  const g = $("#boxes"); g.replaceChildren();
  const live = S.dets.filter(d => d.status !== "deleted");
  live.sort((a, b) => S.sels.includes(a.id) - S.sels.includes(b.id));   // selected drawn last (on top)
  for (const d of live) {
    const [x, y, w, h] = d.bbox, col = colorOf(d.label);
    g.appendChild(se("rect", {
      x, y, width: w, height: h, fill: col, stroke: col, "data-id": d.id, "vector-effect": "non-scaling-stroke",
      class: "box" + (d.flags.length ? " flagged" : "") + (S.sels.includes(d.id) ? " sel" : ""),
    }));
  }
  if (S.reviewType) {
    reviewOrder(S.reviewType).forEach((d, i) => {
      const [x, y, w] = d.bbox, r = Math.max(9, w * 0.45);
      g.appendChild(se("circle", { cx: x + w / 2, cy: y - r * 0.7, r, class: "rvdot", "pointer-events": "none" }));
      const t = se("text", { x: x + w / 2, y: y - r * 0.7 + r * 0.38, "text-anchor": "middle", class: "rvtxt", "font-size": r * 1.15, "pointer-events": "none" });
      t.textContent = String(i + 1); g.appendChild(t);
    });
  }
  const rg = $("#rej"); rg.replaceChildren();
  if ($("#showRejected").checked) {
    for (const r of S.rej) {
      const [x, y, w, h] = r.bbox;
      rg.appendChild(se("rect", { x, y, width: w, height: h, "data-rid": r.id, "vector-effect": "non-scaling-stroke", class: "rejbox" + (S.selRej === r.id ? " sel" : "") }));
    }
  }
  const wg = $("#wires"); wg.replaceChildren();
  for (const w of S.wires) {
    const pts = w.points.map(p => p.join(",")).join(" "), sel = S.selWire === w.id;
    wg.appendChild(se("polyline", { points: pts, class: "wrunhit", "data-wid": w.id, "vector-effect": "non-scaling-stroke" }));
    wg.appendChild(se("polyline", { points: pts, class: "wrun" + (sel ? " sel" : "") + (w.flags && w.flags.length ? " flagged" : ""), "vector-effect": "non-scaling-stroke" }));
  }
  if (S.wireDraft) {
    const pts = S.wireDraft.pts.concat(S.wireDraft.cur ? [S.wireDraft.cur] : []);
    wg.appendChild(se("polyline", { points: pts.map(p => p.join(",")).join(" "), class: "wrun draft", "vector-effect": "non-scaling-stroke" }));
    for (const p of S.wireDraft.pts) wg.appendChild(se("circle", { cx: p[0], cy: p[1], r: 5, class: "wdot", "vector-effect": "non-scaling-stroke" }));
  }
  const eg = $("#excl"); eg.replaceChildren();
  for (const b of S.exclude) eg.appendChild(se("rect", { x: b[0], y: b[1], width: b[2], height: b[3], class: "exclbox", "vector-effect": "non-scaling-stroke" }));
}

function renderLegend() {
  const box = $("#legendRows"); box.replaceChildren();
  if (!S.plan || !S.cfg) { box.innerHTML = '<p class="hint">No plan loaded.</p>'; return; }
  for (const s of symList()) {
    const has = S.plan.legend_refs.includes(s.id), active = S.mode === "legend:" + s.id;
    const row = document.createElement("div");
    row.className = "lrow" + (has ? "" : " missing") + (active ? " active" : "");
    row.innerHTML = `<span class="sw" style="background:${s.color}"></span><span class="name">${esc(s.label)}</span>`
      + (has ? `<img src="/files/${S.plan.plan_id}/legend/${s.id}.png?t=${S.legendStamp}" alt="">` : "")
      + `<button data-act="draw">${has ? "Redo" : "Draw"}</button>` + (has ? '<button data-act="del" title="Remove">✕</button>' : "");
    row.querySelector('[data-act="draw"]').onclick = () => setMode("legend:" + s.id, `Drag a box around the "${s.label}" symbol in the legend`);
    const del = row.querySelector('[data-act="del"]');
    if (del) del.onclick = async () => {
      try { const p = await api(`/api/plans/${S.plan.plan_id}/legend/${s.id}`, { method: "DELETE" }); S.plan.legend_refs = p.legend_refs; S.legendStamp = Date.now(); renderLegend(); }
      catch (e) { toast(e.message, true); }
    };
    box.appendChild(row);
  }
}

function renderExclude() {
  const box = $("#exclList"); box.replaceChildren();
  S.exclude.forEach((b, i) => {
    const row = document.createElement("div"); row.className = "item";
    row.innerHTML = `<span>Area ${i + 1} (${b[2]}×${b[3]} px)</span><button title="Remove">✕</button>`;
    row.querySelector("button").onclick = () => { S.exclude.splice(i, 1); renderAll(); scheduleSave(); };
    box.appendChild(row);
  });
}

function renderTotals() {
  const c = counts();
  const rows = ["<tr><th>Symbol</th><th>Now</th><th>Auto</th><th>Δ</th></tr>"];
  let tn = 0, ta = 0;
  for (const s of symList()) {
    const n = s.line ? wireStats(s.id).runs : (c[s.id] || 0), a = s.line ? (S.autoWires[s.id] || 0) : (S.auto[s.id] || 0), dl = n - a;
    if (!s.line) { tn += n; ta += a; }
    rows.push(`<tr><td class="${s.line ? "" : "seltype"}" data-sym="${s.id}" title="${s.line ? "Wire runs, counted in runs. See the Wire runs list below." : "Click to list every " + esc(s.label) + " it found, so you can remove a wrong one (Shift-click selects them all on the plan)"}"><span class="sw" style="background:${s.color};display:inline-block;margin-right:6px"></span>${refImg(s.id)}${esc(s.label)}</td><td>${n}</td><td>${a}</td><td class="delta ${dl > 0 ? "up" : dl < 0 ? "down" : ""}">${dl ? (dl > 0 ? "+" : "") + dl : ""}</td></tr>`);
  }
  rows.push(`<tr class="total"><td>Total devices</td><td>${tn}</td><td>${ta}</td><td></td></tr>`);
  $("#totals").innerHTML = rows.join("");
  document.querySelectorAll("#totals .seltype").forEach(td => { td.onclick = ev => { if (ev.shiftKey) return selectType(td.dataset.sym); S.reviewType = S.reviewType === td.dataset.sym ? null : td.dataset.sym; renderAll(); const rb = $("#reviewBox"); if (S.reviewType && rb) rb.scrollIntoView({ block: "nearest", behavior: "smooth" }); }; });
}

function typeOptions(cur) { return pointSyms().map((s, i) => `<option value="${s.id}" ${s.id === cur ? "selected" : ""}>${i + 1}. ${esc(s.label)}</option>`).join(""); }
function renderWires() {
  const box = $("#wireList"); box.replaceChildren();
  const sum = $("#wireSum");
  const lines = symList().filter(s => s.line);
  $("#scaleInfo").textContent = S.scale ? `Scale: ${fmt(S.scale, 1)} px per ft` : "Scale not set";
  if (!lines.length && !S.wires.length) {
    sum.textContent = ""; box.innerHTML = '<p class="hint">No line style (wire run) in this plan\'s legend.</p>'; return;
  }
  const totalPx = S.wires.reduce((a, w) => a + w.length_px, 0);
  sum.textContent = S.wires.length ? (S.scale ? `(${S.wires.length} runs, ${fmt(totalPx / S.scale, 1)} ft)` : `(${S.wires.length} runs)`) : "";
  if (!S.wires.length) { box.innerHTML = '<p class="hint">No runs yet. Run detection.</p>'; return; }
  if (!S.scale) { const p = document.createElement("p"); p.className = "hint warnline"; p.textContent = "Set the scale to turn these into feet: press Set scale, then drag along a length printed on the plan."; box.appendChild(p); }
  S.wires.forEach((w, i) => {
    const lab = x => (x ? ((symOf(x) || {}).label || x) : "?");
    const row = document.createElement("div"); row.className = "item wrow" + (S.selWire === w.id ? " on" : "");
    const len = S.scale ? `${fmt(w.length_px / S.scale, 1)} ft` : `${Math.round(w.length_px)} px`;
    row.innerHTML = `<span class="sw" style="background:#f59e0b"></span><span class="wtxt">Run ${i + 1}: ${esc(lab(w.from_label))} → ${esc(lab(w.to_label))}${w.flags && w.flags.length ? ' <em class="why">(' + esc(w.flags[0]) + ")</em>" : ""}</span><b>${len}</b><button title="Remove this run">✕</button>`;
    row.onclick = ev => {
      if (ev.target.tagName === "BUTTON") return;
      S.selWire = w.id; S.sels = []; S.selRej = null;
      const xs = w.points.map(p => p[0]), ys = w.points.map(p => p[1]);
      focusOn({ bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] }); renderAll();
    };
    row.querySelector("button").onclick = () => { S.wires = S.wires.filter(x => x.id !== w.id); if (S.selWire === w.id) S.selWire = null; renderAll(); scheduleSave(); };
    box.appendChild(row);
  });
}

/* ---------- estimate ---------- */
function foundOf(item) {   // {options:[...], sel} for this part, or null. Accepts the older single-price shape too.
  const f = (S.est && S.est.found || {})[item];
  if (!f) return null;
  const options = f.options || [f];
  return { options, sel: Math.min(f.sel || 0, options.length - 1), query: f.query || "" };
}
function estimateModel() {
  const P = (S.prices && S.prices.items) || {}, L = (S.prices && S.prices.labor) || {}, E = S.est, c = counts();
  const qty = {}, unit = {}, hours = [];
  let wireFtTotal = 0, needScale = false;
  for (const s of symList()) {
    const hrsEach = E.hours[s.id] ?? (L.hours_each || {})[s.id] ?? L.default_hours_each ?? 0.5;
    if (s.line) {
      const st = wireStats(s.id);
      if (st.runs && !S.scale) needScale = true;
      const ft = st.runs && S.scale ? st.ft * (1 + E.waste / 100) + st.runs * E.vertical : 0;
      wireFtTotal += ft;
      for (const [item, q] of s.materials || []) { qty[item] = (qty[item] || 0) + ft * q; unit[item] = "ft"; }
      continue;
    }
    const n = c[s.id] || 0;
    for (const [item, q] of s.materials || []) { qty[item] = (qty[item] || 0) + n * q; unit[item] = (P[item] && P[item].unit) || unit[item] || "each"; }
    if (n) hours.push({ label: s.label, n, each: hrsEach, id: s.id, total: n * hrsEach });
  }
  for (const ex of (E.extras || [])) { qty[ex.item] = (qty[ex.item] || 0) + ex.qty; unit[ex.item] = ex.unit || "each"; }   // parts the user added by hand
  const wireHrs = wireFtTotal / 100 * (L.wire_hours_per_100ft ?? 2);
  if (wireFtTotal) hours.push({ label: "Pulling switch-control wire", n: Math.round(wireFtTotal), unitLabel: "ft", each: (L.wire_hours_per_100ft ?? 2) / 100, total: wireHrs, id: "_wire" });
  const lines = Object.keys(qty).filter(k => qty[k] > 0).sort().map(item => {
    const own = E.prices[item], src = P[item] || {};
    const fd = foundOf(item), pick = fd ? fd.options[fd.sel] : null, mine = own !== undefined && own !== "" && own !== null;
    const price = mine ? +own : (pick ? pick.price : (src.price ?? null));
    return { item, qty: qty[item], unit: unit[item] || src.unit || "each", price, ext: price == null ? null : qty[item] * price, src, fd, pick, mine };
  });
  const mat = lines.reduce((a, l) => a + (l.ext || 0), 0), unpriced = lines.filter(l => l.price == null).length;
  const markup = mat * E.markup / 100, labHrs = hours.reduce((a, h) => a + h.total, 0), labor = labHrs * E.rate;
  const sub = mat + markup + labor, cont = sub * E.contingency / 100;
  return { lines, hours, mat, markup, labHrs, labor, sub, cont, total: sub + cont, unpriced, needScale, wireFtTotal };
}

function renderEstimate() {
  const box = $("#estBody");
  if (!S.plan || !S.est) { box.innerHTML = '<p class="hint">Load a plan first.</p>'; return; }
  const E = S.est, c = counts();
  const map = symList().map(s => {
    const n = s.line ? wireStats(s.id).runs + " runs" : (c[s.id] || 0);
    return `<tr><td>${refImg(s.id)}</td><td>${esc(s.legend_label || s.label)}</td><td>${esc(s.label)}</td><td>${n}</td></tr>`;
  }).join("");
  let html = `<p class="hint">Check that each legend symbol (left) is mapped to the right item and the counts look right. Fix anything above first.</p>
    <table class="maptbl"><tr><th></th><th>Legend says</th><th>Mapped to</th><th>Found</th></tr>${map}</table>
    <label class="row chk"><input type="checkbox" id="estOk" ${E.confirmed ? "checked" : ""}> <span>These match the legend. Build the estimate.</span></label>`;
  if (E.confirmed) {
    if (!S.prices) {  }
    const m = estimateModel();
    const set = (key, label, step) => `<label class="est-set">${label}<input type="number" min="0" step="${step}" data-set="${key}" value="${E[key]}"></label>`;
    html += `<div class="est-settings">${set("rate", "Labor $/hr", 1)}${set("markup", "Material markup %", 1)}${set("contingency", "Contingency %", 1)}${set("waste", "Wire waste %", 1)}${set("vertical", "Extra ft per wire run", 1)}</div>
      <p class="hint">${esc(S.prices.labor.assumptions_note)} Rate guide: <a href="${esc(S.prices.labor.rate_source)}" target="_blank" rel="noopener">${esc(S.prices.labor.rate_note)}</a></p>`;
    if (m.needScale) html += '<p class="hint warnline">Wire is not included yet: set the scale (toolbar, Set scale) so wire lengths can be turned into feet.</p>';
    if (m.unpriced) html += `<p class="hint warnline">${m.unpriced} item${m.unpriced > 1 ? "s have" : " has"} no price. Type one in the highlighted box; it is counted as $0 until then.</p>`;
    const nf = Object.keys(E.found || {}).length;
    html += `<div class="btns"><button id="btnPrices" ${E.lookup === "busy" ? "disabled" : ""}>${E.lookup === "busy" ? "Searching the web for prices (about a minute)…" : nf ? "Search the web again (optional)" : "Search the web for prices (optional)"}</button></div>`;
    if (E.lookup && E.lookup !== "busy") html += `<p class="hint warnline">${esc(E.lookup)}</p>`;
    if (nf) html += `<p class="hint">Web results from ${esc(E.foundAt)}. Each part shows up to 3 products: press "options" on a row and click the one you want, and its price goes into the estimate. "est." means the price wasn't found word-for-word in the results. Typing a price overrides your pick.</p>`;
    html += `<div class="addpart"><b>Add a part that isn't on the plan</b>
      <div class="addrow"><input id="apName" type="text" placeholder="e.g. 20A GFCI breaker, hot tub disconnect, 12/2 wire" maxlength="80">
      <input id="apQty" type="number" min="0.1" step="any" value="1" title="Quantity"><select id="apUnit"><option value="each">each</option><option value="ft">per ft</option></select>
      <button id="apAdd" class="primary">Add part</button></div></div>`;
    html += `<table class="esttbl"><tr><th>Material</th><th>Qty</th><th>Unit $</th><th>Total</th></tr>` + m.lines.map(l => {
      const pk = l.pick, fdTip = pk ? esc((pk.store || "") + (pk.name ? " · " + pk.name : "") + (pk.note ? " · " + pk.note : "")) : "";
      const open = !!(E.open && E.open[l.item]), many = l.fd && l.fd.options.length > 1;
      const isExtra = (E.extras || []).some(x => x.item === l.item), busyRow = E.lookup === "busy" && (!E.busyItems || E.busyItems.includes(l.item));
      const toggle = (l.fd ? `<button class="optbtn" data-opts="${esc(l.item)}" title="Pick a different product">${open ? "▴" : "▾"} ${l.fd.options.length} option${l.fd.options.length > 1 ? "s" : ""}</button>`
        : `<button class="optbtn" data-find="${esc(l.item)}" ${E.lookup === "busy" ? "disabled" : ""} title="Optional: search Home Depot / Lowe's for this part">${busyRow ? "searching…" : "find options"}</button>`)
        + (isExtra ? ` <button class="optbtn" data-rmx="${esc(l.item)}" title="Remove this part">✕ remove</button>` : "");
      const src = pk && !l.mine ? (pk.basis === "web" && pk.url ? `<a class="srcl" href="${esc(pk.url)}" target="_blank" rel="noopener" title="${fdTip}">${esc(pk.store || "web")} ↗</a>` : `<span class="srcl" title="${fdTip}">est.</span>`) : l.src.source ? `<a class="srcl" href="${esc(l.src.source)}" target="_blank" rel="noopener" title="${esc((l.src.note || "source") + (l.src.low != null ? " · range $" + l.src.low + "–$" + l.src.high : ""))}">↗</a>` : (l.src.note ? `<span class="srcl" title="${esc(l.src.note)}">ⓘ</span>` : "");
      const cards = open && l.fd ? `<tr class="optrow"><td colspan="4">${l.fd.query ? `<div class="sq">Searched Home Depot / Lowe's for: ${esc(l.fd.query)}</div>` : ""}<div class="opts">${l.fd.options.map((o, i) => `
          <div class="opt ${i === l.fd.sel && !l.mine ? "on" : ""}" data-pick="${esc(l.item)}" data-i="${i}" role="button" tabindex="0">
            <b>${money(o.price)}</b><span class="oname">${esc(o.name)}</span>
            <small>${esc(o.store || "")}${o.basis === "web" ? "" : " · estimate"}${o.note ? " · " + esc(o.note) : ""}</small>
            ${o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener">view page ↗</a>` : ""}
          </div>`).join("")}</div></td></tr>` : "";
      return `<tr><td>${esc(l.item)} ${src}<div>${toggle}</div></td><td>${l.unit === "ft" ? fmt(l.qty, 0) + " ft" : fmt(l.qty, 0)}</td>
        <td><input class="pin ${l.price == null ? "need" : ""}" type="number" min="0" step="0.01" data-price="${esc(l.item)}" value="${l.price ?? ""}" placeholder="price"></td><td>${l.ext == null ? "–" : money(l.ext)}</td></tr>${cards}`;
    }).join("") + `<tr class="sub"><td colspan="3">Materials</td><td>${money(m.mat)}</td></tr>
      <tr><td colspan="3">Markup ${E.markup}%</td><td>${money(m.markup)}</td></tr>
      <tr class="sub"><td colspan="4">Labor</td></tr>` + m.hours.map(h => `<tr><td>${esc(h.label)}</td><td>${h.n}${h.unitLabel ? " " + h.unitLabel : ""} × ${fmt(h.each, 2)} h</td><td></td><td>${fmt(h.total, 1)} h</td></tr>`).join("") +
      `<tr><td colspan="2">${fmt(m.labHrs, 1)} hours × ${money(E.rate)}</td><td></td><td>${money(m.labor)}</td></tr>
      <tr><td colspan="3">Contingency ${E.contingency}%</td><td>${money(m.cont)}</td></tr>
      <tr class="total"><td colspan="3">ESTIMATED TOTAL</td><td>${money(m.total)}</td></tr></table>
      <p class="hint">${esc(S.prices.disclaimer)} Bundled prices as of ${esc(S.prices.as_of || "n/a")} (each has a source link); you can overwrite any price. Excludes permits, breakers, wire other than switch control, service work, and anything not in the legend. A planning estimate, not a bid.</p>
      <div class="btns"><button id="btnEstCsv">Estimate CSV</button></div>`;
  }
  box.innerHTML = html;
  bindEst();
}
async function lookupPrices(only) {   // only = array of part names, or nothing for every part
  if (!S.plan || !S.est || S.est.lookup === "busy") return;
  if (!S.cfg.hasKey) return toast("Price lookup needs MODEL_API_KEY in the .env file.");
  const names = Array.isArray(only) ? only : null;
  const m = estimateModel();
  const items = m.lines.filter(l => !names || names.includes(l.item)).map(l => ({ item: l.item, unit: l.unit, qty: l.qty }));
  if (!items.length) return toast("No parts to price yet.");
  S.est.lookup = "busy"; S.est.busyItems = names || null; renderEstimate();
  try {
    const r = await api(`/api/plans/${S.plan.plan_id}/price_lookup`, { method: "POST", body: { items } });
    S.est.found = Object.assign(names ? (S.est.found || {}) : {}, r.found || {});   // a one-part search keeps the other picks
    S.est.foundAt = r.as_of; S.est.foundBy = r.model; S.est.open = Object.assign(S.est.open || {}, ...Object.keys(r.found || {}).map(k => ({ [k]: true })));
    const errs = Object.entries(r.errors || {});
    S.est.lookup = errs.length ? `${errs.length} part${errs.length > 1 ? "s" : ""} could not be priced (${errs.slice(0, 2).map(([k, v]) => k + ": " + v).join("; ")}). Keep the price shown, or type one in.` : "";
  } catch (e) { S.est.lookup = String(e.message || e); }
  S.est.busyItems = null; renderEstimate(); scheduleSave();
}
function bindEst() {
  const ok = $("#estOk"); if (ok) ok.onchange = () => { S.est.confirmed = ok.checked; renderEstimate(); scheduleSave(); };
  const bp = $("#btnPrices"); if (bp) bp.onclick = () => lookupPrices();
  document.querySelectorAll("#estBody [data-find]").forEach(b => { b.onclick = () => lookupPrices([b.dataset.find]); });
  document.querySelectorAll("#estBody [data-rmx]").forEach(b => { b.onclick = () => {
    const it = b.dataset.rmx; S.est.extras = (S.est.extras || []).filter(x => x.item !== it);
    if (S.est.found) delete S.est.found[it]; if (S.est.prices) delete S.est.prices[it]; renderEstimate(); scheduleSave(); }; });
  const apAdd = $("#apAdd");
  if (apAdd) {
    const add = () => {
      const name = $("#apName").value.trim().replace(/\s+/g, " "), q = Math.max(0.1, +$("#apQty").value || 1), u = $("#apUnit").value;
      if (!name) return toast("Type the part name first.", true);
      S.est.extras = S.est.extras || [];
      const have = S.est.extras.find(x => x.item.toLowerCase() === name.toLowerCase());
      if (have) { have.qty += q; } else S.est.extras.push({ item: name, qty: q, unit: u });
      renderEstimate(); scheduleSave();
      toast("Added. Type its price in the box, or press find options to try the web.");
    };
    apAdd.onclick = add; $("#apName").onkeydown = ev => { if (ev.key === "Enter") add(); };
  }
  document.querySelectorAll("#estBody [data-opts]").forEach(b => { b.onclick = () => { S.est.open = S.est.open || {}; S.est.open[b.dataset.opts] = !S.est.open[b.dataset.opts]; renderEstimate(); scheduleSave(); }; });
  document.querySelectorAll("#estBody [data-pick]").forEach(c => {
    const choose = ev => {
      if (ev.target.tagName === "A") return;   // "view page" opens the listing, it does not pick it
      const item = c.dataset.pick, f = S.est.found[item]; if (!f || !f.options) return;
      f.sel = +c.dataset.i; delete S.est.prices[item];   // the pick replaces any price typed earlier
      renderEstimate(); scheduleSave();
    };
    c.onclick = choose; c.onkeydown = ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); choose(ev); } };
  });
  document.querySelectorAll("#estBody [data-set]").forEach(i => { i.onchange = () => { S.est[i.dataset.set] = Math.max(0, +i.value || 0); renderEstimate(); scheduleSave(); }; });
  document.querySelectorAll("#estBody [data-price]").forEach(i => { i.onchange = () => { if (i.value === "") delete S.est.prices[i.dataset.price]; else S.est.prices[i.dataset.price] = Math.max(0, +i.value || 0); renderEstimate(); scheduleSave(); }; });
  const b = $("#btnEstCsv"); if (b) b.onclick = exportEstimate;
}
function exportEstimate() {
  if (!S.plan || !S.est || !S.prices) return;
  const m = estimateModel(), rows = [["Section", "Item", "Qty", "Unit", "Unit price", "Total"]];
  for (const l of m.lines) rows.push(["Material", l.item + (l.pick && !l.mine ? ` (${l.pick.name}, ${l.pick.store})` : ""), l.unit === "ft" ? Math.round(l.qty) : l.qty, l.unit, l.price ?? "", l.ext == null ? "" : l.ext.toFixed(2)]);
  rows.push(["", "Materials subtotal", "", "", "", m.mat.toFixed(2)], ["", `Markup ${S.est.markup}%`, "", "", "", m.markup.toFixed(2)]);
  for (const h of m.hours) rows.push(["Labor", h.label, h.n, "x " + h.each.toFixed(2) + " h", "", h.total.toFixed(1) + " h"]);
  rows.push(["", `Labor ${m.labHrs.toFixed(1)} h x $${S.est.rate}`, "", "", "", m.labor.toFixed(2)], ["", `Contingency ${S.est.contingency}%`, "", "", "", m.cont.toFixed(2)], ["", "ESTIMATED TOTAL", "", "", "", m.total.toFixed(2)]);
  rows.push([], ["Note", `Prices as of ${S.prices.as_of}. Planning estimate, not a bid. ${S.prices.disclaimer}`]);
  download(`${baseName()}_estimate.csv`, csv(rows));
}

function renderEditor() {
  const body = $("#editorBody"), ds = selDets(), r = S.rej.find(x => x.id === S.selRej);
  if (ds.length > 1) {
    body.className = "";
    body.innerHTML = `<div class="field"><span><strong>${ds.length}</strong> selected</span></div>
      <div class="field"><span>Change all to</span><select id="edType"><option value="">choose…</option>${typeOptions("")}</select></div>
      <div class="btns"><button id="edDelete" class="danger">Remove all ${ds.length}</button></div>`;
    $("#edType").onchange = e => { if (e.target.value) relabel(e.target.value); };
    $("#edDelete").onclick = delSel;
  } else if (ds.length === 1) {
    const d = ds[0];
    body.className = "";
    body.innerHTML = `<div class="field"><span class="cmp">${cropThumb(d)}<small>found</small>${refImg(d.label) ? "<b>→</b>" + refImg(d.label) + "<small>legend</small>" : ""}</span></div>
      <div class="field"><span>Type</span><select id="edType">${typeOptions(d.label)}</select></div>
      <div class="field"><span>Confidence</span><span>${(+d.confidence).toFixed(2)} · ${esc(d.source)}</span></div>
      <div class="field"><span>Status</span><span>${esc(d.status)}</span></div>
      ${d.flags.map(f => `<span class="flagtag">${esc(f)}</span>`).join("")}
      ${d.reason ? `<div class="hint">${esc(d.reason)}</div>` : ""}
      <div class="btns"><button id="edDismiss" ${d.flags.length ? "" : "disabled"}>Dismiss flags</button><button id="edDelete" class="danger">Remove</button></div>`;
    $("#edType").onchange = e => relabel(e.target.value);
    $("#edDismiss").onclick = dismissFlags; $("#edDelete").onclick = delSel;
  } else if (r) {
    body.className = "";
    body.innerHTML = `<div class="field"><span>Rejected as</span><span>${esc(symOf(r.label) ? symOf(r.label).label : r.label)}</span></div>
      <div class="hint">${esc(r.reason || "Rejected by an automatic rule")}</div>
      <div class="btns"><button id="edRestore">Restore as detection</button></div>`;
    $("#edRestore").onclick = restoreRejected;
  } else {
    body.className = "hint";
    body.textContent = "Click a box on the plan (Shift+click adds more, or use Select several). A popup appears on the symbol to change its type or remove it.";
  }
}

/* floating editor that sits on the selected symbol */
function renderPopup() {
  const pop = $("#pop"); if (!pop) return;
  const ds = S.cfg && S.plan ? selDets() : [], r = S.rej.find(x => x.id === S.selRej);
  const target = ds.length ? ds : (r && $("#showRejected").checked ? [r] : []);
  if (!target.length) { pop.hidden = true; return; }
  if (pop.dataset.key !== S.sels.join(",") + "|" + (S.selRej || "") + "|" + target.map(d => d.label + d.flags.length).join(",")) {
    pop.dataset.key = S.sels.join(",") + "|" + (S.selRej || "") + "|" + target.map(d => d.label + d.flags.length).join(",");
    if (ds.length) {
      const cur = ds.length === 1 ? ds[0].label : null;
      const head = ds.length === 1 ? `${cropThumb(ds[0], 40, 34)} <span>Found: ${esc((symOf(ds[0].label) || {}).label || ds[0].label)}. Change to:</span>` : `${ds.length} selected. Change all to:`;
      const flagged = ds.some(d => d.flags.length);
      pop.innerHTML = `<div class="ph ${ds.length === 1 ? "withcrop" : ""}">${head}</div><div class="pt">` + pointSyms().map((s, i) =>
        `<button data-t="${s.id}" class="${s.id === cur ? "cur" : ""}" title="${esc(s.label)} (key ${i + 1})"><span class="sw" style="background:${s.color}"></span>${refImg(s.id)}${i + 1} ${esc(s.label)}</button>`).join("") + `</div>
        <div class="pa"><button data-a="del" class="danger">Remove</button>${flagged ? '<button data-a="keep">Keep ✓ next</button>' : ""}<button data-a="close">Close</button></div>`;
      pop.querySelectorAll("[data-t]").forEach(b => { b.onclick = () => relabel(b.dataset.t); });
      pop.querySelector('[data-a="del"]').onclick = delSel;
      const k = pop.querySelector('[data-a="keep"]'); if (k) k.onclick = keepAndNext;
      pop.querySelector('[data-a="close"]').onclick = clearSel;
    } else {
      pop.innerHTML = `<div class="ph">Rejected: ${esc(r.reason || "automatic rule")}</div><div class="pa"><button data-a="restore">Restore as detection</button><button data-a="close">Close</button></div>`;
      pop.querySelector('[data-a="restore"]').onclick = restoreRejected;
      pop.querySelector('[data-a="close"]').onclick = clearSel;
    }
  }
  const boxes = target.map(d => d.bbox);
  const x0 = Math.min(...boxes.map(b => b[0])), y0 = Math.min(...boxes.map(b => b[1]));
  const x1 = Math.max(...boxes.map(b => b[0] + b[2])), y1 = Math.max(...boxes.map(b => b[1] + b[3]));
  const v = S.view, sv = $("#svg"), wrap = $("#viewerWrap");
  const off = sv.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
  pop.hidden = false;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let px = (x0 + (x1 - x0) / 2) * v.k + v.x - pw / 2, py = y1 * v.k + v.y + 10;
  if (py + ph > sv.clientHeight - 4) py = y0 * v.k + v.y - ph - 10;
  px = Math.max(4, Math.min(px, sv.clientWidth - pw - 4)); py = Math.max(4, Math.min(py, sv.clientHeight - ph - 4));
  pop.style.left = px + "px"; pop.style.top = (py + off) + "px";
}

function renderFlags() {
  const box = $("#flagList"); box.replaceChildren();
  const list = S.dets.filter(d => d.status !== "deleted" && d.flags.length).sort((a, b) => a.confidence - b.confidence);
  $("#flagCount").textContent = list.length ? `(${list.length})` : "";
  if (!list.length) { box.innerHTML = '<p class="hint">Nothing flagged.</p>'; return; }
  for (const d of list) {
    const row = document.createElement("div"); row.className = "item";
    row.innerHTML = `<div class="frow">${cropThumb(d, 40, 34)}${refImg(d.label)}<div><strong>${esc(symOf(d.label) ? symOf(d.label).label : d.label)}</strong><br><span class="why">${esc(d.flags[0])}</span></div></div>`;
    row.onclick = () => { S.sels = [d.id]; S.selRej = null; focusOn(d); renderAll(); };
    box.appendChild(row);
  }
}

function renderMeta() {
  const m = S.meta; let t = "";
  if (m) {
    t = `${m.mode} · ${m.candidates_after_nms} candidates · ${S.rej.length} rejected · ${m.seconds}s`;
    if (m.vlm && m.vlm.calls) t += ` · VLM ${m.vlm.calls} calls (${m.vlm.tokens_in} in / ${m.vlm.tokens_out} out tokens, ${m.vlm.errors} errors)`;
  }
  $("#metaLine").textContent = t;
  // Only matters when this plan has BOTH ceiling and recessed lights (the RCLT text check). Otherwise stay quiet.
  const needs = symList().some(s => s.id === "recessed") && symList().some(s => s.id === "ceiling_light");
  const warn = needs && m && (m.log || []).find(l => /OCR unavailable/.test(l));
  const w = $("#warnLine"); w.hidden = !warn;
  if (warn) w.textContent = "Optional: install tesseract so recessed vs ceiling lights can be double-checked (Windows: winget install UB-Mannheim.TesseractOCR, then restart). Everything else works without it.";
}

/* ---------- review one type: every hit of that type as a card, so a wrong one can be removed ---------- */
const reviewOrder = id => S.dets.filter(d => d.status !== "deleted" && d.label === id)
  .sort((a, b) => a.confidence - b.confidence || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);   // least sure first
function ctxThumb(d, size = 84) {   // the hit plus its surroundings, with the hit outlined
  const [x, y, w, h] = d.bbox, side = Math.max(w, h) + 2 * Math.max(28, Math.max(w, h)), k = size / side;
  const ox = x + w / 2 - side / 2, oy = y + h / 2 - side / 2;
  return `<span class="ctx" style="width:${size}px;height:${size}px;background-image:url('${S.plan.image_url}');background-size:${Math.round(S.plan.width * k)}px ${Math.round(S.plan.height * k)}px;background-position:${-Math.round(ox * k)}px ${-Math.round(oy * k)}px"><i style="left:${Math.round((x - ox) * k)}px;top:${Math.round((y - oy) * k)}px;width:${Math.max(6, Math.round(w * k))}px;height:${Math.max(6, Math.round(h * k))}px"></i></span>`;
}
function renderReview() {
  const box = $("#reviewBox"); if (!box) return;
  const id = S.reviewType;
  if (!id || !S.plan) { box.innerHTML = ""; return; }
  const list = reviewOrder(id), sy = symOf(id) || { label: id };
  if (!list.length) { box.innerHTML = ""; S.reviewType = null; return; }
  box.innerHTML = `<div class="rvhead"><b>${list.length} × ${esc(sy.label)}</b> <button class="x" id="rvClose" title="Close">✕</button></div>
    <p class="hint">Least sure first. Click a card to jump to it on the plan (it is numbered there too). Remove any that aren't real.</p>
    <div class="rvlist">${list.map((d, i) => `
      <div class="rv ${S.sels.includes(d.id) ? "on" : ""}" data-rv="${d.id}">
        <span class="rvn">${i + 1}</span>${ctxThumb(d)}
        <div class="rvinfo"><b>#${i + 1}</b> <span class="rvconf ${d.confidence < 0.8 ? "low" : ""}">${Math.round(d.confidence * 100)}% sure</span>
          ${d.flags.length ? `<div class="why">${esc(d.flags[0])}</div>` : ""}
          <div class="rvbtns"><button data-rvshow="${d.id}">Show</button><button class="danger" data-rvdel="${d.id}">Remove</button>
          <select data-rvtype="${d.id}" title="Change what this is"><option value="">Change type…</option>${pointSyms().filter(x => x.id !== id).map(x => `<option value="${x.id}">${esc(x.label)}</option>`).join("")}</select></div>
        </div>
      </div>`).join("")}</div>`;
  $("#rvClose").onclick = () => { S.reviewType = null; renderAll(); };
  const show = did => { const d = byId(did); if (!d) return; S.sels = [d.id]; S.selRej = null; focusOn(d); renderAll(); };
  box.querySelectorAll("[data-rv]").forEach(c => { c.onclick = ev => { if (ev.target.closest("button,select")) return; show(c.dataset.rv); }; });
  box.querySelectorAll("[data-rvshow]").forEach(b => { b.onclick = () => show(b.dataset.rvshow); });
  box.querySelectorAll("[data-rvdel]").forEach(b => { b.onclick = () => {
    const d = byId(b.dataset.rvdel); if (!d) return;
    mutate(() => { d.status = "deleted"; S.sels = S.sels.filter(x => x !== d.id); });
    toast("Removed. Ctrl+Z to undo."); }; });
  box.querySelectorAll("[data-rvtype]").forEach(sel => { sel.onchange = () => {
    const d = byId(sel.dataset.rvtype); if (!d || !sel.value) return; const nid = sel.value;
    mutate(() => { d.label = nid; d.flags = []; d.status = d.status === "added" ? "added" : (nid === d.orig_label ? "auto" : "corrected"); S.sels = S.sels.filter(x => x !== d.id); });
    toast(`Changed to ${(symOf(nid) || {}).label}. Ctrl+Z to undo.`); }; });
}
function renderAll() {
  if (!S.cfg) return;
  renderBoxes(); renderLegend(); renderExclude(); renderTotals(); renderReview(); renderWires(); renderEditor(); renderFlags(); renderMeta(); renderPopup(); renderEstimate();
}

/* ---------- export ---------- */
const csv = rows => rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
function download(name, text, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const baseName = () => (S.plan ? S.plan.name : "plan").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_");
function exportCounts() {
  if (!S.plan) return;
  const c = counts(), rows = [["Symbol", "Count", "Auto-detected", "Changed by reviewer"]];
  for (const s of symList()) {
    if (s.line) { const st = wireStats(s.id); rows.push([s.label + " (runs)", st.runs, S.autoWires[s.id] || 0, st.runs - (S.autoWires[s.id] || 0)]); if (st.ft != null) rows.push([s.label + " (feet, measured)", st.ft.toFixed(1), "", ""]); continue; }
    rows.push([s.label, c[s.id] || 0, S.auto[s.id] || 0, (c[s.id] || 0) - (S.auto[s.id] || 0)]);
  }
  download(`${baseName()}_counts.csv`, csv(rows));
}
function exportMaterials() {
  if (!S.plan) return;
  const c = counts(), m = {};
  for (const s of symList()) {
    const n = s.line ? (S.scale ? wireStats(s.id).ft * (1 + (S.est ? S.est.waste : 10) / 100) + wireStats(s.id).runs * (S.est ? S.est.vertical : 8) : 0) : (c[s.id] || 0);
    for (const [item, q] of s.materials || []) m[item] = (m[item] || 0) + n * q;
  }
  const rows = [["Item", "Quantity"], ...Object.entries(m).filter(([, q]) => q > 0).sort((a, b) => a[0].localeCompare(b[0]))];
  download(`${baseName()}_materials.csv`, csv(rows));
}
function exportJson() {
  if (!S.plan) return;
  download(`${baseName()}_detections.json`, JSON.stringify({ plan: S.plan.name, width: S.plan.width, height: S.plan.height, counts: counts(), auto: S.auto, detections: S.dets, wires: S.wires, scale: S.scale, exclude: S.exclude, meta: S.meta }, null, 2), "application/json");
}

/* ---------- wiring ---------- */
document.querySelectorAll("#toolbar [data-mode]").forEach(b => { b.onclick = () => setMode(b.dataset.mode); });
$("#btnFit").onclick = fit;
$("#btnWireClear").onclick = () => { if (!S.wires.length) return; if (confirm("Remove all wire runs?")) { S.wires = []; S.selWire = null; renderAll(); scheduleSave(); } };
$("#scaleApply").onclick = () => {
  const ft = parseFloat($("#scaleFt").value);
  if (!(ft > 0) || !S.scaleLen) return toast("Type the real length in feet first", true);
  S.scale = S.scaleLen / ft; S.scaleLen = null; $("#scaleForm").hidden = true;
  toast(`Scale set: ${fmt(S.scale, 1)} px per ft`); renderAll(); scheduleSave();
};
$("#scaleFt").addEventListener("keydown", e => { if (e.key === "Enter") $("#scaleApply").click(); });
$("#btnReview").onclick = nextFlag;
$("#btnSelFlag").onclick = selectFlagged;
$("#btnUndo").onclick = undo;
$("#showRejected").onchange = () => { renderBoxes(); renderPopup(); };
$("#btnExclude").onclick = () => { if (!S.plan) return toast("Load a plan first", true); setMode("exclude"); };
$("#btnRun").onclick = run;
$("#btnAutoLegend").onclick = () => autoLegend(false);
$("#btnSample").onclick = loadSample;
$("#btnCsv").onclick = exportCounts;
$("#btnMat").onclick = exportMaterials;
$("#btnJson").onclick = exportJson;
$("#thr").oninput = e => { $("#thrVal").textContent = (+e.target.value).toFixed(2); };
$("#fileInput").onchange = e => { const f = e.target.files[0]; if (f) upload(f); e.target.value = ""; };

addEventListener("keydown", e => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); delSel(); }
  else if (e.key === "Enter" && S.mode === "wire" && S.wireDraft) { e.preventDefault(); saveDraft(null); }
  else if (e.key === "Escape") { setMode("select"); clearSel(); $("#scaleForm").hidden = true; }
  else if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
  else if (e.key === "f" || e.key === "F") fit();
  else if (/^[1-9]$/.test(e.key) && S.sels.length && pointSyms()[+e.key - 1]) relabel(pointSyms()[+e.key - 1].id);
  else if (e.key === "Enter" && S.sels.length) keepAndNext();
  else if (e.key === "n" || e.key === "N") nextFlag();
});
addEventListener("resize", () => { if (S.plan) applyView(); });

(async function init() {
  S.cfg = await api("/api/config");
  try { S.prices = await api("/api/prices"); } catch (_) { S.prices = null; }
  if (!S.prices || !S.prices.labor) {   // price file missing on the server: still build an estimate, prices come from the model lookup or typing
    S.prices = { as_of: "", items: {}, disclaimer: "No bundled price list was found, so prices come from the model lookup or what you type.",
      labor: { rate_per_hour: 85, material_markup_pct: 15, contingency_pct: 10, wire_waste_pct: 10, vertical_ft_per_run: 8, wire_hours_per_100ft: 2, default_hours_each: 0.5, hours_each: {},
        assumptions_note: "Labor hours per device, markup and contingency are assumptions you can change.", rate_source: "https://housecallpro.com/resources/electrician-hourly-rate/", rate_note: "typical electrician rates" } };
  }
  fillAddType();
  $("#useVlm").disabled = !S.cfg.hasKey;
  $("#btnAutoLegend").disabled = !S.cfg.hasKey;
  $("#autoHint").textContent = S.cfg.hasKey ? "Runs automatically when you upload. Press again to re-read the legend (replaces the symbol list and crops)." : "Needs MODEL_API_KEY set before starting the server (see README). Until then, draw each symbol by hand.";
  $("#vlmHint").textContent = S.cfg.hasKey
    ? `Sends each hit plus the legend crops to ${S.cfg.model} and drops anything that is not an electrical symbol. Costs a little per plan.`
    : "Off: set MODEL_API_KEY before starting the server to enable this.";
  if (!S.cfg.samples.length) $("#btnSample").hidden = true;
  renderAll();
  const pid = new URLSearchParams(location.search).get("plan");   // reopen a saved plan: /?plan=<id>
  if (pid) { try { loadPlan(await api(`/api/plans/${pid}`)); } catch (e) { toast(e.message, true); } }
})().catch(e => toast(e.message, true));