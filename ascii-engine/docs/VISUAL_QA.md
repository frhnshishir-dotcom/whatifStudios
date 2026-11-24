# Visual QA log (Phases 4-5)

Every judgement here comes from rendered PNG frames or from stills pulled out of the encoded MP4, opened and
inspected. **No reference video was supplied** (not in the request, the repo, or the session uploads), so the
comparison is against the written style brief. When the video is added, run
`node tools/compare.mjs --ref reference/<video>.mp4 --cut ascii_prototype_final_9x16` and redo this checklist side by side.

Renderer for all numbers below: headless Chromium, WebGL 2 on SwiftShader (CPU, 4 cores).

## Iteration 1: first render (draft, frames 75/150/200/250)
| Seen | Cause | Change |
|---|---|---|
| Black silhouette punched through buildings behind the figure | three.js draws opaque objects front-to-back, so the depth-only occluder was drawn before the buildings and blocked them | Occluder `renderOrder = 10`: drawn after the environment, so it only hides the character's own back side |
| Face and torso looked drawn on (cartoon eyes and smile, pen lines for sternum, pecs, hips) | Feature curves too dense and continuous | Replaced with sculpted geometry (eye sockets by smooth subtraction, eyeballs, lips), SDF ambient occlusion and curvature brightness; the remaining feature clusters are sparse and jittered |
| Close-up body sparse and grainy | ~34k body particles at draft | 110k at final, 2.4x density on the head and 1.7x on the hands, 2-bone skinning to pay for it |
| Whole frame washed red | Energy light range 17 m, sky glow 0.9 | Range 12-19 m and lower intensity, sky glow 0.35. Glyph surfaces take only 60% of the light hue |
| Lit windows rendered as solid amber blocks | Window luminance saturated the ramp to the filled-square glyph | Window luminance moved to the upper-middle of the ramp; filled square removed from the `arch` set |
| Trees looked like grey smudges | Depth of field (aperture 0.28-0.4) blurred leaf glyphs into dots | Aperture 0.12 / 0.16 |
| Facades nearly invisible in shadow | Luminance below the first ramp glyph | Emissive floor (`uEmissive`) so the ASCII structure always shows |

## Iteration 2: character turntable (`character_test`, final)
| Seen | Cause | Change |
|---|---|---|
| Readable silhouette, natural walk, clean halo; but the face read as a mask with black holes for eyes and mouth | Face occluder in front of the recessed eyeballs; mouth carve too deep; squared AO too dark | Head occluder shrinks 1.9x more; mouth carve removed (lips alone); AO `0.3 + 0.7*ao` |
| Head a featureless bright egg | 2.4x density at full brightness saturates, so shading disappears | Per-particle brightness divided by `density^0.65` |
| Bright disc/ring at a walking foot | Cylinder-like foot seen end-on stacks its particles; rim light on the grazing top of the foot | Flatter ellipsoid foot with toes; rim damped on upward-facing normals |
| Hard black band behind the figure at torso height | Distant terrain silhouetted (fog colour near black) against the red sky glow | Sky-matched fog: glyph surfaces fade to the **sky colour in the view direction**, so the far terrain dissolves into the glow |
| Grazing facades: windows as flat blocks | Cells < 3 px on one axis fall back to average coverage | Anisotropic fallback keeps rows/columns that are still resolvable (text-line look) |

## Iteration 3: full sequence (`ascii_proto_v2_9x16`, 300 frames, encoded)
- The pipeline's own validator refused the first full render (`ascii_proto_v1_9x16`): `wrong_mode` x300 (the browser
  writes RGBA PNGs) and `undersized` frame 1 (the fade started from pure black). Fixed with raw `readPixels` +
  an RGB PNG encoder in Node, and a fade that starts at 35%. The v1 frames were left untouched; later renders went to new cuts.
- Contact sheet from the MP4: emergence, walk, glitch slicing at the cut, open arms and dissolve all read as intended.
- Close shot: the face turned away (camera 25° off-axis plus the open-arms head tilt). Camera moved more frontal, tilt halved.
- The energy source read as a soft red smudge. A luminous wireframe sphere (latitude rings + meridians) was added and the glow and shell reduced. Then the globe collided with the halo in the close shot. Moving it sideways couldn't clear both shots, so it was raised into a floating crimson "sun" about 15° above the head line in both shots.

## Checks
- **Temporal stability:** three consecutive frames (100-102) cropped and compared. Facade glyphs, windows and body particles hold still; only intended effects change (falling code glyphs re-pick their glyph as their brightness changes).
- **Determinism:** frames 163 and 240 rendered twice in one session are byte-identical, and frame 240 from two separate browser sessions has the same SHA-1 (`fcf1caf...`).
- **16:9:** the close shot frames correctly (open arms, halo, ASCII facade); the camera fov switches per aspect.
- **GLB path:** Khronos CesiumMan (CC-BY, downloaded, not committed) converted to ~94k particles, skinned and animated through its own clip; occluder and halo-follow work.
- **Preview mode:** runs with no console errors, ~6-8 fps on SwiftShader at preview quality (432x768).
- **master vs final:** 4x zoom crops show only marginally smoother edges for ~1.5x the time.
- **Repo tests:** `python -m pytest` 142 passed (the new configs are accepted by the existing validators).

## Final cuts (verified)
| Cut | File | Size | Render (SwiftShader) | Verification |
|---|---|---|---|---|
| `ascii_prototype_final_9x16` | `episodes/ascii_prototype_final_9x16/output/ascii_prototype_final_9x16.mp4` | 14.7 MB | 184,911 particles; 832 ms/frame wall (browser render median 823 ms); 250 s for 300 frames | `assemble_safe.py` + ffprobe: 720x1280, 30 fps, 300 frames, 10.0 s, H.264 yuv420p, no audio, clean decode |
| `ascii_prototype_final_16x9` | `episodes/ascii_prototype_final_16x9/output/ascii_prototype_final_16x9.mp4` | 13.6 MB | 810 ms/frame wall (median 798 ms); 243 s | same, 1280x720 |

Six stills were pulled from each MP4 and inspected (empty street, emergence, walk, glitch cut, close shot, dissolve).
A second assembly of the same frames gave byte-identical file sizes.

## Evaluation against the brief (current prototype)
| Criterion | Assessment |
|---|---|
| Character readability | Strong at wide and medium range: silhouette, proportions, gait, gestures. The face reads at close range (brow, sockets, iris highlights, nose, lips, hair cap) but is not portrait-grade. Hands are mittens |
| Particle density | ~110k on the hero (2.4x on the head). Dense silver body with a luminous rim; close-ups still show visible grain, which suits the aesthetic |
| ASCII pattern quality | Facades are dense, legible ASCII (`H # 0 1 [ ] = -`) with luminance-driven glyph choice; terrain and street are rows of `- = + .`; anisotropic AA prevents moiré. Glyphs stay stable frame to frame |
| Environmental detail | Buildings with windows, edges and beacons; street with lanes, curbs and lamps; teal stroke trees, shrubs and grass with wind; pylons with cables; dust, embers, code rain; energy globe |
| Lighting | Crimson energy and fill, amber lamps and windows, cool key; red stays an accent after iteration 1. Rim light keeps silhouettes |
| Colour balance | Charcoal/black base, silver-white particles, crimson, amber, muted teal; AgX + 0.92 saturation keeps it off neon |
| Depth | Perspective-sized glyphs and particles, sky-matched fog, subtle DOF, glyph LOD, a halo that parallaxes against the head |
| Similarity to the reference | **Not measurable without the video** |

## Open items
- Measure on the laptop's Intel UHD (the render log prints the WebGL renderer and per-frame times).
- Compare with the reference video once it's supplied, and tune ramps, densities and palette from that.
- Optional: articulated fingers, cloth or hair simulation, more vegetation species, a city-scale building generator.
