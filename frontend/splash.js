/* splash.js — wires connect -> explode -> reveal app.
   Standalone (no module/imports) so it always dismisses,
   even if Three.js fails to load. */
(() => {
  const s = document.getElementById("splash");
  if (!s) return;

  // Build the 16 explosion particles
  const burst = document.getElementById("sparkBurst");
  if (burst) {
    for (let i = 0; i < 16; i++) {
      const p = document.createElement("i");
      p.style.setProperty("--a", (i * 22.5) + "deg");
      p.style.setProperty("--d", (60 + Math.random() * 90) + "px");
      burst.appendChild(p);
    }
  }

  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    s.classList.add("done");
    setTimeout(() => s.remove(), 650);
  };

  document.getElementById("splashSkip").addEventListener("click", dismiss);
  s.addEventListener("click", dismiss);

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  setTimeout(dismiss, reduced ? 400 : 2500);
  setTimeout(dismiss, 4500); // hard safety net — never trap the user
})();
// Failsafe: reveal the right-hand panel even if fx.js / Three.js fails
setTimeout(() => {
  document.querySelectorAll("#panel section")
    .forEach(s => s.classList.add("in"));
}, 600);
