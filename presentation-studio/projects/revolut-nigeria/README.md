# Revolut in Nigeria: Understanding Culture Before Entering the Market

INSEEC Business School, Cross-Cultural Communication. A **hypothetical** international market-entry case study. It is not an official Revolut communication.

## Final deliverables (`presentation-studio/exports/revolut-nigeria/FINAL/`)

| File | What it is |
|---|---|
| `REVOLUT_NIGERIA_FINAL.pptx` | Editable 16:9 deck: 12 slides plus a references appendix, notes on every slide, and the 30 s film embedded with sound (click once on slide 10 to play it). Uses Office fonts (Calibri) so it looks identical on any classroom PC. |
| `REVOLUT_NIGERIA_FINAL.pdf` | PDF of the deck in the designed typefaces (Space Grotesk / Inter / IBM Plex Mono). |
| `REVOLUT_NIGERIA_CAMPAIGN_30SEC.mp4` | Master film: 30.000 s, 1920×1080, 30 fps, H.264 + AAC, -15.5 LUFS. |
| `REVOLUT_NIGERIA_CAMPAIGN_30SEC_share.mp4` | Smaller copy (~5.3 MB, with sound), the same one embedded in the PPTX. Use it for email or messaging. |
| `REVOLUT_NIGERIA_CAMPAIGN_POSTER.png` | Campaign key visual (1600×2000). |
| `REVOLUT_NIGERIA_CAMPAIGN_THUMBNAIL.jpg` | Video cover (1920×1080). |
| `REVOLUT_NIGERIA_SPEAKER_NOTES.docx / .pdf` | Full speaker script with a timing table (about 14.5 min including the film). |
| `REVOLUT_NIGERIA_REFERENCES.docx / .pdf` | APA 7 references, an evidence log (each figure → exact source sentence → page), figures dropped from the brief and why, and AI/asset disclosures. |
| `REVOLUT_NIGERIA_CONTACT_SHEET.png` / `_WEB.png` | Every slide at a glance (PowerPoint render and web render). |
| `REVOLUT_NIGERIA_WEB_DECK.zip` | Offline cinematic web version: open `index.html`; press S for notes, F for fullscreen. |
| `slides/` | Every slide as a 1920×1080 PNG. |

## Before presenting
1. Open the `.pptx` in PowerPoint once and play slide 10, to check that the video plays on that PC. If it doesn't, the film is also in `FINAL/` as an MP4.
2. Add your names to slide 1 (it reads "INSEEC Business School · Cross-Cultural Communication").
3. Rehearse with the speaker notes: about 14.5 minutes. Cut notes if your slot is shorter.
4. Listen to the film once with sound. The music is synthesized and the voiceover is AI; neither was reviewed by a human ear before delivery.

## Project structure (`projects/revolut-nigeria/`)
```
deck.json              the whole deck: slides, copy, notes, sources (edit this, then rebuild)
spots/                 motion-graphics segments of the film (opener, interface reveal, end frame)
scripts/
  make_assets.py         Lagos photo grade + logo removal, Nigeria dot map
  concept_ui.html        conceptual phone interface  -> render_ui.cjs
  key_visuals.html       poster + thumbnail          -> render_key_visuals.cjs
  make_music.py          original music bed + SFX (numpy)
  assemble_campaign.py   cuts the 30 s film (FFmpeg) and verifies it
research/              CBN report (2025), EFInA A2F 2026 pages, course text extract, map outline
notes/                 speaker notes + references (Markdown sources, DOCX, PDF)
assets/                images, AI video shots, voiceover lines, music (not in git: binary)
```

## Regenerate
Run from `presentation-studio/`:
```bash
python projects/revolut-nigeria/scripts/make_assets.py           # graded photo + map
node projects/revolut-nigeria/scripts/render_ui.cjs              # concept phone UI
node projects/revolut-nigeria/scripts/render_key_visuals.cjs     # poster + thumbnail
python projects/revolut-nigeria/scripts/make_music.py            # music + SFX
python studio.py promo revolut-nigeria seg_opener                # also: seg_reveal, seg_endcard
python projects/revolut-nigeria/scripts/assemble_campaign.py --vo projects/revolut-nigeria/assets/audio/vo_lines.json
python studio.py build revolut-nigeria --fonts portable          # PPTX, PDF, web deck, PNGs, notes, QA
```
To replace the voiceover (for example with a Nigerian voice artist), record the five lines as separate files, list them in `assets/audio/vo_lines.json`, and re-run `assemble_campaign.py`. To replace an AI shot, overwrite `assets/video/ai_shot_<name>.mp4` and re-run it.

## Credits
- **AI footage:** MiniMax H3 via vidIQ.
- **Voiceover:** vidIQ, voice "Lily".
- **Photo:** Clara Sanchiz, "Lagos skyline" (CC BY-SA 2.0), adapted.
- **Map:** Natural Earth (public domain).
- **Fonts:** Space Grotesk, Inter and IBM Plex Mono (all SIL OFL).
- **Music and SFX:** original.

Full list in the references document.
