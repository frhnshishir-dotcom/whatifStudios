import { SIZE, Water, type Territory, type Habitat, type Cave } from './types';
import { VILLAGE_DESIGNS } from './cultures';

/** Dragon territories: large, roadless wilderness around each dragon's lair. Villages keep well clear of them. */
export const TERRITORY_DESIGNS = [
  { id: 'emberfang', name: "Emberfang's Reach", dragon: 'Emberfang, obsidian elder dragon', x: 470, y: 150, r: 85, search: 55 },
  { id: 'thornmaw', name: 'Thornmaw Hollow', dragon: 'Thornmaw, forest drake', x: 805, y: 312, r: 60, search: 25 },
  { id: 'mirewyrm', name: 'Mirewyrm Fen', dragon: 'Mirewyrm, marsh wyrm', x: 808, y: 768, r: 52, search: 15 },
  { id: 'elderwing', name: 'Elderwing Roost', dragon: 'Elderwing, old green dragon', x: 125, y: 352, r: 45, search: 20 },
];

/** Wildlife habitats (cores stay free of farms, roads and camps; hunters camp at their edges). */
export const HABITAT_DESIGNS: Habitat[] = [
  { id: 'heartland-meadows', species: ['red deer', 'hare', 'pheasant'], x: 578, y: 522, r: 48 },
  { id: 'elder-glades', species: ['red deer', 'boar', 'badger'], x: 178, y: 438, r: 42 },
  { id: 'thornwild-range', species: ['grey wolf', 'lynx', 'elk'], x: 700, y: 445, r: 55 },
  { id: 'foothill-range', species: ['grey wolf', 'mountain goat'], x: 312, y: 248, r: 42 },
  { id: 'high-crags', species: ['mountain goat', 'golden eagle', 'snow hare'], x: 585, y: 175, r: 50 },
  { id: 'reed-beds', species: ['heron', 'otter', 'marsh harrier', 'frog'], x: 772, y: 678, r: 45 },
  { id: 'open-steppe', species: ['wild horse', 'bustard', 'fox'], x: 108, y: 688, r: 42 },
  { id: 'deepwood', species: ['brown bear', 'owl', 'pine marten'], x: 228, y: 298, r: 38 },
];

/** Place territories: centre on the highest ground nearby; the lair is a cave inside it (one is cut if none exists). */
export function placeTerritories(height: Float32Array, water: Uint8Array, caves: Cave[]): Territory[] {
  const W = SIZE;
  return TERRITORY_DESIGNS.map((d) => {
    let bx = d.x, by = d.y, bh = -1e9;
    for (let y = d.y - d.search; y <= d.y + d.search; y += 2) for (let x = d.x - d.search; x <= d.x + d.search; x += 2) {
      if (x < 0 || y < 0 || x >= W || y >= W || Math.hypot(x - d.x, y - d.y) > d.search) continue;
      const i = y * W + x;
      // Keep every village at least 60 cells outside the territory.
      if (VILLAGE_DESIGNS.some((v) => Math.hypot(v.at[0] - x, v.at[1] - y) < d.r + 60)) continue;
      if (!water[i] && height[i] > bh) { bh = height[i]; bx = x; by = y; }
    }
    let lair = caves.find((c) => !c.lair && Math.hypot(c.x - bx, c.y - by) < d.r * 0.5);
    if (!lair) { lair = { x: bx, y: by, lair: true }; caves.push(lair); }
    lair.lair = true;
    return { id: d.id, name: d.name, dragon: d.dragon, x: bx, y: by, r: d.r, lair: [lair.x, lair.y] };
  });
}

export const inCircle = (x: number, y: number, c: { x: number; y: number }, r: number) => (x - c.x) ** 2 + (y - c.y) ** 2 <= r * r;

/** True if (x, y) is inside a territory or a habitat core (0.75 r), widened by `margin`. */
export function protectedAt(x: number, y: number, terr: Territory[], hab: Habitat[], margin = 0): boolean {
  for (const t of terr) if (inCircle(x, y, t, t.r + margin)) return true;
  for (const h of hab) if (inCircle(x, y, h, h.r * 0.75 + margin)) return true;
  return false;
}

export const isWater = (water: Uint8Array, i: number) => water[i] !== Water.None;
