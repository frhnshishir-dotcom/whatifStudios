# Lumenwild changelog

## Visual upgrade, phases A and B
**Phase A (audit).** `docs/VISUAL_AUDIT.md` maps the frame pipeline, glyph rasterisation, terrain, water, object,
particle, light and weather code to exact files and functions, lists the palettes and the problems visible in the
baseline screenshots (`docs/screenshots/before/`), and records baseline performance.

**Phase B (glyphs, palettes, character shading)**, in `render/TerrainShader.ts`, `render/glyphs.ts`,
`env/Atmosphere.ts`, `env/Environment.ts`:
- Curated glyph families for every material (grass, meadow, forest floor, moss, dirt, stone path, sand, mud, stone,
  cliff, glowing moss) and ground cover (short and tall grass, wildflowers, ferns, reeds, moss patches, leaf
  litter, clover), each in three density tiers. 44 new glyphs (fine blades, tufts, pebbles, cobbles, dotted moss,
  flow marks), all from the bundled fonts.
- Clumped, deterministic density: a clump noise field mixed with a per-cell hash, so vegetation forms tufts and
  bare patches instead of an even sprinkle. Nothing changes between frames.
- Soft material borders: each cell blends its ground colour with differing neighbours (jittered weights), and
  vegetation glyphs creep across borders. Stone and cliff keep crisp edges; paths a soft one.
- Painterly palettes: richer greens, warmer paths that no longer look like stone, cooler blue-grey rock with
  mottling, low-frequency brighter/darker swathes, dry olive and lush blue-green patches by moisture.
- Glyph colour runs from a family tint to a tip colour by density and sunlight (sun-facing slopes highlight).
- Faces: rock strata and soil layers follow absolute height, so layers line up across columns; vegetated lips
  drip grass; rock edges catch the light.
- Depth attenuation: the far (upper) rows fade slightly toward a sky haze that follows the time of day (pale teal
  by day, warm at dusk, deep blue at night). Off in low-performance mode.
- Tests: `tests/shading.test.ts` (deterministic shading, soft vegetation borders and crisp rock, clumped density,
  lit versus shaded slopes). 76 unit tests and 28 browser tests pass.
- Performance (126 x 60 characters): 60 fps, compose 1.3 ms (was 1.4-1.6), blit 0.2 ms. Full-world shading at
  load 33 ms (was 11 ms); an edit re-shades a 16 x 16 chunk in 0.2 ms (was 0.12 ms).
- Screenshots: `docs/screenshots/after-phase-b/` (same nine views as `before/`).
