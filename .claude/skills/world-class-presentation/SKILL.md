---
name: world-class-presentation
description: Full research → story → design → motion → build → QA workflow for an agency-grade presentation (PPTX + PDF + cinematic HTML + slide PNGs + speaker script + references + optional ad videos), using presentation-studio/. Trigger when the user says "CREATE A WORLD-CLASS PRESENTATION", or asks for a presentation, deck, slides, pitch, keynote, school or university presentation, or a promo/ad video for a presentation.
---

# CREATE A WORLD-CLASS PRESENTATION

You are the creative director, researcher, designer, motion designer and production engineer. Read
`presentation-studio/PRESENTATION_STUDIO.md` first: it is the operating manual (commands, layouts,
transitions, spot schema, font modes, laptop limits). Work in `presentation-studio/`.

## Non-negotiables
- **Never fabricate** statistics, quotes, sources, logos or "official" assets. Every number on a slide has a `cite`.
  A source is `"verified": true` only after you opened it and found the figure. If you can't verify a number, cut it.
- **The assignment beats the visuals.** Grading criteria, required sections, slide count and duration are hard gates.
  Put them in `meta.must_cover`, `slide_count` and `duration_min` so QA enforces them.
- Brands: use official brand colours and typography only from the brand's own guidelines or press kit. Never
  imitate a real company's identity as if it were theirs, and never recreate their ads. References (Apple, NVIDIA, …)
  are a quality bar, not something to copy.
- Never claim it works without a build: `python studio.py build <p>` must end in PASS, and you must look at
  `qa/contact_html.png` and `qa/contact_pptx.png` yourself.
- The laptop is 8 GB RAM with an Intel iGPU: one heavy job at a time (build, promo render or Blender).

## Step 1: Understand the assignment
Ask only for what is missing and blocks the work:
- topic
- audience
- duration
- slide count
- grading criteria or rubric
- required sections
- citation style
- brand or school constraints
- delivery (who presents, on what PC)

Copy `research/BRIEF_TEMPLATE.md` into `projects/<p>/brief.md` and fill it in. Then run
`python studio.py new <p> --template academic|keynote --system <system>`.

## Step 2: Research
Follow `research/RESEARCH_PROTOCOL.md`:
- Prefer official and primary sources. Use World Bank and OpenAlex via `research/tools/`, WebSearch, the web-fetch agent, and the `anthropic-skills:deep-research` skill for broad questions.
- Save the raw data in `projects/<p>/research/` and record every source in `sources.json` with its URL and access date.

## Step 3: Narrative
Product-launch structure:
1. **Hook.** A surprising true fact or a question.
2. **Stakes.** Why it matters to this audience.
3. **Three movements.** Each a section, and each with one message per slide.
4. **Proof.** Data, a case or a demo.
5. **The reveal or answer.**
6. **One-sentence close.**

For academic work add:
- an agenda
- methodology or framework
- analysis
- limitations
- conclusion
- references

Write the speaker notes now, at about 130 words per minute.

## Step 4: Creative direction
Write the direction into `brief.md`:
- concept in one line
- design system (or a new one copied from `design-systems/`)
- palette (60/30/10)
- type pairing
- image direction
- motion direction
- transition grammar
- the one recurring visual motif

Pick the system by subject:
- **monolith:** launch or tech
- **lumen:** business or brand
- **signal:** AI, data or engineering
- **scholar:** academic

## Step 5: Visual assets
These are the "crazy visuals". Each must serve the story.
- **Backgrounds:** procedural `nebula`, `beams`, `liquid`, `aurora`, `grid`, `horizon`, `spotlight`, `mesh` (per-slide `bg`).
- **3D hero objects:** the `product` layout `viewer` kinds `globe`, `device`, `sculpture` and `orbits`, or a `.glb` file. Get stills with `node 3d-assets/web/render_still.cjs`.
- **Blender** (if the laptop is attached through Blender MCP): product renders and turntables at EEVEE with low samples, rendered in the open session.
- **Ad videos:** write `projects/<p>/spots/<name>.json` (kinetic → reveal → stat → list → endcard), run `python studio.py promo <p> <name>`, check `*_frames.jpg` and the poster, then place it with the `video` layout. Make a `--format 9:16` cut for social.
- **Images:** real, licensed and attributed. Wikimedia Commons, Openverse, Poly Haven, or the brand's press kit. Each image becomes a `sources` entry with `"type": "image"` and its licence.
- **AI images** go through connected tools only, with the user's OK: Canva `generate-image`, Gamma `generate_image`, vidIQ `image_generate` (costs credits). Never present AI images as real photos.

## Step 6: Motion
Design each transition on purpose:
- **morph:** continuity of the same object
- **iris** or **zoom:** a reveal
- **cube** or **flip:** a change of chapter
- **fade** or **rise:** within a section

Use at most two or three transition types per deck. Builds should use `rise` for content and `none` for dense academic slides if asked.

## Step 7: Build and inspect
Run `python studio.py build <p>` (add `--fonts portable` if it will be presented on an unknown PC). Then:
1. Fix every FAIL in `qa/report.md`.
2. Read every slide image in `exports/<p>/slides/` and both contact sheets.
3. Check typography, spacing, alignment, hierarchy, contrast, image sharpness, text accuracy and timing.
4. Rebuild and repeat until clean.
5. Score the `quality-control/RUBRIC.md` table honestly and fix anything below 4.

## Step 8: Deliver
Give exact paths to:
- `.pptx`
- `.pdf`
- `web/index.html`
- `slides/`
- the speaker script
- `sources.md`
- the videos

Also report:
- the QA result
- the font mode, plus the font install instruction if it's brand
- anything unverified or left for the user (rehearsal, audio for the videos)

Offer to publish the web deck as a private Artifact.
