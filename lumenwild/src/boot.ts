import { FONT_CHARS } from './engine/render/glyphs';
import { World } from './engine/world/World';
import { Engine } from './engine/Engine';
import { generateTerrain } from './engine/gen/terrain';

/** Load the bundled fonts for every glyph the atlas needs (unicode-range subsets load on demand). */
export async function loadFonts(timeoutMs = 5000): Promise<void> {
  const loads = Promise.all([
    document.fonts.load('16px "Noto Sans Mono"', FONT_CHARS),
    document.fonts.load('16px "Noto Sans Symbols 2"', FONT_CHARS),
  ]);
  await Promise.race([loads, new Promise((r) => setTimeout(r, timeoutMs))]);
}

export function createWorld(seed: number, size = 256): World {
  const world = new World(size, size);
  world.seed = seed;
  world.name = `Vale ${seed}`;
  generateTerrain(world, seed);
  return world;
}

export function createEngine(seed: number): Engine {
  return new Engine(createWorld(seed));
}
