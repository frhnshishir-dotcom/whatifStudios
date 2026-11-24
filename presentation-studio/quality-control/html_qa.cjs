// HTML deck QA with Playwright (Chromium).
// node html_qa.cjs <index.html> <outDir> [--pdf out.pdf] [--posters dir] [--no-animate]
// Writes outDir/html-XX.png, outDir/html_qa.json. Checks what actually RENDERED:
//   text overflowing its box, text ink overlapping other text, elements off-stage, broken images,
//   console/page errors, and an animated walk-through (every slide reached, every build finished).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

(async () => {
  const [index, outDir, ...rest] = process.argv.slice(2);
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
  const pdfPath = opt("--pdf"), posterDir = opt("--posters"), animate = !rest.includes("--no-animate");
  fs.mkdirSync(outDir, { recursive: true });
  const url = "file://" + path.resolve(index);
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const report = { slides: [], errors: [], animation: null, pdf: null, posters: [], viewTransitions: null };
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on("console", m => { if (m.type() === "error") report.errors.push("console: " + m.text()); });
  page.on("pageerror", e => report.errors.push("pageerror: " + e.message));

  // ---- static pass: screenshots + rendered-geometry checks
  await page.goto(url + "?static#1");
  await page.evaluate(() => window.Deck.ready);
  report.viewTransitions = await page.evaluate(() => typeof document.startViewTransition === "function");
  const n = await page.evaluate(() => window.Deck.count);
  for (let i = 1; i <= n; i++) {
    await page.evaluate(k => window.Deck.show(k), i);
    await page.waitForTimeout(i === 1 ? 600 : 250);
    const shot = path.join(outDir, `html-${String(i).padStart(2, "0")}.png`);
    await page.screenshot({ path: shot });
    const issues = await page.evaluate(() => {
      const out = [];
      const s = document.querySelector(".slide.active");
      const deckR = document.getElementById("deck").getBoundingClientRect();
      const sc = deckR.width / 1920;
      const texts = [...s.querySelectorAll(".text")];
      const ink = [];
      for (const el of texts) {
        const label = (el.textContent || "").trim().slice(0, 40);
        const fs = parseFloat(getComputedStyle(el).fontSize), lhpx = parseFloat(getComputedStyle(el).lineHeight) || fs * 1.2;
        // a real overflow is at least one extra line; glyph overhang of tight display type is not
        if (el.scrollHeight > el.clientHeight + Math.max(3, fs * 0.3)) out.push({ level: "FAIL", check: "html-overflow", msg: `text taller than its box by ${el.scrollHeight - el.clientHeight}px: "${label}"` });
        const r = document.createRange(); r.selectNodeContents(el);
        const rects = [...r.getClientRects()].filter(q => q.width > 1 && q.height > 1).map(q => { const lh = lhpx * sc; if (q.height <= lh) return q; const c = (q.top + q.bottom) / 2; return { left: q.left, right: q.right, top: c - lh / 2, bottom: c + lh / 2, width: q.width, height: lh }; });
        if (!rects.length) continue;
        const u = rects.reduce((a, q) => ({ l: Math.min(a.l, q.left), t: Math.min(a.t, q.top), r: Math.max(a.r, q.right), b: Math.max(a.b, q.bottom) }), { l: 1e9, t: 1e9, r: -1e9, b: -1e9 });
        const bx = { l: (u.l - deckR.left) / sc, t: (u.t - deckR.top) / sc, r: (u.r - deckR.left) / sc, b: (u.b - deckR.top) / sc };
        if (bx.l < -1 || bx.t < -1 || bx.r > 1921 || bx.b > 1081) out.push({ level: "FAIL", check: "html-offstage", msg: `text ink leaves the slide: "${label}"` });
        ink.push({ bx, rects: rects.map(q => ({ l: (q.left - deckR.left) / sc, t: (q.top - deckR.top) / sc, r: (q.right - deckR.left) / sc, b: (q.bottom - deckR.top) / sc })), label });
      }
      for (let a = 0; a < ink.length; a++) for (let b = a + 1; b < ink.length; b++) {
        let hit = 0;
        for (const p of ink[a].rects) for (const q of ink[b].rects) {
          const w = Math.min(p.r, q.r) - Math.max(p.l, q.l), h = Math.min(p.b, q.b) - Math.max(p.t, q.t);
          if (w > 4 && h > 4) hit = Math.max(hit, w * h);
        }
        if (hit) out.push({ level: "FAIL", check: "html-text-overlap", msg: `"${ink[a].label}" overlaps "${ink[b].label}"` });
      }
      s.querySelectorAll("img").forEach(im => { if (!im.complete || im.naturalWidth === 0) out.push({ level: "FAIL", check: "html-image", msg: "image failed to load: " + im.getAttribute("src") }); });
      return out;
    });
    report.slides.push({ index: i, screenshot: shot, issues });
  }

  // ---- 3D posters for the PPTX/PDF (one frame of each viewer)
  if (posterDir) {
    fs.mkdirSync(posterDir, { recursive: true });
    for (let i = 1; i <= n; i++) {
      const has = await page.evaluate(k => { window.Deck.show(k); return !!document.querySelector(".slide.active .viewer"); }, i);
      if (!has) continue;
      await page.waitForTimeout(900);
      const el = await page.$(".slide.active .viewer");
      const p = path.join(posterDir, `poster-${String(i).padStart(2, "0")}.png`);
      await el.screenshot({ path: p, omitBackground: true });
      report.posters.push({ slide: i, path: p });
    }
  }

  // ---- animated walk-through: real transitions, builds must finish with everything visible
  if (animate) {
    const p2 = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    p2.on("pageerror", e => report.errors.push("anim pageerror: " + e.message));
    await p2.goto(url + "#1");
    await p2.evaluate(() => window.Deck.ready);
    await p2.waitForTimeout(800);
    const anim = { reached: [], hidden_after_build: [], ms_per_slide: 2600 };
    for (let i = 1; i <= n; i++) {
      if (i > 1) await p2.keyboard.press("ArrowRight");
      await p2.waitForTimeout(600);
      // wait until every finite animation (transition + builds) has finished, max 10 s
      await p2.waitForFunction(() => document.getAnimations().filter(a => a.playState === "running" && a.effect && a.effect.getComputedTiming().iterations !== Infinity).length === 0, null, { timeout: 10000 }).catch(() => {});
      await p2.waitForTimeout(300);
      const st = await p2.evaluate(() => {
        const s = document.querySelector(".slide.active");
        const hidden = [...s.querySelectorAll("[data-order]")].filter(e => parseFloat(getComputedStyle(e).opacity) < 0.98).map(e => (e.textContent || e.className).trim().slice(0, 30));
        return { index: window.Deck.index, hidden, leaving: document.querySelectorAll(".slide.leaving").length };
      });
      anim.reached.push(st.index);
      if (st.hidden.length) anim.hidden_after_build.push({ slide: st.index, hidden: st.hidden });
      if (st.leaving) report.errors.push(`slide ${st.index}: outgoing slide never cleaned up`);
    }
    anim.ok = anim.reached.join(",") === Array.from({ length: n }, (_, k) => k + 1).join(",") && !anim.hidden_after_build.length;
    report.animation = anim;
    await p2.close();
  }

  // ---- PDF (print stylesheet: one slide per page, motion off, final state)
  if (pdfPath) {
    const p3 = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await p3.goto(url + "?static#1");
    await p3.evaluate(() => window.Deck.ready);
    await p3.emulateMedia({ media: "print" });
    await p3.waitForTimeout(1200);
    await p3.pdf({ path: pdfPath, width: "1920px", height: "1080px", printBackground: true, preferCSSPageSize: true });
    report.pdf = pdfPath;
  }
  fs.writeFileSync(path.join(outDir, "html_qa.json"), JSON.stringify(report, null, 1));
  await browser.close();
  console.log(JSON.stringify({ slides: n, errors: report.errors.length, animation_ok: report.animation && report.animation.ok }));
})().catch(e => { console.error(e); process.exit(1); });
