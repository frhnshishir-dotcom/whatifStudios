// Renders the campaign poster (1600x2000 PNG) and the video thumbnail (1920x1080 JPG) from key_visuals.html.
const { chromium } = require("playwright"); const path = require("path");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 2000 } });
  await p.goto("file://" + path.join(__dirname, "key_visuals.html"));
  await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(400);
  await p.locator("#poster").screenshot({ path: path.join(__dirname, "../assets/images/REVOLUT_NIGERIA_CAMPAIGN_POSTER.png") });
  await p.locator("#thumb").screenshot({ path: path.join(__dirname, "../assets/images/campaign_thumbnail.jpg"), type: "jpeg", quality: 92 });
  await b.close(); console.log("ok");
})();
