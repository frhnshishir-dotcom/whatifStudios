import { SIZE, Biome, Water, type Pt, type Special, type Outpost, type OutpostKind, type Village, type Territory, type Habitat, type Fall, type Lake, type Cave, type Trail } from './types';
import { Rng } from '../core/rng';
import { protectedAt, inCircle } from './wilds';
import { OCC_SITE } from './villages';

const W = SIZE;
const RUIN_NAMES = ['Ruins of Caer Vathel', 'The Sunken Keep', 'Old Kingsgate', 'Hollowmere Abbey', 'The Broken Aqueduct', 'Tower of Ashen Glass', 'Ruins of Elmsreach', 'The Weeping Colonnade'];
const DUNGEON_NAMES = ['Gloomhollow Caverns', 'The Drowned Crypt', 'Deepdelve Mine', 'Whisperstone Grotto', 'The Hollow Under Hill', 'Barrow of the Nine', 'Cinderdeep'];
const HAMLET_NAMES = ['Abandoned Ashford', 'Deserted Wrenfield', 'Empty Brackenby', 'Forsaken Mosslee'];

interface Ctx {
  seed: number; height: Float32Array; biome: Uint8Array; water: Uint8Array; forest: Uint8Array; occ: Uint8Array;
  villages: Village[]; territories: Territory[]; habitats: Habitat[];
}

const land = (c: Ctx, x: number, y: number) => x > 4 && y > 4 && x < W - 4 && y < W - 4 && c.biome[y * W + x] !== Biome.Sea && c.water[y * W + x] === Water.None;
const villageDist = (c: Ctx, x: number, y: number) => Math.min(...c.villages.map((v) => Math.hypot(v.centre[0] - x, v.centre[1] - y)));
const prominence = (c: Ctx, x: number, y: number, r = 14) => {
  let s = 0;
  for (let a = 0; a < 8; a++) s += c.height[Math.round(y + Math.sin(a * 0.785) * r) * W + Math.round(x + Math.cos(a * 0.785) * r)];
  return c.height[y * W + x] - s / 8;
};

/** Best-scoring cell from a coarse scan that meets `ok`, at least `gap` from anything in `avoid`. */
function bestCell(_c: Ctx, step: number, score: (x: number, y: number) => number, ok: (x: number, y: number) => boolean, avoid: Array<{ x: number; y: number }>, gap: number): Pt | null {
  let best: Pt | null = null, bs = -Infinity;
  for (let y = 8; y < W - 8; y += step) for (let x = 8; x < W - 8; x += step) {
    if (!ok(x, y) || avoid.some((a) => Math.hypot(a.x - x, a.y - y) < gap)) continue;
    const s = score(x, y);
    if (s > bs) { bs = s; best = [x, y]; }
  }
  return best;
}

/**
 * Ruins, dungeons, landmarks, lairs and abandoned hamlets: the "special locations" share of the land. Kept away from
 * villages; landmarks come from the generated geography (the biggest waterfall, the crater lake, the highest ridge).
 */
export function placeSpecials(c: Ctx, falls: Fall[], lakes: Lake[], caves: Cave[]): Special[] {
  const rng = new Rng('specials', c.seed);
  const out: Special[] = [];
  const add = (kind: Special['kind'], name: string, p: Pt | null, r: number) => { if (p) out.push({ id: `${kind}-${out.length + 1}`, kind, name, x: p[0], y: p[1], r }); };
  for (const t of c.territories) add('lair', `Lair of ${t.dragon.split(',')[0]}`, t.lair, 10);
  const free = (x: number, y: number, m = 0) => !protectedAt(x, y, c.territories, c.habitats, m) && villageDist(c, x, y) > 70;

  const fall = [...falls].sort((a, b) => b.drop - a.drop)[0];
  if (fall) add('landmark', 'Great Falls', [fall.x, fall.y], 24);
  const crater = lakes.find((l) => l.id === 'crater-lake');
  if (crater) add('landmark', 'Crater Lake', [crater.x, crater.y], 30);
  const gh = c.villages.find((v) => v.id === 'greenhaven');
  add('landmark', 'Standing Stones of Hallow Hill', bestCell(c, 4, (x, y) => prominence(c, x, y) + c.height[y * W + x] * 0.1,
    (x, y) => land(c, x, y) && c.biome[y * W + x] === Biome.Heartlands && free(x, y, 10) && (!gh || Math.hypot(gh.centre[0] - x, gh.centre[1] - y) > 80), out, 60), 24);
  add('landmark', 'The Elder Tree', bestCell(c, 4, (x, y) => c.forest[y * W + x] + c.height[y * W + x],
    (x, y) => land(c, x, y) && c.biome[y * W + x] === Biome.Elderwood && free(x, y, 6), out, 60), 24);
  add('landmark', 'Moonpool', bestCell(c, 4, (x, y) => rng.float() + (c.water[y * W + x] === Water.Marsh ? 2 : 0),
    (x, y) => c.biome[y * W + x] === Biome.WhisperingMarshes && c.water[y * W + x] === Water.Marsh && free(x, y, 6), out, 60), 24);
  add('landmark', "The Dragon's Spine", bestCell(c, 4, (x, y) => c.height[y * W + x],
    (x, y) => land(c, x, y) && c.biome[y * W + x] === Biome.DragonPeaks && free(x, y, 15), out, 60), 28);
  add('landmark', 'Sky Arch', bestCell(c, 4, (x, y) => c.height[y * W + x] + rng.float() * 4,
    (x, y) => land(c, x, y) && free(x, y, 6) && c.biome[(y + 8) * W + x] === Biome.Sea, out, 80), 22);

  const spread = (kind: Special['kind'], names: string[], count: number, r: number, gap: number, ok: (x: number, y: number) => boolean, score: (x: number, y: number) => number) => {
    for (let k = 0; k < count; k++) {
      const p = bestCell(c, 6, (x, y) => score(x, y) + rng.float() * 6, ok, out, gap);
      if (!p) break;
      add(kind, names[k % names.length], p, r);
    }
  };
  // Ancient ruins: at most two per biome, so every region has some.
  const perBiome = new Map<number, number>();
  const ruinOk = (x: number, y: number) => land(c, x, y) && free(x, y, 8) && (perBiome.get(c.biome[y * W + x]) ?? 0) < 2;
  for (let k = 0; k < 7; k++) {
    const p = bestCell(c, 6, (x, y) => prominence(c, x, y) * 0.6 + Math.min(villageDist(c, x, y), 200) * 0.03 + rng.float() * 6, ruinOk, out, 85);
    if (!p) break;
    perBiome.set(c.biome[p[1] * W + p[0]], (perBiome.get(c.biome[p[1] * W + p[0]]) ?? 0) + 1);
    add('ruin', RUIN_NAMES[k], p, 32);
  }
  const freeCaves = caves.filter((cv) => !cv.lair && free(cv.x, cv.y, 4));
  for (const cv of freeCaves.slice(0, 5)) if (!out.some((o) => Math.hypot(o.x - cv.x, o.y - cv.y) < 50)) add('dungeon', DUNGEON_NAMES[out.filter((o) => o.kind === 'dungeon').length % DUNGEON_NAMES.length], [cv.x, cv.y], 18);
  spread('dungeon', DUNGEON_NAMES.slice(3), Math.max(0, 5 - out.filter((o) => o.kind === 'dungeon').length), 18, 70,
    (x, y) => land(c, x, y) && free(x, y, 4) && c.height[y * W + x] > 15, (x, y) => prominence(c, x, y));
  spread('abandoned-hamlet', HAMLET_NAMES, 3, 24, 90, (x, y) => land(c, x, y) && free(x, y, 8) && villageDist(c, x, y) > 100 && c.height[y * W + x] < 40,
    (x, y) => -Math.abs(prominence(c, x, y)) * 2);
  for (const s of out) stampOcc(c.occ, s.x, s.y, Math.min(4, s.r));
  return out;
}

function stampOcc(occ: Uint8Array, x: number, y: number, r: number): void {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx > 0 && yy > 0 && xx < W && yy < W && dx * dx + dy * dy <= r * r && occ[yy * W + xx] === 0) occ[yy * W + xx] = OCC_SITE;
  }
}

/**
 * Ranger cabins, hunter camps, mountain shelters, watchtowers and travellers' camps: a limited number, spread
 * organically by what each needs (forest edges, habitat edges, high passes, hilltops near paths, path midpoints).
 */
export function placeOutposts(c: Ctx, trails: Trail[], specials: Special[]): Outpost[] {
  const rng = new Rng('outposts', c.seed);
  const out: Outpost[] = [];
  const taken = () => [...out, ...specials, ...c.villages.map((v) => ({ x: v.centre[0], y: v.centre[1] }))];
  const free = (x: number, y: number) => land(c, x, y) && !protectedAt(x, y, c.territories, c.habitats, 4) && villageDist(c, x, y) > 60;
  // Distance to the nearest path on a 4-cell grid (multi-source BFS), for O(1) lookups.
  const G = W / 4, td = new Float32Array(G * G).fill(1e9);
  let front: number[] = [];
  for (const t of trails) for (const [x, y] of t.cells) { const k = (y >> 2) * G + (x >> 2); if (td[k] !== 0) { td[k] = 0; front.push(k); } }
  for (let d = 1; front.length && d < 40; d++) {
    const next: number[] = [];
    for (const k of front) for (const m of [k - 1, k + 1, k - G, k + G]) if (m >= 0 && m < G * G && td[m] > d * 4) { td[m] = d * 4; next.push(m); }
    front = next;
  }
  const nearTrail = (x: number, y: number) => td[(y >> 2) * G + (x >> 2)];
  const add = (kind: OutpostKind, p: Pt | null) => { if (p) { out.push({ id: `${kind}-${out.length + 1}`, kind, x: p[0], y: p[1], onTrail: false }); stampOcc(c.occ, p[0], p[1], 3); } };
  const spread = (kind: OutpostKind, n: number, gap: number, ok: (x: number, y: number) => boolean, score: (x: number, y: number) => number) => {
    for (let k = 0; k < n; k++) add(kind, bestCell(c, 6, (x, y) => score(x, y) + rng.float() * 8, (x, y) => free(x, y) && ok(x, y), taken(), gap));
  };
  const fr = (x: number, y: number) => c.forest[y * W + x];
  spread('mountain-shelter', 4, 70, (x, y) => c.biome[y * W + x] === Biome.DragonPeaks && c.height[y * W + x] > 50 && c.height[y * W + x] < 115, (x, y) => -Math.abs(prominence(c, x, y)) * 2);
  spread('ranger-cabin', 6, 80, (x, y) => fr(x, y) > 120 && fr(x, y) < 230, (x, y) => -Math.abs(fr(x, y) - 170) / 20);
  for (let k = 0; k < 5; k++) {
    const h = c.habitats[(k * 3 + 1) % c.habitats.length];
    add('hunter-camp', bestCell(c, 4, (x, y) => -Math.abs(Math.hypot(x - h.x, y - h.y) - h.r * 1.05) + rng.float() * 4,
      (x, y) => free(x, y) && Math.hypot(x - h.x, y - h.y) < h.r * 1.5, taken(), 60));
  }
  spread('watchtower', 4, 90, (x, y) => nearTrail(x, y) < 40 && c.biome[y * W + x] !== Biome.WhisperingMarshes, (x, y) => prominence(c, x, y, 18) * 2);
  // Travellers' camps beside the middle of the longest village-to-village paths.
  const long = trails.filter((t) => t.kind !== 'spur' && t.kind !== 'mountain-pass').sort((a, b) => b.cells.length - a.cells.length).slice(0, 4);
  for (const t of long) {
    const [mx, my] = t.cells[t.cells.length >> 1];
    add('travellers-camp', bestCell(c, 2, (x, y) => -Math.hypot(x - mx, y - my), (x, y) => free(x, y) && Math.hypot(x - mx, y - my) < 24 && Math.hypot(x - mx, y - my) > 3, taken(), 40));
  }
  for (const o of out) o.onTrail = nearTrail(o.x, o.y) <= 6;
  return out;
}

export const insideAny = (x: number, y: number, circles: Array<{ x: number; y: number; r: number }>) => circles.some((q) => inCircle(x, y, q, q.r));
