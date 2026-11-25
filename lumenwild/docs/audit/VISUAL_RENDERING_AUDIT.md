# Visual rendering audit (Phase 0)

## 1. The reference

File: `ascii-engine/reference/reference.mp4` (git-ignored local copy, byte-identical to the uploaded reel; Instagram
@ZTRYFU, 28.3 s, 720 x 1280, 30 fps). Eight frames were extracted and inspected for this audit. What is visible
(appearance only; nothing here says how it was made):

- **True 3D geometry with a perspective three-quarter camera.** Roof planes, the pond and the character converge in
  perspective. The camera moves and the glyph patterns stay attached to the surfaces.
- **Glyphs live on surfaces.** Roof tiles are rows of characters following the roof slope; walls and the ground carry
  their own glyph grids at different densities. This is closer to world-space glyph texturing than to a flat
  screen-space "ASCII filter".
- **Grass is dense stroke geometry** (thin coloured blades), not glyph cells.
- **The character is a bright glyph/point silhouette** that reads clearly against dark surroundings.
- **Lighting:** a dark navy base, warm amber windows, cool highlights on foliage. The red pillar washes nearby surfaces
  red. During the green transformation the whole frame turns green; the new brief asks for this to be local and
  temporary instead.
- **Water reflects** the character and lights.

`ascii-engine/docs/REFERENCE_ANALYSIS.md` holds the earlier, longer analysis of the same reel.

## 2. The current Lumenwild renderer

| Stage | Location | What it does |
|---|---|---|
| Glyph atlas | `src/engine/render/GlyphAtlas.ts:33` | Bakes ~300 glyphs into 8-bit masks once per cell size |
| Terrain look | `src/engine/render/TerrainShader.ts:157` | Caches glyph, foreground and background per world cell; rebuilt per dirty 16 x 16 chunk |
| Projection | `src/engine/render/Composer.ts:55` | Oblique 2.5D: each world cell's top and cliff face become screen cells, back to front per column |
| Layers | `Engine.ts:122` | Water surface and falls, object sprites, particles, dragon poses, atmosphere (light, fog, grade), editor overlay |
| Present | `src/engine/render/Blitter.ts:18`, `Renderer.ts:56` | CPU mask blend into a `Uint32Array`, one `putImageData` |

**What it is:** a character-grid renderer of a heightfield. Every screen cell is one glyph with one foreground and one
background colour. There is no 3D geometry, no perspective, no rotation and no GPU.

**Strengths to keep:** stable, deterministic glyph choice (no flicker); dense, readable art direction; correct occlusion
in the oblique view; a per-cell `pick` buffer for exact editor picking; a per-cell emissive channel (`CellBuffer.light`);
everything at 60 fps on a CPU rasteriser.

## 3. Gap against the reference and the new brief

| Quality | Reference / brief | Lumenwild today | Gap |
|---|---|---|---|
| 3D depth | Perspective 3D, three-quarter view | Oblique 2.5D, fixed direction | **Large**: needs a 3D renderer |
| Glyphs on geometry | Glyph grids follow surfaces | Glyph per screen cell | Large |
| Silhouettes and characters | Bright, readable | Dragon readable since the recolour; no player characters | Medium |
| Ambient + moonlight | Restrained, cool | Ambient colour by time of day (`env/Environment.ts`) | Small |
| Point lights, warm windows | Strong local pools | Point lights from object `LightSpec` (`env/Atmosphere.ts:223`) | Small |
| Emissive materials | Yes | `CellBuffer.light` channel | Small |
| Shadows / contact shadows | Yes | Baked hillshade and AO only; dragon ground shadow | Medium (3D) |
| Selective bloom | Yes | None | Medium (needs GPU) |
| Fog | Volumetric-looking | Screen-space drifting veil and depth haze | Medium |
| Red pillar, green transformation | Signature effects | None (particles and lights exist) | Medium |
| Palette system per biome | Required | Palettes are constants spread over 5 files | Medium |
| Grass blades as geometry | Yes | Glyph texture plus sway | Large (3D) |
| Water reflection | Yes | None | Medium |

## 4. Can the architecture take a WebGL2 upgrade? Yes, in two separable ways

The simulation (World, WaterView, ObjectStore, Dragon, Environment) never touches the canvas. Renderers only read it.
That gives two seams:

### Option R1: GPU presenter for the existing character grid (low risk)
Replace `Blitter` + `putImageData` with a WebGL2 pass. Each frame, upload the `CellBuffer` (glyph index R16UI,
foreground and background RGBA8, light R8: about 75 KB for 126 x 60 cells) and draw one full-screen triangle whose
fragment shader samples the glyph atlas as a texture array.
- **Keeps:** the exact current look, picking, editor, all layers. Canvas 2D stays as the fallback.
- **Gains:** removes 1.0-1.6 ms of CPU per moving frame; enables selective bloom on emissive cells, smooth sub-cell
  scrolling, and moving the atmosphere's per-cell light/fog/grade passes (up to 3.1 ms) into the shader.
- **Does not give:** 3D depth or perspective.

### Option R2: a real 3D view of the same world (the reference look; larger)
A second renderer, behind a flag at first, that builds 3D scene data from the existing state:
- terrain: heightfield mesh from `World.elev` (256 x 256 = 65,536 vertices), material IDs as a texture;
- water: a surface mesh displaced by the worker's `depth`/`ripple` arrays (uploaded as float textures, 256 KB each);
- objects: instanced low-poly meshes per kind (trees, rocks, buildings, bridge, mill, cave);
- dragon: a mesh built from the anatomical model already in `dragon/DragonPoses.ts` (body, wing bones, membranes);
- ASCII: world-space glyph surfaces (glyph grids in surface UV space, stable under camera motion), plus a screen-space
  glyph quantisation pass for anything without surface UVs. `ascii-engine/src/shaders/GlyphSurfaceMaterial.js` already
  implements world-space glyph surfaces with a luminance ramp, jitter, windows and reflections; `ascii-engine/src/post/PostFX.js`
  implements dual-filter bloom with tone mapping. These are reusable designs, not drop-in code (offline budgets).

**Why not only a screen-space ASCII filter:** quantising the final image into cells makes glyphs crawl across
surfaces whenever the camera moves (temporal instability). World-space glyph grids stick to geometry, which is what
the reference shows. A screen-space pass is still useful for particles, effects and distant geometry.

**What R2 changes:** picking moves from the `pick` buffer to ray casting against the heightfield (straightforward);
the editor overlay becomes projected decals; sprites need 3D counterparts (new assets).

### Library choice for R2
- **Three.js** (already used by `ascii-engine`, MIT, about 150 KB gzip for the core): scene graph, instancing, shadow
  maps, skinning, loaders. **The original Lumenwild brief banned Three.js; this needs your explicit approval.**
- **Raw WebGL2:** no dependency, more code. Sensible for R1 (one pass), weaker for R2 (shadows, skinning, instancing
  done by hand).
- Recommendation: R1 in raw WebGL2; R2 with Three.js if you lift the ban.

## 5. Capability check

In the audit browser (headless Chromium, SwiftShader): WebGL2 available, `MAX_TEXTURE_SIZE` 8192, 32 texture units,
float render targets (`EXT_color_buffer_float`). Intel UHD graphics normally expose WebGL2 through ANGLE/Direct3D 11 in
Chrome and Edge, but this has **not been verified on your laptop**. Phase 1 starts with a capability probe that prints
the renderer string and limits, so that is measured rather than assumed.

## 6. Lighting, colour and effects: what exists

- Ambient and time-of-day colour, warm dusk, blue night: `env/Environment.ts`.
- Point lights from objects (cottage, mill, cave, mushrooms, stones, Christmas tree): `objects/defs.ts` `light()`.
- Emissive cells survive the night: `CellBuffer.light`, written by `ObjectLayer` and `DragonRenderer`.
- Fog, depth haze, colour grade: `env/Atmosphere.ts`.
- Missing: shadows, bloom, tone mapping, a palette/biome registry, an effects framework (beam, aura, transformation).

## 7. Recommendation

1. Keep the 2.5D character renderer: it is the working game, the editor view and the low-end fallback.
2. Phase 1a: R1 (GPU presenter) with pixel-equivalence tests against the current output, then selective glow from the
   emissive channel and a central palette registry.
3. Phase 1b: R2 as an experimental 3D view of the same world, judged against the reference with side-by-side frames.
   It becomes the primary view only after it reaches parity (terrain, water, objects, dragon, picking) and meets the
   laptop's frame budget.
