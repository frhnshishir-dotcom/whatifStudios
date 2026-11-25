# Lumenwild visual audit (Phase A)

Source: the full TypeScript project in `lumenwild/src` (not a compiled bundle). Baseline screenshots of the nine
review views: `docs/screenshots/before/` (seed 7, captured from commit `8b1af73` with `lw_views.mjs`).

## Frame pipeline (per animation frame)

| Step | File / function | What it does |
|---|---|---|
| 1 | `engine/Engine.ts` `frame()` | fixed-step sims (main-thread water only), editor tick, layer state (wind, night, selection) |
| 2 | `render/Composer.ts` `compose()` | `TerrainShader.update()`, `CellBuffer.clear(rowBg)`, every layer's `prepare()`, then the oblique projection: per column, back to front, each world cell writes its top (`topGlyph/topFg/topBg`) and its front face rows (`TerrainShader.face()`), water replaces the surface through `surfaceHeight/drawSurface/drawFace` |
| 3 | layers' `after()` in order | `objects/ObjectLayer` (sprites, depth-tested), particle layer (`render/Particles.draw`), `env/Atmosphere` (grass sway, light, fog), `edit/EditorOverlay` |
| 4 | `render/Renderer.ts` `draw()` → `render/Blitter.ts` `blit()` | glyph masks blended fg/bg into one `Uint32Array`, unchanged cells skipped, one `putImageData` |

## Glyph rasterisation
- `render/glyphs.ts`: the registry (`GLYPH_DEFS`), three modes: `base` (letters on the font baseline), `center`
  (symbol fitted and centred in the cell), `proc` (blocks, shades, lines drawn pixel-exact).
- `render/GlyphAtlas.ts` `GlyphAtlas.bake()`: rasterises every glyph once per cell size with `fillText` into 8-bit
  masks (`drawProcedural` for `proc`). Fonts are bundled (Noto Sans Mono, Noto Sans Symbols 2, DejaVu Sans Mono).

## Terrain rendering
- `render/TerrainShader.ts` `shadeChunk()`: per cell, Lambert hillshade (light from upper left) × 5x5 ambient
  occlusion, a 3-stop background gradient per material (`MAT_LOOK`), a cover glyph set (`COVER_LOOK`) chosen by a
  per-cell hash, glyph colour = background mixed toward a tint at a fixed contrast. Cached per 16x16 chunk, rebuilt
  when `world.terrainDirty` is set.
- `face()`: cliff sides (soil, rock, moss, diorama base), with short steps drawn as grassy banks.

## Water rendering
- `water/WaterSim.ts` (authoritative state, run by `water/water.worker.ts` or the main thread): depth, velocity,
  ripple field, waterfall flux and landing cell. The visual layer reads these through `WaterView`.
- `water/WaterLayer.ts`: `surfaceHeight` (which cells show water), `drawSurface` (depth gradient `WATER`, shore
  blend with `topBg`, ripple rings, flow stripes, calm shimmer), `drawFace` (waterfall columns), `prepare` (splash
  and mist spawning).

## Objects, particles, light and weather
- `objects/defs.ts`: sprite builders per kind (`roundTree`, `pineTree`, `rockSprite`, `mushroomSprite`, ...),
  cached per object by `ObjectStore.sprite()`; `objects/ObjectLayer.ts` draws them with sway, glow, lit windows
  and the mill wheel.
- `render/Particles.ts`: pooled splash, mist, leaf, floating leaf, firefly, rain, pollen, spark.
- `env/Environment.ts`: time of day, weather targets, ambient colour, gusts. `env/Atmosphere.ts`: particle
  spawning, grass sway, ambient multiply, point lights, emissive cells, fog.

## Colour palettes (before)
- Terrain: `MAT_LOOK` (11 materials, 3-stop gradients), `COVER_LOOK` (8 covers), `FLOWER_COLORS` (6), faces
  `SOIL/ROCK/MOSS/BASE_FACE`.
- Water: `WATER` gradient `#3cbcb0 → #0b3a50`, `LIGHT`, `FOAM`, `RING`, `FALL_BG`, `DEEP`.
- Trees: `TREE_LOOK` (oak, birch, willow, blossom) and the pine builder; rocks, mushrooms, buildings in `defs.ts`.

## What looks wrong in the baseline screenshots
1. **Hard material borders.** Grass, meadow, forest floor and stone meet in straight-edged blocks with an abrupt
   colour jump: the map reads as large pixel rectangles rather than a painted landscape.
2. **Uniform glyph noise.** Cover glyphs are picked per cell by an independent hash, so grass is an even sprinkle of
   `ψ " | '` everywhere: busy at a distance, no tufts, no bare patches.
3. **Flat areas.** Inside a material the colour varies only with slope and ±3 % per cell: big meadows are flat.
4. **Stone and paths look alike** (both mid grey with sparse dots); stone has no lit edge or texture.
5. **No depth cue** across the view: the far (top) rows look as close as the near rows.
6. Trees have opaque dark rectangles behind the canopy and repeat the same silhouettes (Phase D).
7. Water banks are straight tan strips; deep water has few highlights (Phase C).

## Performance (before, 126 x 60 characters, headless Chromium, software rasteriser)
60 fps; compose 1.4-1.6 ms, blit 0.2 ms, put 0.6 ms; worst case (zoomed out, night storm) compose 6.5 ms.
Hot spots: `Composer.compose` projection loop (scales with columns x visible rows + lift), `Atmosphere.light`
(full-frame multiply when not neutral), `Blitter.blit` when many cells change (rain, sway). Terrain shading is
cached, so richer per-cell shading costs only at chunk rebuild time.
