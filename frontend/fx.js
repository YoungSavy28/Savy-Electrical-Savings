/* fx.js — animation layer for Savy Electricals Plan Takeoff.
   Watches the DOM that app.js already updates, so app.js needs zero changes.
   Three.js is OPTIONAL: if three.module.js is missing/fails, everything
   else (HUD, panel reveal, drag & drop, scan) still works. */

const $ = s => document.querySelector(s);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- Load Three.js optionally (never breaks the page) ---------- */
let THREE = null;
try {
  THREE = await import("./three.module.js");
} catch (e) {
  console.warn("Three.js not loaded — continuing without the 3D background:", e);
}

/* ---------- Three.js: animated electrical circuit / PCB scene ---------- */
(function circuit() {
  const cv = $("#three-bg");
  if (!cv || reduced || !THREE) return;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: true });
  } catch { return; } // WebGL unavailable → CSS blueprint background still shows

  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(55, 1, .1, 100);
  cam.position.set(0, 6, 11);
  cam.lookAt(0, 0, 0);

  const group = new THREE.Group();
  scene.add(group);

  const ACCENT = 0x38bdf8, VOLT = 0xfbbf24;
  const pulses = [];
  const traceMat = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: .45 });
  const nodeGeo = new THREE.SphereGeometry(.09, 10, 10);
  const nodeMat = new THREE.MeshBasicMaterial({ color: VOLT });

  for (let i = 0; i < 46; i++) {
    let x = (Math.random() - .5) * 16, z = (Math.random() - .5) * 10;
    const pts = [new THREE.Vector3(x, 0, z)];
    for (let s = 0; s < 4; s++) {
      if (Math.random() < .5) x += (Math.random() - .5) * 5; else z += (Math.random() - .5) * 4;
      pts.push(new THREE.Vector3(x, 0, z));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), traceMat));

    const node = new THREE.Mesh(nodeGeo, nodeMat);
    node.position.copy(pts[pts.length - 1]);
    group.add(node);

    const p = new THREE.Mesh(
      new THREE.SphereGeometry(.14, 10, 10),
      new THREE.MeshBasicMaterial({ color: Math.random() < .3 ? VOLT : ACCENT })
    );
    group.add(p);
    pulses.push({ p, pts, speed: .08 + Math.random() * .18 });
  }

  const grid = new THREE.GridHelper(24, 48, 0x1d4ed8, 0x16324f);
  grid.material.transparent = true;
  grid.material.opacity = .35;
  grid.position.y = -.05;
  group.add(grid);
  group.rotation.x = .15;

  let mx = 0, my = 0;
  addEventListener("pointermove", e => {
    mx = e.clientX / innerWidth - .5;
    my = e.clientY / innerHeight - .5;
  });

  function resize() {
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(cv);
  resize();

  const clock = new THREE.Clock();
  (function loop() {
    requestAnimationFrame(loop);
    const t = clock.getElapsedTime();
    for (const { p, pts, speed } of pulses) {
      const u = (t * speed) % 1, seg = u * (pts.length - 1), i = Math.floor(seg);
      p.position.lerpVectors(pts[i], pts[Math.min(i + 1, pts.length - 1)], seg - i);
      p.position.y = .12 + Math.sin(t * 4 + i) * .03;
    }
    group.rotation.y += (mx * .5 - group.rotation.y) * .04;        // mouse parallax
    group.rotation.x += (.15 + my * .3 - group.rotation.x) * .04;
    renderer.render(scene, cam);
  })();
})();

/* ---------- Animated counters + HUD ---------- */
function countUp(el, to) {
  if (!el) return;
  const from = parseInt(el.textContent) || 0;
  if (from === to || reduced) { el.textContent = to; return; }
  const t0 = performance.now();
  (function step(t) {
    const k = Math.min((t - t0) / 600, 1), e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}

function syncHud() {
  const totalEl = document.querySelector("#totals tr.total td:nth-child(2)");
  const total = totalEl ? parseInt(totalEl.textContent) || 0 : 0;
  countUp($("#fxTotal"), total);

  const fl = ($("#flagCount").textContent.match(/\d+/) || [0])[0];
  countUp($("#fxFlagged"), +fl);

  const rows = document.querySelectorAll("#legendRows .lrow");
  const ready = document.querySelectorAll("#legendRows .lrow:not(.missing)").length;
  $("#fxTypes").textContent = rows.length ? `${ready}/${rows.length}` : "–";

  $("#fxProgress").style.width = (rows.length && !ready ? 15 : total ? 100 : 8) + "%";
}
new MutationObserver(syncHud).observe($("#totals"), { childList: true, subtree: true, characterData: true });
new MutationObserver(syncHud).observe($("#legendRows"), { childList: true, subtree: true });
new MutationObserver(syncHud).observe($("#flagCount"), { childList: true, characterData: true });

/* ---------- Busy overlay = laser scan + rotating sub-status ---------- */
const STEPS = ["Tracing circuits…", "Matching legend symbols…", "Counting devices…", "Flagging the uncertain ones…"];
let stepTimer = null;
new MutationObserver(() => {
  const on = !$("#busy").hidden;
  $("#scan").hidden = !on;
  document.body.classList.toggle("scanning", on);
  $("#fxStatus").textContent = on ? "Analyzing…" : (!$("#empty").hidden ? "Idle" : "Ready ✓");
  clearInterval(stepTimer);
  if (on) {
    let i = 0;
    $("#busySub").textContent = STEPS[0];
    stepTimer = setInterval(() => { $("#busySub").textContent = STEPS[++i % STEPS.length]; }, 2600);
  }
}).observe($("#busy"), { attributes: true, attributeFilter: ["hidden"] });

new MutationObserver(() => {
  const hasPlan = $("#empty").hidden;
  document.body.classList.toggle("has-plan", hasPlan);
  if (hasPlan && $("#busy").hidden) $("#fxStatus").textContent = "Plan loaded";
}).observe($("#empty"), { attributes: true, attributeFilter: ["hidden"] });

/* ---------- Detection boxes pop in with stagger ---------- */
new MutationObserver(muts => {
  if (reduced) return;
  muts.forEach(m => m.addedNodes.forEach((n, i) => {
    if (n.classList && n.classList.contains("box")) {
      n.style.animationDelay = Math.min(i * 12, 500) + "ms";
      n.classList.add("pop");
    }
  }));
}).observe($("#boxes"), { childList: true });

/* ---------- Drag & drop a plan onto the viewer ---------- */
const wrap = $("#viewerWrap");
["dragenter", "dragover"].forEach(ev => wrap.addEventListener(ev, e => {
  e.preventDefault();
  wrap.classList.add("dropping");
}));
["dragleave", "drop"].forEach(ev => wrap.addEventListener(ev, e => {
  e.preventDefault();
  wrap.classList.remove("dropping");
}));
wrap.addEventListener("drop", e => {
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const input = $("#fileInput"), dt = new DataTransfer();
  dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event("change")); // app.js upload() takes it from here
});

/* ---------- Panel sections reveal (with failsafe) ---------- */
const io = new IntersectionObserver(entries => entries.forEach(e => {
  if (e.isIntersecting) e.target.classList.add("in");
}), { threshold: .08 });
document.querySelectorAll("#panel section").forEach((s, i) => {
  s.style.transitionDelay = (i * 60) + "ms";
  io.observe(s);
});
/* Failsafe: if the observer never fires, force the panel visible after 1s.
   The panel contains the core workflow — it must NEVER stay hidden. */
setTimeout(() => {
  document.querySelectorAll("#panel section").forEach(s => s.classList.add("in"));
}, 1000);

syncHud();