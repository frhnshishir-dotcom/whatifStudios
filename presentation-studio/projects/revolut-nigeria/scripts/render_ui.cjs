// Renders the conceptual phone UI to a transparent PNG (3x) for slides and the video.
const { chromium } = require("playwright"); const path = require("path");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 440, height: 880 }, deviceScaleFactor: 3 });
  await p.goto("file://" + path.join(__dirname, "concept_ui.html"));
  await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
  await p.locator(".phone").screenshot({ path: path.join(__dirname, "../assets/images/concept_phone_ui.png"), omitBackground: true });
  await b.close(); console.log("ok");
})();
