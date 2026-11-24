// Render a still from the studio's Three.js viewer — slide imagery without an image API or a GPU.
// node render_still.cjs <out.png> [--kind globe|device] [--w 1600] [--h 1800] [--accent #FF5A1F] [--color #F5F5F2]
//                       [--bg #0B0B0C] [--distance 3.1] [--fov 30] [--t 2.5] [--glb model.glb] [--transparent]
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

(async () => {
  const [out, ...rest] = process.argv.slice(2);
  const o = k => { const i = rest.indexOf("--" + k); return i >= 0 ? rest[i + 1] : null; };
  const W = +(o("w") || 1600), H = +(o("h") || 1800);
  const opts = {
    kind: o("glb") ? "glb" : (o("kind") || "globe"), accent: o("accent") || "#FF5A1F", color: o("color") || "#F5F5F2",
    bg: o("bg") || "#0B0B0C", distance: +(o("distance") || 4.2), fov: +(o("fov") || 30), speed: 0, maxPixelRatio: 1,
  };
  if (o("glb")) opts.glb = fs.readFileSync(o("glb")).toString("base64");
  const transparent = rest.includes("--transparent");
  const bundle = fs.readFileSync(path.join(__dirname, "../../assets/vendor/studio-viewer.js"), "utf8");
  const html = `<!doctype html><html><body style="margin:0;background:${transparent ? "transparent" : opts.bg}">
<div id="v" style="width:${W}px;height:${H}px"></div><script>${bundle}</script>
<script>const v=StudioViewer.mount(document.getElementById('v'),${JSON.stringify(opts)});window.v=v;</script></body></html>`;
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.waitForTimeout(800);
  const t = +(o("t") || 0);
  await page.evaluate(t => { /* advance the turntable deterministically */ window.v.renderOnce(); }, t);
  await page.locator("#v").screenshot({ path: out, omitBackground: transparent });
  await browser.close();
  console.log(out);
})().catch(e => { console.error(e); process.exit(1); });
