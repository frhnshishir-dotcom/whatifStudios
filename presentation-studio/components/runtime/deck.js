/* Presentation Studio runtime. Classic script (works from file://). No dependencies.
   Keys: →/Space/PgDn next · ←/PgUp prev · Home/End · S presenter notes · F fullscreen · B blackout
   URL: #3 opens slide 3 · ?static disables motion (QA capture) · print = all slides, one per page. */
(() => {
  const deck = document.getElementById("deck");
  const slides = [...deck.querySelectorAll(".slide")];
  const qs = new URLSearchParams(location.search);
  const STATIC = qs.has("static");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const css = getComputedStyle(document.documentElement);
  const DUR = parseFloat(css.getPropertyValue("--dur")) || 900;
  const STAGGER = parseFloat(css.getPropertyValue("--stagger")) || 100;
  const EASE = css.getPropertyValue("--ease").trim() || "cubic-bezier(.16,1,.3,1)";
  if (STATIC) document.body.classList.add("static");
  let cur = -1, busy = false, t0 = null;
  const viewers = new Map();

  /* ---------- fit 1920x1080 stage to the window */
  function fit() {
    const s = Math.min(innerWidth / 1920, innerHeight / 1080);
    deck.style.transform = `scale(${s})`;
  }
  addEventListener("resize", fit); fit();

  /* ---------- entrance builds */
  const ENTER = {
    rise: [{ opacity: 0, transform: "translate3d(0,28px,0)", filter: "blur(8px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }],
    fade: [{ opacity: 0 }, { opacity: 1 }],
    mask: [{ opacity: 0, clipPath: "inset(0 0 100% 0)", transform: "translateY(12px)" }, { opacity: 1, clipPath: "inset(0 0 0 0)", transform: "none" }],
    scale: [{ opacity: 0, transform: "scale(.94)" }, { opacity: 1, transform: "none" }],
  };
  function prime(slide, skipKeys) {
    slide.querySelectorAll("[data-order]").forEach(el => {
      el.getAnimations().forEach(a => a.cancel());
      if (skipKeys && skipKeys.has(el.dataset.key)) { el.style.opacity = ""; return; }
      el.style.opacity = STATIC ? "" : "0";
    });
    slide.classList.remove("play");
  }
  function build(slide, skipKeys) {
    const kind = reduce ? "fade" : (slide.dataset.motion || "rise");
    if (kind === "none" || STATIC) { slide.querySelectorAll("[data-order]").forEach(e => e.style.opacity = ""); slide.classList.add("play"); countUp(slide, true); return; }
    const frames = ENTER[kind] || ENTER.rise;
    slide.querySelectorAll("[data-order]").forEach(el => {
      if (skipKeys && skipKeys.has(el.dataset.key)) return;
      const d = (parseInt(el.dataset.order, 10) - 1) * STAGGER * 1.6 + 120;
      el.style.opacity = "";
      el.animate(frames, { duration: DUR, delay: d, easing: EASE, fill: "backwards" });
    });
    setTimeout(() => slide.classList.add("play"), 150);
    countUp(slide, false);
  }

  /* ---------- number count-up: "71.2%" "5.5 bn" "$1,200" */
  function countUp(slide, instant) {
    slide.querySelectorAll("[data-count]").forEach(el => {
      const p = el.querySelector("p, li, span") || el;
      const target = p.dataset.final || p.textContent;
      p.dataset.final = target;
      const m = target.match(/^(\D*)([\d,]*\.?\d+)(.*)$/);
      if (!m || instant || reduce) { p.textContent = target; return; }
      const [, pre, num, post] = m;
      const val = parseFloat(num.replace(/,/g, "")), dec = (num.split(".")[1] || "").length, comma = num.includes(",");
      const start = performance.now(), dur = 1400, delay = (parseInt(el.dataset.order || 1, 10) - 1) * STAGGER * 1.6 + 200;
      const fmt = v => { let s = v.toFixed(dec); if (comma) s = Number(s).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }); return pre + s + post; };
      p.textContent = fmt(0);
      const step = now => {
        const t = Math.min(1, Math.max(0, (now - start - delay) / dur));
        p.textContent = fmt(val * (1 - Math.pow(1 - t, 4)));
        if (t < 1 && slides[cur] === slide) requestAnimationFrame(step); else p.textContent = target;
      };
      requestAnimationFrame(step);
    });
  }

  /* ---------- 3D viewers (lazy, only the active slide renders) */
  function videosFor(slide, on) {
    slide.querySelectorAll("video").forEach(v => {
      if (on && !STATIC) { try { v.currentTime = 0; } catch (e) {} v.play().catch(() => {}); } else v.pause();
    });
  }
  function viewersFor(slide, on) {
    videosFor(slide, on);
    slide.querySelectorAll(".viewer").forEach(el => {
      if (!window.StudioViewer) return;
      let v = viewers.get(el);
      if (!v && on) {
        try { v = window.StudioViewer.mount(el, JSON.parse(el.dataset.viewer)); viewers.set(el, v); el.classList.add("live"); }
        catch (e) { console.warn("viewer failed", e); return; }
      }
      if (v) on ? (STATIC ? v.renderOnce() : v.start()) : v.stop();
    });
  }

  /* ---------- particles (opt-in per slide: "fx": "particles") */
  const fx = new Map();
  function particles(slide, on) {
    const c = slide.querySelector(".fx-particles"); if (!c) return;
    let st = fx.get(c);
    if (!st) {
      c.width = 1920; c.height = 1080;
      const col = css.getPropertyValue("--accent").trim() || "#fff";
      st = { ctx: c.getContext("2d"), col, raf: 0, p: Array.from({ length: 70 }, () => ({ x: Math.random() * 1920, y: Math.random() * 1080, r: Math.random() * 1.8 + .4, v: Math.random() * .25 + .05, a: Math.random() * .6 + .2 })) };
      fx.set(c, st);
    }
    cancelAnimationFrame(st.raf);
    if (!on || reduce || STATIC) return;
    const tick = () => {
      const { ctx, p } = st; ctx.clearRect(0, 0, 1920, 1080); ctx.fillStyle = st.col;
      for (const q of p) { q.y -= q.v; if (q.y < -5) q.y = 1085; ctx.globalAlpha = q.a; ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, 6.283); ctx.fill(); }
      st.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  /* ---------- pointer parallax on the background layer */
  if (!reduce && !STATIC) addEventListener("pointermove", e => {
    const s = slides[cur]; if (!s) return;
    const x = e.clientX / innerWidth - .5, y = e.clientY / innerHeight - .5;
    const live = s.querySelector(".bg-live"); if (live) live.style.translate = `${x * -24}px ${y * -16}px`;
  });

  /* ---------- transitions */
  const T = {
    fade: { in: [{ opacity: 0 }, { opacity: 1 }], out: [{ opacity: 1 }, { opacity: 0 }] },
    rise: { in: [{ opacity: 0, transform: "translateY(60px)", filter: "blur(10px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], out: [{ opacity: 1 }, { opacity: 0, transform: "scale(.98)" }] },
    zoom: { in: [{ opacity: 0, transform: "scale(1.12)" }, { opacity: 1, transform: "none" }], out: [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.9)" }] },
    wipe: { in: [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], out: [{ opacity: 1 }, { opacity: .6 }] },
    push: { in: [{ transform: "translateX(100%)" }, { transform: "none" }], out: [{ transform: "none" }, { transform: "translateX(-35%)", opacity: .4 }] },
    iris: { in: [{ clipPath: "circle(0% at 50% 50%)" }, { clipPath: "circle(75% at 50% 50%)" }], out: [{ opacity: 1, transform: "none" }, { opacity: .3, transform: "scale(.96)" }] },
    shutter: { in: [{ clipPath: "inset(50% 0 50% 0)" }, { clipPath: "inset(0 0 0 0)" }], out: [{ opacity: 1 }, { opacity: .2 }] },
    flip: { in: [{ transform: "perspective(2400px) rotateY(-75deg) translateZ(-200px)", opacity: 0 }, { transform: "perspective(2400px) rotateY(0) translateZ(0)", opacity: 1 }], out: [{ transform: "perspective(2400px) rotateY(0)", opacity: 1 }, { transform: "perspective(2400px) rotateY(75deg) translateZ(-200px)", opacity: 0 }] },
    cube: { in: [{ transform: "perspective(2400px) translateX(50%) rotateY(-90deg) translateX(50%)" }, { transform: "perspective(2400px) translateX(0) rotateY(0) translateX(0)" }], out: [{ transform: "perspective(2400px) translateX(0) rotateY(0) translateX(0)" }, { transform: "perspective(2400px) translateX(-50%) rotateY(90deg) translateX(-50%)" }] },
    vortex: { in: [{ opacity: 0, transform: "rotate(-12deg) scale(1.6)", filter: "blur(24px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], out: [{ opacity: 1, transform: "none", filter: "blur(0)" }, { opacity: 0, transform: "rotate(10deg) scale(.6)", filter: "blur(18px)" }] },
    blur: { in: [{ opacity: 0, filter: "blur(40px)", transform: "scale(1.04)" }, { opacity: 1, filter: "blur(0)", transform: "none" }], out: [{ opacity: 1, filter: "blur(0)" }, { opacity: 0, filter: "blur(30px)" }] },
  };
  const keysOf = s => new Set([...s.querySelectorAll("[data-key]")].map(e => e.dataset.key));

  function show(n, dir) {
    n = Math.max(0, Math.min(slides.length - 1, n));
    if (n === cur || busy) return;
    const from = slides[cur], to = slides[n];
    const kind = reduce ? "fade" : ((dir < 0 && from ? from.dataset.transition : to.dataset.transition) || "fade");
    const prev = cur; cur = n;
    location.hash = n + 1;
    hud();
    if (from) { viewersFor(from, false); particles(from, false); }

    if (!from || STATIC || kind === "none" || kind === "cut") {
      if (from) from.classList.remove("active");
      prime(to); to.classList.add("active"); build(to); viewersFor(to, true); particles(to, true); return;
    }
    if (kind === "morph" && document.startViewTransition) {
      const shared = [...keysOf(from)].filter(k => keysOf(to).has(k));
      const set = new Set(shared);
      const name = (s, on) => s.querySelectorAll("[data-key]").forEach(e => e.style.viewTransitionName = on && set.has(e.dataset.key) ? "k-" + e.dataset.key.replace(/[^a-z0-9_-]/gi, "") : "");
      name(from, true);
      busy = true;
      const vt = document.startViewTransition(() => { from.classList.remove("active"); name(from, false); prime(to, set); name(to, true); to.classList.add("active"); });
      vt.finished.finally(() => { name(to, false); busy = false; });
      vt.updateCallbackDone.then(() => { build(to, set); viewersFor(to, true); particles(to, true); });
      return;
    }
    const t = T[kind] || T.fade;
    busy = true;
    from.classList.remove("active"); from.classList.add("leaving");
    prime(to); to.classList.add("active");
    const opt = { duration: DUR * .9, easing: EASE, fill: "both" };
    const back = dir < 0 && kind === "push";
    const inF = back ? [{ transform: "translateX(-100%)" }, { transform: "none" }] : t.in;
    const a = to.animate(inF, opt); from.animate(t.out, opt);
    let done = false;
    const finish = () => { if (done) return; done = true; from.classList.remove("leaving"); from.getAnimations().forEach(x => x.cancel()); a.cancel(); busy = false; };
    a.finished.then(finish, finish); setTimeout(finish, DUR * 2 + 400);
    try { build(to); viewersFor(to, true); particles(to, true); } catch (e) { console.warn(e); }
  }

  /* ---------- HUD + presenter */
  const pres = document.querySelector(".presenter");
  function hud() {
    const bar = document.querySelector(".progress i"); if (bar) bar.style.width = ((cur + 1) / slides.length * 100) + "%";
    const c = document.querySelector(".count"); if (c) c.textContent = `${String(cur + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}`;
    if (pres && !pres.hidden) {
      pres.querySelector(".p-notes").textContent = slides[cur].querySelector(".notes")?.textContent || "(no notes)";
      pres.querySelector(".p-pos").textContent = `${cur + 1}/${slides.length}`;
      pres.querySelector(".p-next").textContent = slides[cur + 1] ? "Next: " + slides[cur + 1].dataset.title : "End";
    }
  }
  setInterval(() => { if (pres && !pres.hidden && t0) { const s = Math.floor((Date.now() - t0) / 1000); pres.querySelector(".p-timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; } }, 500);

  const next = () => show(cur + 1, 1), prev = () => show(cur - 1, -1);
  addEventListener("keydown", e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(k)) { e.preventDefault(); next(); }
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(k)) { e.preventDefault(); prev(); }
    else if (k === "Home") show(0, -1);
    else if (k === "End") show(slides.length - 1, 1);
    else if (k === "s" || k === "S") { pres.hidden = !pres.hidden; if (!t0) t0 = Date.now(); hud(); }
    else if (k === "f" || k === "F") { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); }
    else if (k === "b" || k === "B" || k === ".") { document.body.style.opacity = document.body.style.opacity === "0" ? "" : "0"; }
  });
  deck.addEventListener("click", e => { if (!e.target.closest(".viewer, a")) next(); });
  let tx = null;
  addEventListener("touchstart", e => tx = e.touches[0].clientX, { passive: true });
  addEventListener("touchend", e => { if (tx === null) return; const d = e.changedTouches[0].clientX - tx; if (Math.abs(d) > 40) d < 0 ? next() : prev(); tx = null; });
  addEventListener("hashchange", () => { const n = parseInt(location.hash.slice(1), 10) - 1; if (!isNaN(n) && n !== cur) show(n, n > cur ? 1 : -1); });

  /* ---------- print: render every viewer once so PDFs get the 3D frame */
  addEventListener("beforeprint", () => slides.forEach(s => viewersFor(s, true)));

  window.Deck = { show: n => show(n - 1, 1), count: slides.length, get index() { return cur + 1; }, ready: document.fonts ? document.fonts.ready : Promise.resolve() };
  const start = parseInt(location.hash.slice(1), 10) - 1;
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => show(isNaN(start) ? 0 : start, 1));
})();
