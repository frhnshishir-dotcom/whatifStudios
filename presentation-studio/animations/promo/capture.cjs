// Frame-exact capture: seeks the spot's GSAP timeline to every frame time, screenshots, pipes JPEGs to FFmpeg.
// node capture.cjs spot.html out.mp4 [--fps 30] [--w 1920] [--h 1080] [--ffmpeg path] [--crf 18]
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");

(async () => {
  const [page_, out, ...rest] = process.argv.slice(2);
  const o = (k, d) => { const i = rest.indexOf("--" + k); return i >= 0 ? rest[i + 1] : d; };
  const fps = +o("fps", 30), W = +o("w", 1920), H = +o("h", 1080), ff = o("ffmpeg", "ffmpeg"), crf = o("crf", "18");
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto("file://" + path.resolve(page_) + "?capture");
  await page.evaluate(() => window.__ready);
  const dur = await page.evaluate(() => window.__duration);
  const n = Math.round(dur * fps);
  const enc = spawn(ff, ["-y", "-v", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "medium", "-crf", crf, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", String(fps), out],
    { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((res, rej) => enc.on("close", c => c === 0 ? res() : rej(new Error("ffmpeg exit " + c))));
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await page.evaluate(t => window.__seek(t), i / fps);
    const buf = await page.screenshot({ type: "jpeg", quality: 93 });
    if (!enc.stdin.write(buf)) await new Promise(r => enc.stdin.once("drain", r));
  }
  enc.stdin.end();
  await done;
  await browser.close();
  if (errs.length) { console.error("page errors:", errs); process.exit(2); }
  console.log(JSON.stringify({ frames: n, fps, seconds: dur, render_s: (Date.now() - t0) / 1000 }));
})().catch(e => { console.error(e); process.exit(1); });
