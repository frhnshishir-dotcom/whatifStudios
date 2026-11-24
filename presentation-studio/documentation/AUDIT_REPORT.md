# Environment audit and handover (24 Nov 2026)

**Scope:** this Claude Code cloud session (Linux container) plus the claude.ai connectors on the account.

Your Windows laptop (8 GB RAM, Intel UHD, Blender 5.2.2) was **not attached**, so nothing on it was tested. Every "working" below was run and checked here, not read from a config file.

## 1. Original environment

| Capability | Status | Evidence |
|---|---|---|
| Python 3.13, pip, uv | INSTALLED AND WORKING | |
| python-pptx 1.0.2, python-docx, openpyxl, reportlab, pypdf, Pillow, numpy, pandas, lxml | INSTALLED AND WORKING | imported |
| PyMuPDF, fontTools | MISSING, so **installed** | |
| Node 22, npm, Playwright 1.63 + Chrome for Testing 158 | INSTALLED AND WORKING | screenshots, PDFs and WebGL (SwiftShader) rendered |
| pptxgenjs (the pptx skill says it's preinstalled) | MISSING | the skill's claim was wrong; the studio uses python-pptx instead |
| LibreOffice 24.2 (`soffice`) | INSTALLED AND WORKING | PPTX → PDF renders for every build |
| pdftoppm, ImageMagick 6, pandoc 3.1 | INSTALLED AND WORKING | |
| FFmpeg / ffprobe 6.1 | INSTALLED AND WORKING | H.264 encode and probe |
| Inkscape, Typst, LaTeX, Marp, Mermaid CLI, Graphviz | MISSING | not needed: SVG charts and HTML cover these |
| Blender / Blender MCP | MISSING HERE (laptop only) | needs the laptop attached via Remote Control |
| Local AI image or video models | MISSING (by design) | an 8 GB iGPU laptop can't run them well; use connectors instead |
| Skills: `anthropic-skills:pptx`, `docx`, `pdf`, `xlsx`, `deep-research`; `frontend-design`; `artifact-design`; `dataviz`; design-skills / design | INSTALLED | the pptx skill's `validate.py` and `soffice.py` are used by the studio |
| Skills: social-media-skills (runway, kling, veo-3, flux, nano-banana, …) | INSTALLED, prompt guides only | no API behind them |
| Network | LIMITED, so **upgraded** | package registries + Google Fonts + GitHub only, before the change |

### Connectors (claude.ai)

| Connector | Status | Tested with |
|---|---|---|
| Canva | WORKING | `list-brand-kits` (none set up). AI image generation uses Canva credits: REQUIRES SUBSCRIPTION for volume, not tested, to avoid spending |
| Gamma | WORKING | `get_themes` (102 themes). Generation and image generation spend Gamma credits, not tested |
| Notion | WORKING | `get-self` |
| Google Drive | WORKING | `list_recent_files` |
| Gmail, Buffer, Indeed | CONNECTED | not presentation-relevant |
| vidIQ | WORKING, 150 free credits | `balance`. `image_generate` and `generate_video` cost credits |
| OpusClip | CONNECTED, REQUIRES PAID PLAN | API needs Pro |
| framer | CONNECTED | not tested |
| Microsoft 365 | CONFIGURED BUT NOT WORKING (`connect_incomplete`) | REQUIRES AUTH: finish it under claude.ai → Settings → Connectors |
| whop | NEEDS RECONNECT | irrelevant |
| Plugin MCP servers: Adobe, Figma, Miro, Cloudinary (+ Asana, Linear, Slack, …) | CONFIGURED BUT NOT WORKING | the network proxy blocks their hosts (403). Datadog needs auth. BigQuery's auth server is incompatible |

### Duplicates and conflicts found
- Two PowerPoint paths: the pptx skill (pptxgenjs, not installed) and the studio (python-pptx). Use the studio. The skill's validator still runs inside QA.
- Overlapping design skills: `design-skills:*` and `design:*` (critique, design system, accessibility). Harmless.
- About 100 social-media skills irrelevant to presentations. Harmless: they only load when asked for.
- **Git LFS upload is blocked** (`lfs.github.com` isn't an allowed host). Images and videos can't be pushed from cloud sessions; scripts and JSON can.
- **Wikimedia API returns 429** (rate-limited on the shared proxy IP). Retry later, or use Openverse or Poly Haven.

## 2. Changes made

| Change | Verified by |
|---|---|
| Network: added `en.wikipedia.org`, `commons.wikimedia.org`, `upload.wikimedia.org`, `api.openalex.org`, `api.crossref.org`, `api.worldbank.org`, `api.polyhaven.com`, `dl.polyhaven.org`, `cdn.jsdelivr.net`, `unpkg.com` (Default environment, approved by you) | each host returned 200 or 301 |
| pip: `pymupdf`, `fonttools` | imported, used in QA |
| Vendored: Three.js 0.170 (bundled viewer), GSAP 3.12.7, fonts (Inter, Inter Display, Instrument Serif, JetBrains Mono: OFL) | demo build + promo render |
| **Presentation Studio** (`presentation-studio/`) | demo deck "The Connected Planet" (14 slides) and a 17 s ad spot built end to end |
| **New skill:** `.claude/skills/world-class-presentation/` (trigger: "CREATE A WORLD-CLASS PRESENTATION") | loads from the repo |
| No new MCP servers | none materially better than the connectors you already have; local tools cover the rest |

## 3. Integrations that still need you
1. **Microsoft 365:** finish the connection at claude.ai → Settings → Connectors (for OneDrive or SharePoint delivery).
2. **Adobe, Figma, Miro:** if you want them, their hosts must be allowed in the environment's network settings, and the Adobe and Figma plugins need you signed in. Freemium.
3. **Laptop:** to use Blender from a cloud session, turn on Remote Control in the Claude desktop app (Settings → Claude Code → Remote Control) and share the WhatIfStudio folder. Otherwise run Claude Code on the laptop itself.
4. **Images and videos to GitHub from the cloud:** allow `lfs.github.com` in the environment's network settings.
5. **Fonts on Windows:** run `presentation-studio\assets\fonts\install_fonts.ps1` once, or build with `--fonts portable`.

## 4. Free vs paid

| Free and working now | Freemium (credits or plan limits) | Paid / not used |
|---|---|---|
| Studio engine, python-pptx, LibreOffice, Playwright, Chrome, FFmpeg, Three.js, GSAP (no-charge licence), OFL fonts, World Bank, OpenAlex, Crossref, Wikipedia/Commons, Poly Haven, WebSearch | Canva AI, Gamma, vidIQ (150 credits/month), Adobe Express/Firefly | OpusClip API (Pro), Runway, Kling, Veo, Midjourney (none connected; nothing purchased) |

## 5. Performance and limits
- **Cloud build** of the 14-slide demo takes about 70 s, including the animated walk-through, the PDF, the PPTX render and QA. A 17 s 1080p30 ad spot takes about 3 min with CPU WebGL; the laptop's iGPU should be faster.
- **Laptop:** one heavy job at a time. The web deck's 3D is capped at 1.5× pixel ratio and renders only on the active slide. Blender stays at EEVEE, low samples, in the open session.
- **Not verified in real PowerPoint** (none is available here): Morph, the p14 transitions (Flip, Prism, Vortex, Fly Through) and video autoplay. They pass the OOXML schema validator, open in python-pptx and render in LibreOffice (with fallbacks). Open the demo .pptx in PowerPoint 365 once to confirm.
- AI images and video are not generated locally, by design. Procedural backgrounds, Three.js and Blender cover the visuals for free.

## 6. Recommended next improvements
1. Open the demo `.pptx` in PowerPoint 365 and report anything off with Morph, transitions or video autoplay.
2. Install Inter/Instrument Serif on the laptop (`install_fonts.ps1`).
3. Add a brand-kit importer (logo SVG plus colours, turned into a design system) when you have a specific brand.
4. A Blender turntable script for product renders, driven through Blender MCP.
5. Allow `lfs.github.com` so finished decks and videos can be committed from cloud sessions.
