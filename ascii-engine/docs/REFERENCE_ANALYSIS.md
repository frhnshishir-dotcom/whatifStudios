# Reference analysis

Source: the reference video supplied in the session (720x1280, 30 fps, 28.3 s, 848 frames, with audio). It is
third-party content (a creator's Instagram reel), so it is **not committed**. Keep a local copy in
`ascii-engine/reference/` (git-ignored) to run `tools/compare.mjs`. Only the visual techniques are taken; the
character design (a hat-wearing swordsman), captions and branding are not reproduced.

Frames were studied as contact sheets (24 evenly spaced) and full-resolution crops at 3.0, 9.5 and 17.5 s.

## What defines the look
| Trait | Observed | Engine feature that reproduces it |
|---|---|---|
| Frame | 4:5 picture (720x898) centred in 9:16 with black bars ~190 px top and bottom | `meta.letterbox` / `--letterbox 4:5` (PostFX picture rect; camera uses the picture aspect) |
| Figure | A mesh **textured with tiny ASCII letters/digits** (`Z S 2 5 N ...`, a few px tall) in rows on the surface; white-silver; glowing ring at head level and a glowing sash; a few `*` sparkles | `PointCloudCharacter.procedural({ style: 'glyph' })`: smooth surface-nets body, skinned, `createSkinnedGlyphMaterial` (glyph grid mapped in rest pose, AO/curvature shade, rim); `addRing()` for head ring and sash. GLB: `fromObject(..., { surface: true })` |
| Afterimages | 5-6 fading copies of the figure along its path in the opening | `addGhosts(n)`: extra skeletons sharing the body buffers (surface + particle subset), posed at t - k*lag |
| Background text | Rows of monospace characters (`^ ~ _ " = r c s u o a $ 8 #`) on walls and surfaces, in perspective | Font atlas (IBM Plex Mono, OFL) + `text` ramp on `GlyphSurfaceMaterial` |
| Light sources | Lanterns as clusters of bright amber glyphs (`8 $ # @ Q B`) | `createLanterns()` (`lamp` ramp, saturating luminance picks the dense glyphs) + point lights |
| Grass and reeds | Long thin straight lines with a bright bead at the tip; teal, green, olive-yellow; sway | `createReeds()`: GL lines + tip-bead points sharing one sway function |
| Trees | Bonsai-like pines: flat pads of pale cyan short strokes | `createPines()` |
| Water | Dark pond with sparse pale dashes; the figure and lights reflected, rippled | `createPond()` (ripple glyph surface, sets the shared water uniform) + `addReflection()` / `addSurfaceReflection()`; layers dim below the surface |
| Rocks | Pale blue glyph clusters | Pond rim stones with the `text` ramp |
| Roof | Rows of short white dashes running down a curved tiled roof | `createPavilion()`: concave roof surface + down-slope tile strokes + ridge |
| Energy | Tall crimson spire of particles with a white-hot cross flare; red light on the ground | `createBeam()` (drifting cone with taper, core line, `flareSprite`, red rig light) |
| Glitch | Heavy horizontal RGB smear of bands | PostFX `smear` |
| "Power" phase | Whole frame becomes green terminal glyphs (screen grid), the red spire stays red | PostFX `terminal` (screen-space ASCII from the `text` ramp, red preserved) |
| Palette | Black background; white/silver; amber; teal/olive; pale blue; red only on the energy | Scene lighting + glyph colours; red kept local |
| Bloom | Soft glow on rings, lanterns, spire; little grain; no scanlines | `post.params` (scan 0, grain 0.03, bloom 0.85) |

## Differences from the first prototype (built from the written brief only)
- The figure was a luminous **particle cloud**. The reference figure is a **text-textured surface**. Both styles are now available (`style: 'particles' | 'glyph'`).
- The vertical halo disc read as a saint's halo. The reference ring is horizontal at head level (`addRing({ plane: 'xz' })`). The vertical halo remains for other looks.
- The glyphs were a blocky 5x7 bitmap font; the reference uses a smooth monospace font, so font sets were added (`text`, `body`, `tile`, `lamp`).
- The vegetation used short stroke particles; the reference grass is long single lines with tip beads.
- Red dominated the city prototype; in the reference red is reserved for the energy event.
