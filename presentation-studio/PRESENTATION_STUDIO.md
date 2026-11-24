# Presentation Studio: operating manual

One deck spec (`projects/<name>/deck.json`) produces:

| Output | File | Notes |
|---|---|---|
| Editable PowerPoint | `exports/<name>/<name>.pptx` | Real text boxes, native charts, theme colours and fonts, speaker notes, Morph and 3D transitions, auto-playing entrance builds, embedded MP4s that autoplay muted and loop |
| PDF | `exports/<name>/<name>.pdf` | From the web deck with fonts embedded. Final state of every build. 3D and video slides show a frame. |
| Cinematic web deck | `exports/<name>/web/index.html` | Works offline from a USB stick. View-Transition morph, 11 transitions, staggered builds, count-ups, animated charts, live 3D, video, parallax, particles, presenter notes |
| Slide images | `exports/<name>/slides/slide-NN.png` | 1920×1080 |
| Speaker script | `exports/<name>/<name>_speaker_script.md` | Per-slide notes, timing table, sources |
| References | `exports/<name>/sources.md` | APA 7 |
| Ad / promo videos | `exports/<name>/video/<spot>.mp4` | H.264, 16:9, 9:16, 1:1 or 4:5. Frame-exact render with a poster and a frame strip |
| QA | `exports/<name>/qa/report.md` + `contact_html.png` + `contact_pptx.png` | Automated checks plus a human-review rubric |

The trigger phrase **"CREATE A WORLD-CLASS PRESENTATION"** runs the full workflow in
`.claude/skills/world-class-presentation/SKILL.md`.

---

## 1. Commands

Run these from `presentation-studio/`:

```bash
python studio.py systems                       # list design systems
python studio.py templates                     # list starter decks
python studio.py new my-talk --template academic --system scholar
python studio.py build my-talk                 # everything: html, renders, pdf, pptx, notes, QA
python studio.py build my-talk --fonts portable  # pptx for a PC you don't control (Calibri/Cambria)
python studio.py build my-talk --fast          # skip the animated walk-through check
python studio.py promo my-talk teaser          # projects/my-talk/spots/teaser.json -> MP4
python studio.py promo my-talk teaser --format 9:16   # vertical cut for Reels/TikTok/Shorts
python studio.py bg monolith nebula out.jpg    # a single background image
python research/tools/worldbank.py IT.NET.USER.ZS WLD,SSF --from 2005 --to 2024 --project my-talk
node 3d-assets/web/render_still.cjs out.png --kind sculpture --w 1600 --h 1600   # 3D still for any slide
```

The build exits with status 1 if QA has any FAIL. Fix every FAIL, then look at both contact sheets yourself.

## 2. Folder map

| Folder | What lives there |
|---|---|
| `engine/` | Layout engine (`layouts.py`) shared by `pptx_builder.py`, `html_builder.py` and `qa.py`. Also `pptx_motion.py` (Morph, p14 transitions, builds, video autoplay), `promo.py` (ad spots), `backgrounds.py`, `textfit.py`, `fonts.py`, `refs.py`, `notes.py` and `export.py` |
| `design-systems/` | `monolith` (dark keynote), `lumen` (light editorial), `signal` (data/AI), `scholar` (academic). For a new brand, copy one and change the tokens. |
| `components/runtime/` | `deck.js` and `deck.css`: the web deck's motion runtime, with no dependencies |
| `animations/promo/` | The ad-spot runtime (GSAP timeline), styles and frame-exact `capture.cjs` |
| `3d-assets/web/` | Three.js viewer source (globe, device, sculpture, orbits, or any `.glb`) and `render_still.cjs` |
| `assets/fonts/`, `assets/vendor/` | OFL fonts with their licences. Three.js bundle (MIT) and GSAP (free standard licence). |
| `templates/` | Starter decks: `keynote.json`, `academic.json` |
| `research/` | `BRIEF_TEMPLATE.md`, `RESEARCH_PROTOCOL.md`, `tools/worldbank.py`, `tools/openalex.py` |
| `quality-control/` | `RUBRIC.md` and `html_qa.cjs` (Playwright render checks) |
| `projects/<name>/` | `deck.json`, `sources.json`, `brief.md`, `assets/`, `research/`, `spots/` |
| `exports/<name>/` | Generated output. Gitignored, rebuilt by `studio.py build`. |
| `documentation/` | `AUDIT_REPORT.md`: the environment audit and handover |

## 3. Deck spec

```json
{
 "meta": {"title": "...", "subtitle": "...", "author": "...", "course": "...", "date": "...",
          "duration_min": 10, "slide_count": 12, "academic": true, "must_cover": ["methodology", "limitations"],
          "short_title": "footer text", "file_name": "my-talk"},
 "design_system": "scholar",
 "overrides": {"colors": {"accent": "#0057B8"}},
 "sources": [{"id": "who2024", "type": "report", "author": "World Health Organization", "year": 2024,
              "title": "...", "url": "https://...", "accessed": "2026-11-24", "verified": true}],
 "slides": [ {"layout": "title", "title": "The [[Connected]] Planet", "notes": "...", "cite": ["who2024"],
              "transition": "morph", "motion": "rise", "bg": "nebula", "fx": "particles"} ]
}
```

- `[[words]]` puts those words in the accent colour, anywhere.
- `meta.must_cover`, `slide_count` and `academic` turn the brief into hard QA gates.

### Layouts and their fields

| Layout | Fields |
|---|---|
| `title` | eyebrow, title, subtitle, meta |
| `agenda` | title, items[] |
| `section` | index ("02"), title, subtitle |
| `statement` | eyebrow, text, size |
| `big-number` | eyebrow, value ("71.2%", counts up), label, context |
| `split` | eyebrow, title, body or bullets[], image **or** video, image_side, caption |
| `features` | eyebrow, title, items[{tag, title, body}] (2–4) |
| `timeline` | eyebrow, title, items[{when, title, body}] (3–6) |
| `comparison` | eyebrow, title, left / right {tag, title, bullets[]} |
| `chart` | eyebrow, title, chart{type: line, column, bar or donut; categories, series, unit, decimals, max, highlight}, callout{value, label}, takeaway |
| `stats` | eyebrow, title, items[{value, label}] (2–4), highlight |
| `quote` | quote, by, role. **Only real, sourced quotes.** |
| `product` | eyebrow, title, viewer{kind: globe, device, sculpture or orbits; or glb: path} **or** video **or** image, callouts[{title, body}] (≤4) |
| `image-full` | image, eyebrow, title, caption |
| `video` | video (mp4), poster, eyebrow, title |
| `references` | (auto-built from `sources`, APA 7) |
| `closing` | eyebrow, title, subtitle, contact |

### Per-slide options

- **`bg` (background):** `solid`, `alt`, `spotlight`, `aurora`, `horizon`, `grid`, `mesh`, `nebula`, `beams`, `liquid`, or an image path.
- **`transition`:** `fade`, `rise`, `zoom`, `wipe`, `push`, `iris`, `shutter`, `flip`, `cube`, `vortex`, `blur`, `morph`, `cut`, `none`.
  - PowerPoint maps: zoom → Fly Through, flip → Flip, cube → Prism, vortex → Vortex, iris → Circle, shutter → Split, morph → Morph. Each has a Fade fallback.
- **`motion`** (entrance builds): `rise`, `fade`, `mask`, `scale`, `none`.
- **`fx`:** `particles`.
- **`seconds`:** overrides the timing estimate that's otherwise calculated from the notes.

**Morph:** give consecutive slides elements with the same key. Every layout's title has the key `title`, so a `section` slide followed by a slide with `"transition": "morph"` glides the headline into place. In PowerPoint the shapes are named `!!title`. On the web it uses View Transitions.

## 4. Ad spots and videos

`projects/<p>/spots/<spot>.json` (full schema in `engine/promo.py`):

- **Scene types:**
  - `kinetic`: word-by-word masked type
  - `reveal`: a 3D hero object with a camera dolly and title
  - `stat`: a count-up with a glowing progress ring
  - `list`
  - `endcard`: title, subtitle, CTA pill and a light sweep
- **Scene transitions:** `fade`, `iris`, `shutter`, `zoom`, `whip`, `flash`, `cut`.
- **Formats:** `16:9`, `9:16`, `1:1`, `4:5`. `"letterbox": true` adds 2.39:1 cinema bars.

Rendering is frame-exact. Every frame is seeked on a paused GSAP timeline and the 3D is rendered at that time, so a slow laptop gives the same smooth result, only slower. Benchmark in the cloud (CPU WebGL): 17 s of 1080p30 renders in about 3 min.

To put a spot in the deck, use `{"layout": "video", "video": "../../exports/<p>/video/<spot>.mp4"}`, or `"video"` on a `split` or `product` slide.

**Audio:** spots are rendered silent. Add music and voice in your editor (CapCut or similar). Don't use copyrighted music.

## 5. Fonts: read this before presenting on someone else's PC

- `--fonts brand` (the default) uses Inter, Inter Display, Instrument Serif and JetBrains Mono, all free OFL fonts in `assets/fonts/`. Install them on any PC that will *edit or present the .pptx*:
  ```bash
  powershell -ExecutionPolicy Bypass -File assets\fonts\install_fonts.ps1
  ```
- `--fonts portable` writes Calibri, Cambria and Courier New, which ship with Office. Use it for classroom PCs. QA measures with metric-compatible fonts, so the fit checks stay true.
- The PDF and web deck always embed the fonts.

## 6. Laptop constraints (8 GB RAM, Intel iGPU, no dedicated GPU)

- **One heavy job at a time:** a build, a promo render or Blender. Builds use about 1 GB of RAM at peak (Chromium), and promo renders about 1.5 GB.
- **3D on the web deck:** pixel ratio is capped at 1.5, the canvas renders only on the active slide, and there are no shadow maps. Fine on Intel UHD.
- **Promo renders are CPU/GPU-bound but deterministic.** Close other apps, render, then come back.
- **Blender** (see `3d-assets/README.md`): EEVEE, 720p previews, 16–32 samples. Render inside the open session through Blender MCP (background `blender -b` crashes on this iGPU, see the repo `CLAUDE.md`). Export a `.glb` for the web viewer, or render a turntable MP4 for the `video` layout.
- **Install on Windows:** Python 3.11+ (`pip install -r requirements.txt`), Node 18+ with Playwright (`npm i -g playwright && npx playwright install chromium`), FFmpeg (already installed for WhatIfStudio), and optionally LibreOffice for the PPTX render proof.

## 7. Workflow, standard and rubric

See `.claude/skills/world-class-presentation/SKILL.md` (the eight-step workflow) and `quality-control/RUBRIC.md` (the 10-criterion standard).

**Non-negotiable rules:**
- No fabricated statistics, quotes or sources.
- Every number on a slide is cited, and its source is marked `verified` only after someone has opened it.
- The assignment's requirements beat the visuals.
