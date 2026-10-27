# EP001 long cut, "The Day AI Disappeared": prompts for Claude Code

Paste these into Claude Code **one at a time**, in order. Each prompt ends with a STOP. Review what Claude Code shows you,
then reply "approved" (or give changes) before pasting the next one. Claude Code reads `CLAUDE.md` automatically,
so it already knows the project, the files, the hardware limits and the render workflow.

Target: **about 76 s, 720×1280, 30 fps, H.264, silent** (you add VO, music and SFX in CapCut).
New cut folder: `episodes/ai_disappeared_long/`. New scene file: `master_city_long.blend`.

---

## The script (v1, edit freely before Phase 1)

Every beat is one consequence of AI vanishing. Each one is plausible, specific and visible on screen. Captions are burned into the
video; the voiceover lines are for you to record in CapCut.

| # | Time | On-screen clock | What we see | Burned-in caption | VO suggestion |
|---|---|---|---|---|---|
| 1 | 0-5 s | 3:00 AM | Night aerial, the city glowing. Every AI billboard cuts out at once | WHAT IF AI DISAPPEARED OVERNIGHT? | "At 3 AM tonight, every AI on Earth goes offline." |
| 2 | 5-12 s | 3:01 AM | Street level at night: screens freeze, then show SYSTEM OFFLINE. Empty streets | AT FIRST… NOBODY NOTICES | "At first… nobody notices." |
| 3 | 12-21 s | 7:30 AM | Morning rush: traffic signals dead, cars jammed in every direction, a couple honking (you add the sound) | TRAFFIC SYSTEMS & NAVIGATION: OFFLINE | "Smart traffic lights and navigation apps go blind. Gridlock in minutes." |
| 4 | 21-30 s | 9:00 AM | Shop and bank screens show CARD DECLINED / PAYMENTS UNAVAILABLE, with a queue of people outside | CARD PAYMENTS FROZEN | "Fraud detection is down. Banks freeze card payments." |
| 5 | 30-38 s | 10:15 AM | The biggest billboard becomes a red stock ticker falling to −27%, then MARKET HALTED | MARKETS CRASH, THEN HALT | "Trading algorithms vanish. Markets crash, then halt." |
| 6 | 38-46 s | 12:00 PM | A line of delivery trucks frozen on the avenue. A shop screen reads OUT OF STOCK | DELIVERIES STOP | "Warehouses stop. Deliveries stop. Shelves start emptying." |
| 7 | 46-55 s | 2:40 PM | An ambulance with flashing lights trapped in the gridlock | EMERGENCY ROUTING FAILS | "Ambulance routing and hospital scans fail. Help can't get through." |
| 8 | 55-64 s | 7:00 PM | Dusk aerial: a wave of blackouts rolls across the city, district by district | ROLLING BLACKOUTS | "Power grids lose their forecasting. Rolling blackouts begin." |
| 9 | 64-70 s | 11:00 PM | Night street: dark windows, stranded cars, people standing around | NO MAPS. NO PAYMENTS. NO ANSWERS. | "Day one is over. No maps. No payments. No answers." |
| 10 | 70-76 s | (none) | Slow pull-back over the dark city | WOULD YOU SURVIVE A WEEK WITHOUT AI? / Comment what breaks first 👇 | "Would you survive a week without AI? Comment what breaks first." |

Optional swaps: "self-driving cars stop dead", "students can't do homework", "translation apps go silent", "factory robots freeze".

---

## Phase 0: orientation and checkpoint

```
Read CLAUDE.md and docs/EP001_LONG_PROMPTS.md.
Then, in the open Blender session through the Blender MCP:
1. Check that Blender responds. If the session already has scenes loaded, ask me before clearing anything.
2. Load scene "EP001_City_v2" from master_city_final.blend into a clean session (libraries.load, link=False).
   Confirm: HERO_BLDG_03 and DISTANT_CITY exist, STREET_Light_001 is hidden, and MAT_V5_Glass_Silver exists.
3. Save a checkpoint copy as master_city_long_base.blend (bpy.data.libraries.write, path_remap="ABSOLUTE"). Never overwrite existing files.
4. Create episodes/ai_disappeared_long/{frames,previews,output,logs}.
5. Check whether ffmpeg/ffprobe are on PATH. If not, tell me the install command (winget install Gyan.FFmpeg); don't install without asking.
6. Report what you found in a short list.
STOP.
```

## Phase 1: lock the shot list (no Blender changes)

```
Using the script table in docs/EP001_LONG_PROMPTS.md (plus any edits I made), produce a shot list for a 30 fps timeline:
for every beat give the frame range, which camera is used (reuse CAM_01..04 where the framing fits; propose a new camera only where none fits,
with position, aim and lens), the camera move, the exact animated events with their frame numbers, the new assets needed, and the burned-in text.
Rules: every consequence must be clearly VISIBLE in frame, not just mentioned in text. Hard cuts between beats are fine.
Keep all text inside the safe area for Reels/TikTok/Shorts: nothing in the bottom 20% or the right 15% of the frame.
Estimate the final render time per beat using the measured per-frame costs in CLAUDE.md, and the total.
Offer one cheaper option (e.g. 16 samples) with its estimate.
STOP and wait for my approval of the shot list.
```

## Phase 2: shared systems (timeline, text overlay, day/night)

```
Implement only the shared systems for the approved shot list, as a new script tools/long/systems_long.py
(idempotent: re-running it must replace its own objects and keys, not duplicate them). Work on the loaded EP001_City_v2 scene.
1. Timeline: 30 fps, frame range from the shot list, camera markers per beat (bind markers to cameras).
2. Text overlay system: a function that creates camera-locked FONT text (parented to whichever camera is active in that beat)
   for (a) a small clock in the top-left safe area, (b) a 1-2 line caption in the upper-middle, and (c) the hook and end card.
   White text with a subtle dark semi-transparent backing plate so it stays readable over sky. Fade in and out over 6-8 frames.
   Reuse the TITLE_Closing font. Clear the old picture_lock title keys.
3. Time of day: keyframe sun energy, elevation and colour, sky strength, and the HAZE colour for night (3 AM), morning (7:30), day, dusk (19:00)
   and night (23:00). At night, street lights (MAT_StreetLamp_Lens "Power") and CityPower windows glow; by day they're off or low.
   Keep it cheap: no volumetrics, no extra lights except as needed.
Then render ONE low-res still (540×960 at 50%, 12 samples) for each lighting state at its beat's camera, open the PNGs, and show me
a contact sheet with the frame numbers labelled. Save master_city_long.blend.
STOP.
```

## Phase 3: build beats in groups, preview each group

Paste these one at a time. Each builds only its beats, previews them and stops.

```
Phase 3A: beats 1-2 (3:00 AM blackout of AI screens; SYSTEM OFFLINE at street level).
Use the existing billboards (SIGN_1..4) and the Power/SignalPower/CityPower hooks. For SYSTEM OFFLINE, change the sign text bodies
(and add a glitch flicker before) rather than adding geometry. Put the code in tools/long/beats_long.py (one function per beat, idempotent).
Render previews at 540×960 50%, 4 samples: first, middle and last frame of each beat, plus each key event frame.
Open the PNGs and check framing, the event is visible, text is readable, nothing clips or blocks the camera (ray-cast near-camera objects).
Fix defects, then show me a labelled contact sheet and a list of the event frames. Save master_city_long.blend (checkpoint first).
STOP.
```

```
Phase 3B: beats 3-4 (7:30 AM gridlock; 9:00 AM card payments frozen + queue).
Gridlock: linked duplicates of the existing car meshes (CAR_Mesh_v3 / CAR_Hero_v4) queued on all four approaches with plausible gaps,
signals dark, cars that crawl and stop (no simulation, just location keys). Queue: linked duplicates of the PED_v3_* meshes lined up
outside a storefront near the street camera. Screens: change sign texts to CARD DECLINED / PAYMENTS UNAVAILABLE (red panels).
Same preview, inspection and contact-sheet procedure as 3A. Report how many objects you added. STOP.
```

```
Phase 3C: beats 5-6 (10:15 AM market crash ticker; 12:00 PM delivery trucks stuck).
Ticker: animate the biggest visible billboard's text body to step through falling values (e.g. −3%, −9%, −18%, −27%, then MARKET HALTED),
with a red panel colour. Trucks: a simple box-truck mesh built from the existing car chassis plus a cargo box (shared mesh, linked duplicates),
4-6 of them stopped in a line on the avenue. One shop screen says OUT OF STOCK.
Same preview, inspection and contact-sheet procedure. STOP.
```

```
Phase 3D: beats 7-10 (ambulance stuck; rolling blackout wave; dark city; end card).
Ambulance: duplicate a car with white paint, a roof light bar with red/blue emission flashing via keyframes, wedged in the gridlock.
Blackout wave: drive CityPower and street-light Power per district so the darkness visibly sweeps across the city over ~3 s. Prefer
per-object or material-group control that avoids hundreds of unique materials (e.g. object-level attribute or object info random/location).
End card: the question and "Comment what breaks first" on the pull-back camera, with no emoji glyphs unless the font supports them.
Same preview, inspection and contact-sheet procedure. STOP.
```

## Phase 4: full animatic check (cheap)

```
Render the whole timeline as a cheap animatic: 360×640, 1-2 samples, every frame, into episodes/ai_disappeared_long/previews/animatic/,
then encode it as animatic.mp4 (30 fps) so I can watch the pacing. While it renders, follow the CLAUDE.md polling workflow (one chunk per call).
Then inspect stills from every beat and list: pacing problems, unreadable text, events that aren't clearly visible, camera clipping, black or
missing frames. Fix only critical problems and re-render only the affected beats in the animatic.
Send me animatic.mp4. STOP.
```

## Phase 5: final render, encode and verify

```
Before rendering: restart Blender (ask me to do it if needed), load master_city_long.blend into a clean session, and save a checkpoint.
Final settings: 720×1280, 30 fps, EEVEE, 32 samples (or the approved cheaper setting), screen ray tracing on, PNG RGB,
output episodes/ai_disappeared_long/frames/frame_####.png, use_overwrite=False, use_placeholder=False.
Render beat by beat (one chunk per MCP call) and poll the frames folder; never fire a new chunk while one is running.
Log the start/end time of each chunk to episodes/ai_disappeared_long/logs/render_log.txt.
When done: check that every frame exists, is 720×1280 and isn't undersized or black (re-render only bad frames).
Encode episodes/ai_disappeared_long/output/EP001_The_Day_AI_Disappeared_9x16.mp4 (H.264 High, yuv420p, crf 18, +faststart, 30 fps, no audio).
Verify with ffprobe (resolution, fps, frame count, duration, codec, no audio), do a full decode, and pull one still per beat and inspect them
(hook readable, every consequence visible, end card readable).
Report: exact output path, total render time, verified properties, and remaining issues. Don't touch the earlier exports.
```

---

### Tips
- If Claude Code reports that Blender stopped responding: close Blender (Task Manager if needed), reopen it, start the MCP server, and tell Claude Code
  "Blender restarted, reload master_city_long.blend and continue from the last checkpoint".
- Set the laptop to never sleep while plugged in before Phase 5 (the final render is several hours).
- Captions are burned in. If you'd rather do captions in CapCut, tell Claude Code in Phase 1 to render a "clean" version without captions too.
