/* Presentation Studio · promo/ad-spot runtime.
   window.SPOT (spec) -> one paused GSAP timeline. window.__seek(t) renders the exact frame at time t,
   so capture.cjs can step frame by frame: smooth video regardless of how fast the machine is. */
(() => {
  const S = window.SPOT;
  const $ = (q, r = document) => r.querySelector(q);
  const $$ = (q, r = document) => [...r.querySelectorAll(q)];
  const tl = gsap.timeline({ paused: true, defaults: { ease: "expo.out" } });
  const viewers = [];
  const T = 0.8; // transition overlap
  const flash = $("#flash");
  let t = 0;

  const fmt = (v, tpl) => {
    const m = tpl.match(/^(\D*)([\d,]*\.?\d+)(.*)$/);
    if (!m) return tpl;
    const dec = (m[2].split(".")[1] || "").length;
    let s = v.toFixed(dec);
    if (m[2].includes(",")) s = Number(s).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    return m[1] + s + m[3];
  };

  S.scenes.forEach((sc, i) => {
    const el = $("#sc" + i);
    const start = t, d = sc.dur;
    tl.set(el, { autoAlpha: 1, zIndex: i + 1 }, start);
    const prev = i > 0 ? $("#sc" + (i - 1)) : null;
    const tr = i === 0 ? (sc.transition || "fade") : (sc.transition || "fade");

    // ---------- transition in
    if (tr === "fade") tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.7, ease: "power2.inOut" }, start);
    else if (tr === "iris") tl.fromTo(el, { clipPath: "circle(0% at 50% 50%)" }, { clipPath: "circle(110% at 50% 50%)", duration: 1.0, ease: "power3.inOut" }, start);
    else if (tr === "shutter") tl.fromTo(el, { clipPath: "inset(50% 0% 50% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.8, ease: "power4.inOut" }, start);
    else if (tr === "zoom") tl.fromTo(el, { scale: 2.4, opacity: 0, filter: "blur(24px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.9 }, start);
    else if (tr === "whip") {
      tl.fromTo(el, { xPercent: 100, filter: "blur(40px)" }, { xPercent: 0, filter: "blur(0px)", duration: 0.6 }, start);
      if (prev) tl.to(prev, { xPercent: -45, filter: "blur(30px)", duration: 0.6 }, start);
    } else if (tr === "flash" || tr === "cut") {
      tl.set(el, { opacity: 1 }, start);
      if (tr === "flash") tl.fromTo(flash, { opacity: 0 }, { opacity: 1, duration: 0.08, ease: "none" }, start - 0.08)
        .to(flash, { opacity: 0, duration: 0.6, ease: "power2.out" }, start);
    }

    // ---------- background drift
    const bg = $(".bg", el);
    if (bg) tl.fromTo(bg, { scale: 1.18 }, { scale: 1.0, duration: d + T, ease: "none" }, start);

    // ---------- content
    const words = (root, at, stagger = 0.07) => {
      $$(".w > i", root).forEach((w, k) => tl.fromTo(w, { yPercent: 115, rotate: 4 }, { yPercent: 0, rotate: 0, duration: 0.9 }, at + k * stagger));
    };
    const fadeUp = (q, at, dy = 30) => { const n = $(q, el); if (n) tl.fromTo(n, { opacity: 0, y: dy }, { opacity: 1, y: 0, duration: 0.9 }, at); };

    if (sc.type === "kinetic") {
      words(el, start + 0.25, 0.09);
      tl.fromTo($(".kin", el), { scale: 1 }, { scale: 1.06, duration: d + T, ease: "none" }, start);
      fadeUp(".eyebrow", start + 0.1, 10);
      fadeUp(".foot", start + 0.8, 0);
    } else if (sc.type === "reveal" || sc.type === "endcard") {
      const obj = $(".object", el);
      if (obj) {
        const endc = sc.type === "endcard";
        tl.fromTo(obj, { scale: 0.65, opacity: 0, filter: "blur(16px)" }, { scale: 1, opacity: endc ? 0.22 : 1, filter: endc ? "blur(2px)" : "blur(0px)", duration: 1.4 }, start + 0.1);
        viewers.push({ host: obj, opts: sc.object, start, end: start + d + T });
      }
      fadeUp(".eyebrow", start + 0.5, 10);
      words(el, start + 0.6, 0.06);
      fadeUp(".sub", start + 1.2);
      const cta = $(".cta", el);
      if (cta) tl.fromTo(cta, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.8, ease: "back.out(2)" }, start + 1.4);
      fadeUp(".brand", start + 1.1, 12);
      fadeUp(".foot", start + 0.6, 0);
      const sweep = $(".sweep", el);
      if (sweep) tl.fromTo(sweep, { xPercent: -120, opacity: 1 }, { xPercent: 120, duration: 1.4, ease: "power2.inOut" }, start + 1.3).set(sweep, { opacity: 0 }, start + 2.75);
    } else if (sc.type === "stat") {
      const num = $(".num", el), target = sc.value;
      const val = parseFloat((target.match(/[\d,]*\.?\d+/) || ["0"])[0].replace(/,/g, ""));
      const o = { v: 0 };
      tl.fromTo(o, { v: 0 }, { v: val, duration: 1.8, ease: "power3.out", onUpdate: () => { num.textContent = fmt(o.v, target); } }, start + 0.3);
      const ring = $(".ring-fg", el);
      if (ring) tl.fromTo(ring, { strokeDashoffset: 1 }, { strokeDashoffset: 1 - Math.min(1, (sc.ring ?? (target.includes("%") ? val / 100 : 1))), duration: 1.8, ease: "power3.out" }, start + 0.3);
      fadeUp(".label", start + 0.9);
      fadeUp(".source", start + 1.3, 0);
      tl.fromTo($(".statwrap", el), { scale: 0.92 }, { scale: 1.02, duration: d + T, ease: "none" }, start);
    } else if (sc.type === "device") {
      const img = $(".devimg", el);
      tl.fromTo(img, { yPercent: 35, opacity: 0, rotate: 4 }, { yPercent: 0, opacity: 1, rotate: 0, duration: 1.2 }, start + 0.05);
      tl.fromTo($(".glow", el), { scale: 0.6, opacity: 0 }, { scale: 1.1, opacity: 0.55, duration: 1.6, ease: "power2.out" }, start + 0.2);
      $$(".dline", el).forEach((ln, k) => $$(".w > i", ln).forEach((w, j) =>
        tl.fromTo(w, { yPercent: 115 }, { yPercent: 0, duration: 0.8 }, start + (sc.line_times ? sc.line_times[k] : 0.25 + k * 0.55) + j * 0.05)));
      fadeUp(".eyebrow", start + 0.1, 10);
    } else if (sc.type === "list") {
      fadeUp(".eyebrow", start + 0.1, 10);
      words($(".title", el) || el, start + 0.2, 0.05);
      $$(".item", el).forEach((it, k) => tl.fromTo(it, { opacity: 0, x: -80, filter: "blur(12px)" }, { opacity: 1, x: 0, filter: "blur(0px)", duration: 0.9 }, start + 0.6 + k * 0.28));
    }
    tl.set(el, { autoAlpha: 0 }, start + d + T);
    t += d;
  });
  const total = t + T;
  tl.set({}, {}, total); // pad timeline to full length

  // ---------- 3D: mount lazily, render deterministically at each seek
  const mounted = new Map();
  function renderViewers(time) {
    for (const v of viewers) {
      const on = time >= v.start - 0.05 && time <= v.end;
      if (!on) continue;
      let inst = mounted.get(v.host);
      if (!inst) { inst = window.StudioViewer.mount(v.host, { ...v.opts, speed: v.opts.speed ?? 0.35, maxPixelRatio: 1 }); mounted.set(v.host, inst); }
      const p = (time - v.start) / (v.end - v.start);
      inst.setTime(time - v.start, (v.opts.dolly ?? 0.9) * p);
    }
  }
  window.__duration = total;
  window.__seek = time => { tl.seek(time, false); renderViewers(time); };
  window.__ready = document.fonts.ready.then(() => { window.__seek(0); return true; });
  // live preview when opened in a browser (no capture): play in real time
  if (!new URLSearchParams(location.search).has("capture")) {
    const t0 = performance.now();
    const loop = now => { window.__seek(((now - t0) / 1000) % total); requestAnimationFrame(loop); };
    window.__ready.then(() => requestAnimationFrame(loop));
  }
})();
