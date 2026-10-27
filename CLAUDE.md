# WhatIfStudio: project memory for Claude Code

Vertical (9:16) 3D "What If?" city-simulation shorts, built procedurally in **Blender 5.2.2 LTS** through the
**Blender MCP** server, rendered with **EEVEE** on a laptop with **Intel UHD integrated graphics (no dedicated GPU)**.
The owner (Farhan) does voiceover, music and SFX himself in **CapCut**. Never add, generate or claim audio.

## Current episode
**EP001, "What If AI Disappeared Overnight?"**, being rebuilt from a 12-20 s question-only teaser into a
**~75 s story episode, "The Day AI Disappeared"**. That episode shows *what breaks*, hour by hour, in one city.
Script and phase prompts: `docs/EP001_LONG_PROMPTS.md`. Work through those phases in order, and stop for review where they say STOP.

## Golden rules
1. **Never overwrite** an existing `.blend`, frame folder or MP4. New work goes into new files and folders, with a checkpoint before each phase.
2. **Never rebuild the city.** The approved look is the V6 baseline (below). Only add what a story beat needs.
3. **Look at real renders.** Render PNG previews, open them and inspect them. Never claim an event is visible based only
   on keyframes or object counts. Ray-cast from the camera to confirm which object is actually on screen; object names fooled us before.
4. **One heavy job at a time** on this iGPU. No parallel renders.
5. Report exact paths, measured render times and remaining issues. Don't claim "done" until the final file has been verified with ffprobe.

## Key files (root = `C:\Users\User\Documents\Blender\WhatIfStudio`)
| File | What it is |
|---|---|
| `master_city_final.blend` | **Start here.** V6 look + a fix (street light `STREET_Light_001` hidden; the shot-3 camera drove through it). Scene name: `EP001_City_v2`. |
| `master_city_picturelock_base.blend` | Same as above, saved before the 20.5 s retime |
| `master_city_v6.blend`, `_v5`, `_v4_herotest`, `_v3`, `_v2`, `master_city.blend` | History. Read-only. |
| `tools/v2/build_city_v2.py` -> `tools/v2/upgrade_v2.py` -> `tools/v3/upgrade_v3.py` | Original procedural build chain (the city, roads, cars, people, signs) |
| `tools/v4/hero_building_v4.py`, `hero_car_v4.py` | Brick hero tower (Poly Haven kit) and detailed hero car `CAR_02` |
| `tools/v5/aerial_v5.py`, `tools/v6/look_v6.py`, `tools/v6/horizon_v6.py` | Skyline towers, look development (clouds, haze, light), distant city |
| `tools/final/picture_lock.py` | 20.5 s / 30 fps retime (opening hook, end question). Reference for how to retime keys. It saves nothing, and it is **not re-runnable**: it reads the old camera keys at f72/144/216/288, so a second run on the same scene breaks every camera move. |
| `checkpoints/picturelock_30fps_20261027_154727/master_city_picturelock_30fps.blend` | The 20.5 s / 30 fps / 615-frame retime, already applied. `_renderprep.blend` beside it adds the final render settings. |
| `tools/assemble_video.py` | FFmpeg assembly + ffprobe validation (`--episode <folder> --root <root>`). Needs ffmpeg on PATH. |
| `tools/v3/make_people_v3.py`, `assets/people_v3.blend` | 4 posed MPFB/MakeHuman pedestrians (CC0 assets) |
| `assets/polyhaven/modular_urban_apartments_facade/` | Poly Haven CC0 facade kit (1k) |
| `episodes/ai_disappeared_final/output/EP001_What_If_AI_Disappeared_Overnight_9x16.mp4` | Older 12 s / 24 fps export (288 frames). **Keep.** |
| `episodes/ai_disappeared_final_30fps/output/ai_disappeared_final_30fps_9x16.mp4` | **Current final teaser:** 20.5 s, 30 fps, 615 frames, 720×1280, H.264, silent. 16 samples. |

Output convention for a new cut: `episodes/<cut_name>/{frames,previews,output,logs}` with frames named `frame_####.png`.

## Scene facts (scene `EP001_City_v2`)
- Collections: `CITY_BUILDINGS, ROADS, VEHICLES, PEOPLE, BILLBOARDS, LIGHTS, CAMERAS, GRAPHICS, HERO_BLDG_03, DISTANT_CITY`.
- Main intersection at the origin. E-W avenue along X, N-S avenue along Y, both 14 m wide. Lanes at +/-3.5.
- Cameras (Track-To an `<name>_Aim` empty): `CAM_01_Aerial_Approach`, `CAM_02_Billboards`, `CAM_03_Intersection`
  (street level, looking +X, curb at y≈-7.3), `CAM_04_Skyline_Pullback`. Cuts are timeline markers bound to cameras.
- Billboards: `SIGN_1..4_{Screen,Text,Frame}`. Screen materials are `MAT_Sign_N_Panel` and `MAT_Sign_N_Text`, with a Value node **`Power`**.
  The text is a FONT curve, so change `obj.data.body` for new messages. Signs 1 and 3 are on `BLDG_02` (x=-14.5), signs 2 and 4 on the brick hero tower (x=+14.5), all facing -Y at y≈9.3.
- Traffic signals: `SIGNAL_WS/WN/ES/EN`. The green lens uses `MAT_Signal_Green` -> Value node **`SignalPower`**.
- Window and interior glow on every facade family: Value node **`CityPower`** (about 1.0 means alive, about 0.2 means dimmed).
- Moving cars: `CAR_01..04` carry custom props `moving`, `heading`, `start`. The cars' animation is location keys only. `CAR_02` uses the detailed hero mesh `CAR_Hero_v4`. Car meshes share slot 0 = paint, with an object-level material override.
- Pedestrians: `PED_*` objects using meshes `PED_v3_M1/F1/M2/F2`.
- Title text: `TITLE_Closing` (font curve, camera-parented, material `MAT_Title` with Value node `TitleFade` driving a transparent/emission mix).
- Lighting: sun `LIGHT_Sun_Main` (about 5.4 W, 20° elevation, warm), fill `LIGHT_Fill_Sky` (0). The world is a physical sky plus a cloud layer.
  Every material has a distance haze (CameraData -> MapRange -> Mix with emission `HAZE`).
- Colour: AgX, look "AgX - Medium High Contrast", exposure -0.1.

## Render settings that work on this laptop
- Preview: 540×960 at 50%, **4 samples** for animation checks, 12 samples for look checks.
- Final: **720×1280, 32 samples, EEVEE, ray tracing (screen) ON** (benchmarked as almost free), PNG RGB.
- Measured final cost per frame: aerial about 6 s, billboard shot about 9 s, street shot (`CAM_03`) about **15 s**, pull-back about 6 s.
- At **16 samples** (used for the 30 fps final, and indistinguishable from the approved cut: SSIM 0.997): aerial 3 s, billboards 5-6 s, street 6-8 s, pull-back 3-5 s. All 615 frames took about 60 min.
- `render.use_overwrite = False` and `use_placeholder = False`, so re-running a range only fills missing frames.

## Reliable render workflow (important)
- **Background `blender -b` renders crash** on this iGPU (exit 0xC0000409). Render inside the **open Blender session** through MCP.
- MCP calls can time out while Blender keeps rendering. Fire **one chunk per call** (for example one shot of 70-180 frames
  with `bpy.ops.render.render(animation=True)`), then **poll the frames folder** until the count is reached. Never re-fire a chunk while one is still running.
  Better: start the chunk non-blocking with `bpy.ops.render.render("INVOKE_DEFAULT", animation=True)` under
  `bpy.context.temp_override(window=wm.windows[0], scene=sc)`. Add a one-shot `render_complete`/`render_cancel` handler that restores
  `frame_start/end`. The MCP call then returns at once, and `bpy.app.is_job_running("RENDER")` tells you when the chunk is finished.
- After about 3 hours of heavy work, the session has once rendered **black frames and then frozen**. **Restart Blender before a long final render,**
  load the checkpoint into the fresh session, and don't chain hours of rebuilds in one session.
- New objects have an **identity `matrix_world` until the depsgraph updates**. Use `obj.location` math, not `matrix_world`, right after creating them.
- Aerial cameras use `clip_start = 1.0` (depth precision). The street camera uses 0.1.
- Shader compilation makes the first render after material changes slow (20-40 s). Time steady-state renders separately.
- FFmpeg + ffprobe (Gyan essentials build) are on the **user** PATH:
  `C:\Users\User\ffmpeg-2026-10-25-git-46f23be8b1-essentials_build\ffmpeg-2026-10-25-git-46f23be8b1-essentials_build\bin`.
  A shell started before that change won't see it, so prepend the folder to PATH for that command.
  Assemble with `python tools/assemble_video.py --episode <cut_folder> --fps 30` (the default fps is 24).

## Git
Repo: `https://github.com/frhnshishir-dotcom/whatifStudios` (branch `main`). `.blend/.mp4/.png/.jpg/audio` go through **Git LFS**
(`.gitattributes`). `.gitignore` excludes `episodes/*/{frames,previews,test,logs}/` (about 1.3 GB, regenerable). Commit scripts, docs,
checkpoints and final MP4s; never commit rendered frame sequences. The free LFS quota is 1 GB storage, and about 115 MB is used.

## Verification checklist for any export
`ffprobe`: 720×1280, the intended fps, frame count = duration × fps, H.264, yuv420p, a full decode with no errors, no audio stream.
Check that there are no missing or undersized PNGs before encoding. Pull 4-6 stills from the MP4 and look at them, including the hook text and every story event.
