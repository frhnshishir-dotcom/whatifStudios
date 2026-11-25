import { g } from '../render/glyphs';
import { hex, pack, type RGB } from '../core/color';
import { hash2 } from '../core/rng';

// Object kinds, their editable properties, footprints and ASCII sprites. Sprites are lists of glyph cells relative
// to the anchor cell: (dx, dy) on the ground grid, `up` rows above the ground surface, packed fg/bg (bg 0 =
// transparent) and an animation code applied at draw time (sway, glow pulse, lit windows, mill wheel...).

export const OBJ_KINDS = ['tree', 'rock', 'mushroom', 'bridge', 'cottage', 'mill', 'stone'] as const;
export type ObjKind = (typeof OBJ_KINDS)[number];

export interface WorldObject {
  id: number;
  kind: ObjKind;
  x: number;
  y: number;
  variant: string;
  props: Record<string, number>;
}

export const Anim = { None: 0, Sway: 1, Glow: 2, Window: 3, Wheel: 4, Spark: 5, SwayStrand: 6, Twinkle: 7 } as const;

export interface SpriteCell { dx: number; dy: number; up: number; g: number; fg: number; bg: number; anim: number }
export interface PropSpec { key: string; label: string; min: number; max: number; step: number }
export interface LightSpec { r: number; color: RGB; intensity: number; up: number }

export interface ObjectDef {
  label: string;
  variants: string[];
  props: PropSpec[];
  defaults: Record<string, number>;
  /** Ground cells occupied (relative to the anchor). */
  footprint(o: WorldObject): Array<[number, number]>;
  /** Solid objects block water (rocks, buildings). */
  solid: boolean;
  sprite(o: WorldObject): SpriteCell[];
  light?(o: WorldObject): LightSpec | null;
}

const C = (s: string) => hex(s);
const P = (c: RGB, k = 1) => pack(c[0] * k, c[1] * k, c[2] * k);
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ------------------------------------------------------------------ trees
const LEAF_GLYPHS = [g('♣'), g('♠'), g('❦'), g('♣'), g('☘'), g('♣')];
const EDGE_GLYPHS = [g(','), g('\''), g('"'), g('’'), g('`')];
const TREE_LOOK: Record<string, { bg: RGB; lo: RGB; hi: RGB; trunk: RGB; glyphs: number[] }> = {
  oak: { bg: C('#183e1f'), lo: C('#3f8a43'), hi: C('#a6dc78'), trunk: C('#6b4a2e'), glyphs: LEAF_GLYPHS },
  birch: { bg: C('#2a4a1c'), lo: C('#8ab84e'), hi: C('#e0ec88'), trunk: C('#ece6d6'), glyphs: [g('♣'), g('*'), g('❋'), g('♧')] },
  willow: { bg: C('#223f1c'), lo: C('#78a84e'), hi: C('#cfe07a'), trunk: C('#5e4a30'), glyphs: [g('♣'), g('¦'), g('"'), g('♧')] },
  blossom: { bg: C('#4a1c3e'), lo: C('#e88ac4'), hi: C('#ffe0f2'), trunk: C('#4a3326'), glyphs: [g('❀'), g('✿'), g('❁'), g('✾')] },
};

function roundTree(o: WorldObject, species: string): SpriteCell[] {
  const L = TREE_LOOK[species];
  const size = o.props.size ?? 2, seed = o.props.seed ?? o.id;
  const cells: SpriteCell[] = [];
  const trunkH = species === 'birch' ? 2 + (size > 2 ? 1 : 0) : 1 + (size > 1 ? 1 : 0);
  const rx = species === 'willow' ? 2 + size : 1 + size, ry = species === 'birch' ? Math.max(1, size - 1) : Math.max(1, Math.round(size * 0.8));
  const cUp = trunkH + ry;
  for (let u = 0; u < trunkH; u++) {
    const birchMark = species === 'birch' && hash2(seed, u, 3) > 0.5;
    cells.push({ dx: 0, dy: 0, up: u, g: birchMark ? g(':') : size > 2 ? g('┃') : g('│'), fg: P(L.trunk, birchMark ? 0.45 : 1), bg: u === 0 ? 0 : 0, anim: 0 });
  }
  for (let cy = -ry; cy <= ry; cy++) {
    for (let cx = -rx; cx <= rx; cx++) {
      const n = (cx / (rx + 0.5)) ** 2 + (cy / (ry + 0.5)) ** 2 + (hash2(seed + cx, cy, 9) - 0.5) * 0.35;
      if (n > 1) continue;
      const light = 0.5 + (-cx / (rx + 1)) * 0.25 + (cy / (ry + 1)) * 0.25 + (hash2(seed, cx * 31 + cy, 5) - 0.5) * 0.25;
      const edge = n > 0.62;
      const gl = edge ? EDGE_GLYPHS[Math.floor(hash2(seed + 7, cx, cy) * EDGE_GLYPHS.length)] : L.glyphs[Math.floor(hash2(seed, cx, cy + 11) * L.glyphs.length)];
      const fg = mixc(L.lo, L.hi, Math.max(0, Math.min(1, light)));
      cells.push({ dx: cx, dy: 0, up: cUp + cy, g: gl, fg: P(fg), bg: edge ? 0 : P(L.bg, 0.8 + light * 0.4), anim: cy >= 0 ? Anim.Sway : 0 });
    }
  }
  if (species === 'willow') {
    // Drooping strands under the outer canopy.
    for (const cx of [-rx, -rx + 1, rx - 1, rx]) for (let k = 1; k <= 2; k++) {
      if (hash2(seed, cx, k) < 0.25) continue;
      cells.push({ dx: cx, dy: 0, up: cUp - ry - k + 1, g: k === 2 ? g('\'') : g('¦'), fg: P(mixc(L.lo, L.hi, 0.5)), bg: 0, anim: Anim.SwayStrand });
    }
  }
  if (species === 'blossom') for (const c of cells) if (c.up >= trunkH) c.anim = Anim.Glow;
  return cells;
}

function pineTree(o: WorldObject): SpriteCell[] {
  const size = o.props.size ?? 2, seed = o.props.seed ?? o.id;
  const tiers = 2 + size * 2;
  const bg = C('#0f3322'), lo = C('#2f7a52'), hi = C('#8ed0a0');
  const cells: SpriteCell[] = [{ dx: 0, dy: 0, up: 0, g: g('┃'), fg: P(C('#5a3e26')), bg: 0, anim: 0 }];
  for (let k = 0; k < tiers; k++) {
    const up = tiers - k; // top tier highest
    const half = Math.floor(k * 0.6);
    for (let cx = -half; cx <= half; cx++) {
      const edgeL = cx === -half && half > 0, edgeR = cx === half && half > 0;
      const gl = k === 0 ? g('▴') : edgeL ? g('◢') : edgeR ? g('◣') : hash2(seed, cx, k) > 0.6 ? g('▲') : g('♠');
      const light = 0.55 - cx / (half + 2) * 0.3 - k / tiers * 0.2 + (hash2(seed + 3, cx, k) - 0.5) * 0.2;
      const fg = mixc(lo, hi, Math.max(0, Math.min(1, light)));
      cells.push({ dx: cx, dy: 0, up, g: gl, fg: P(fg), bg: edgeL || edgeR || k === 0 ? 0 : P(bg, 0.85 + light * 0.3), anim: k < tiers / 2 ? Anim.Sway : 0 });
    }
  }
  return cells;
}

// ------------------------------------------------------------------ rocks, stones, mushrooms
const ROCK_LIGHT = C('#a3a7a0'), ROCK_MID = C('#6f736c'), ROCK_DARK = C('#3a3d37'), MOSS = C('#6f9a52');

function rockSprite(o: WorldObject): SpriteCell[] {
  const seed = o.props.seed ?? o.id, mossy = (o.props.moss ?? 0) > 0.5;
  const top = (k: number) => (mossy ? P(MOSS, 0.9 + k * 0.2) : P(ROCK_LIGHT, 0.9 + k * 0.15));
  const v = o.variant;
  if (v === 'boulder') {
    return [
      { dx: 0, dy: 0, up: 0, g: g('▓'), fg: P(ROCK_LIGHT), bg: P(ROCK_MID), anim: 0 },
      { dx: 0, dy: 0, up: 1, g: g('▄'), fg: top(hash2(seed, 1, 1)), bg: 0, anim: 0 },
    ];
  }
  if (v === 'big') {
    const cells: SpriteCell[] = [];
    for (let dx = 0; dx < 2; dx++) {
      cells.push({ dx, dy: 1, up: 0, g: g('▓'), fg: P(ROCK_MID), bg: P(ROCK_DARK), anim: 0 });
      cells.push({ dx, dy: 1, up: 1, g: g(hash2(seed, dx, 2) > 0.5 ? '█' : '▓'), fg: P(ROCK_LIGHT, 0.95), bg: P(ROCK_MID), anim: 0 });
      cells.push({ dx, dy: 1, up: 2, g: g('▄'), fg: top(hash2(seed, dx, 3)), bg: 0, anim: 0 });
    }
    return cells;
  }
  // formation: a ragged three-wide outcrop
  const h = [1 + Math.round(hash2(seed, 0, 1) * 2), 3, 1 + Math.round(hash2(seed, 2, 1) * 2)];
  const cells: SpriteCell[] = [];
  for (let dx = 0; dx < 3; dx++) {
    for (let up = 0; up < h[dx]; up++) cells.push({ dx, dy: 1, up, g: g(up % 2 ? '▓' : '█'), fg: P(ROCK_LIGHT, 0.75 + up * 0.08), bg: P(ROCK_MID, 0.8), anim: 0 });
    cells.push({ dx, dy: 1, up: h[dx], g: g('▄'), fg: top(hash2(seed, dx, 7)), bg: 0, anim: 0 });
  }
  return cells;
}

function standingStone(o: WorldObject): SpriteCell[] {
  const runeGlow = (o.props.glow ?? 1) > 0;
  return [
    { dx: 0, dy: 0, up: 0, g: g('█'), fg: P(C('#7d8478')), bg: P(ROCK_DARK), anim: 0 },
    { dx: 0, dy: 0, up: 1, g: runeGlow ? g('✱') : g('▓'), fg: runeGlow ? P(C('#9ffcf0')) : P(ROCK_LIGHT), bg: P(C('#5d645a')), anim: runeGlow ? Anim.Glow : 0 },
    { dx: 0, dy: 0, up: 2, g: g('▄'), fg: P(C('#8d9488')), bg: 0, anim: 0 },
  ];
}

const MUSH: Record<string, { cap: RGB; glow: boolean }> = {
  red: { cap: C('#e5584a'), glow: false },
  brown: { cap: C('#c08a52'), glow: false },
  glow: { cap: C('#7ff4e2'), glow: true },
  violet: { cap: C('#c69cff'), glow: true },
};

function mushroomSprite(o: WorldObject): SpriteCell[] {
  const m = MUSH[o.variant] ?? MUSH.red;
  const n = Math.max(1, Math.min(3, o.props.count ?? 1));
  const cells: SpriteCell[] = [{ dx: 0, dy: 0, up: 0, g: g('◓'), fg: P(m.cap), bg: m.glow ? P(m.cap, 0.28) : 0, anim: m.glow ? Anim.Glow : 0 }];
  if (n >= 2) cells.push({ dx: 1, dy: 0, up: 0, g: g('◒'), fg: P(m.cap, 0.85), bg: 0, anim: m.glow ? Anim.Glow : 0 });
  if (n >= 3) cells.push({ dx: 0, dy: 0, up: 1, g: g('·'), fg: P(m.cap, 1.1), bg: 0, anim: m.glow ? Anim.Spark : 0 });
  return cells;
}

// ------------------------------------------------------------------ structures
const WOOD = C('#8a5f3a'), WOOD_HI = C('#c8915c'), WOOD_DARK = C('#3e2816');

function bridgeSprite(o: WorldObject): SpriteCell[] {
  const L = Math.max(3, o.props.length ?? 7);
  const cells: SpriteCell[] = [];
  for (let dx = 0; dx < L; dx++) {
    const end = dx === 0 || dx === L - 1;
    cells.push({ dx, dy: 0, up: 0, g: end ? g('▓') : g('═'), fg: P(end ? C('#8a8a80') : WOOD_HI), bg: P(end ? C('#4a4a44') : WOOD_DARK), anim: 0 });
    cells.push({ dx, dy: 0, up: 1, g: dx === 0 ? g('┌') : dx === L - 1 ? g('┐') : dx % 3 === 0 ? g('┬') : g('─'), fg: P(WOOD), bg: 0, anim: 0 });
  }
  return cells;
}

const PLASTER = C('#dccbaa'), TIMBER = C('#5c3f28'), ROOF = C('#9a4636'), ROOF_HI = C('#c96a52'), WINDOW = C('#ffd27a'), STONE = C('#8c8a80');

function cottageSprite(o: WorldObject): SpriteCell[] {
  const slate = o.variant === 'slate';
  const roof = slate ? C('#5f6b78') : ROOF, roofHi = slate ? C('#8a97a6') : ROOF_HI;
  const cells: SpriteCell[] = [];
  const dy = 2; // facade on the front row of the 5 x 3 footprint
  for (let dx = 0; dx < 5; dx++) cells.push({ dx, dy, up: 0, g: g('▀'), fg: P(STONE), bg: P(C('#4a4842')), anim: 0 });
  const wall = ['█', '▫', '▌', '▫', '█'];
  wall.forEach((ch, dx) => {
    const win = ch === '▫', door = ch === '▌';
    cells.push({ dx, dy, up: 1, g: g(ch), fg: P(win ? WINDOW : door ? C('#6a4426') : PLASTER), bg: P(win ? C('#3a2c18') : door ? TIMBER : PLASTER, win || door ? 1 : 0.85), anim: win ? Anim.Window : 0 });
  });
  for (let dx = -1; dx <= 5; dx++) {
    const ch = dx === -1 ? '╱' : dx === 5 ? '╲' : '▒';
    cells.push({ dx, dy, up: 2, g: g(ch), fg: P(ch === '▒' ? roofHi : roof), bg: ch === '▒' ? P(roof, 0.8) : 0, anim: 0 });
  }
  for (let dx = 0; dx <= 4; dx++) {
    const ch = dx === 0 ? '╱' : dx === 4 ? '╲' : '▒';
    cells.push({ dx, dy, up: 3, g: g(ch), fg: P(ch === '▒' ? roofHi : roof, 1.05), bg: ch === '▒' ? P(roof, 0.9) : 0, anim: 0 });
  }
  cells.push({ dx: 3, dy, up: 4, g: g('▮'), fg: P(STONE), bg: 0, anim: 0 });
  return cells;
}

/** Ring order of the 8 wheel rim cells, clockwise from the top-left (index encoded in the anim code). */
export const WHEEL_RING: Array<[number, number]> = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const MILL_STONE = C('#a7a294'), MILL_STONE_DK = C('#5d594f'), MILL_ROOF = C('#7a4a30'), MILL_ROOF_HI = C('#b0704a');

function millSprite(o: WorldObject): SpriteCell[] {
  // 4 x 3 two-storey stone mill; the wheel (a 3 x 3 wooden disc) stands one cell outside the house on `wheelSide`,
  // its lower rim in the race water. Wheel cells carry their ring position so the layer can rotate the paddles.
  const cells: SpriteCell[] = [];
  const dy = 2;
  for (let dx = 0; dx < 4; dx++) cells.push({ dx, dy, up: 0, g: g('▀'), fg: P(STONE), bg: P(C('#4a4842')), anim: 0 });
  const lower = ['▓', '▌', '▫', '▓'], upper = ['▓', '▫', '▓', '▓'];
  [lower, upper].forEach((row, r) => row.forEach((ch, dx) => {
    const win = ch === '▫', door = ch === '▌';
    cells.push({
      dx, dy, up: 1 + r, g: g(ch),
      fg: P(win ? WINDOW : door ? C('#6a4426') : MILL_STONE, dx === 0 || dx === 3 ? 0.92 : 1),
      bg: P(win ? C('#3a2c18') : door ? TIMBER : MILL_STONE_DK, win || door ? 1 : 0.95),
      anim: win ? Anim.Window : 0,
    });
  }));
  for (let dx = -1; dx <= 4; dx++) {
    const ch = dx === -1 ? '╱' : dx === 4 ? '╲' : '▒';
    cells.push({ dx, dy, up: 3, g: g(ch), fg: P(ch === '▒' ? MILL_ROOF_HI : MILL_ROOF), bg: ch === '▒' ? P(MILL_ROOF, 0.8) : 0, anim: 0 });
  }
  for (let dx = 0; dx <= 3; dx++) {
    const ch = dx === 0 ? '╱' : dx === 3 ? '╲' : '▒';
    cells.push({ dx, dy, up: 4, g: g(ch), fg: P(ch === '▒' ? MILL_ROOF_HI : MILL_ROOF, 1.05), bg: ch === '▒' ? P(MILL_ROOF, 0.9) : 0, anim: 0 });
  }
  const side = (o.props.wheelSide ?? 1) > 0 ? 1 : -1;
  const wx = side > 0 ? 5 : -2;
  cells.push({ dx: wx, dy, up: 1, g: g('✱'), fg: P(C('#e0bd84')), bg: P(WOOD_DARK), anim: Anim.Wheel });
  WHEEL_RING.forEach(([rx, ry], k) => {
    cells.push({ dx: wx + rx, dy, up: 1 - ry, g: g('·'), fg: P(WOOD_HI), bg: P(WOOD_DARK, 1.15), anim: Anim.Wheel + (k + 1) * 16 });
  });
  return cells;
}

// ------------------------------------------------------------------ Christmas tree
// A big decorated fir: six widening tiers with triangle-glyph silhouettes, needles lit from the upper left, gold
// garlands on alternate tiers, baubles, a glowing star, a trunk and presents. Bulbs carry Anim.Twinkle with a
// per-bulb phase (bits 4..7) so they cycle colours out of step; the layer draws them emissive.
const XMAS_TIERS: Array<[number, number, number]> = [[0, 2, 3], [1, 3, 4], [2, 4, 4], [2, 5, 4], [3, 6, 4], [4, 7, 5]];
const XMAS_ROWS = XMAS_TIERS.reduce((s, t) => s + t[2], 0);
const XG_DK = C('#123a24'), XG_LIT = C('#3c8a4c'), XN_DK = C('#4c9a5e'), XN_LIT = C('#a6e6a0');
const BAUBLES = ['#e8403a', '#3e7ee8', '#f0b82a', '#c84ad0', '#f4f0ea'].map(C);
const PRESENTS: Array<[RGB, RGB]> = [[C('#c8323a'), C('#ffd45a')], [C('#2f62c8'), C('#f4f4f4')], [C('#2f8a4a'), C('#e8403a')], [C('#8a3ac0'), C('#ffd45a')]];
export const XMAS_FOOTPRINT: Array<[number, number]> = [[-3, 0], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [3, 0]];

function christmasTree(o: WorldObject): SpriteCell[] {
  const cells: SpriteCell[] = [];
  const seed = o.props.seed ?? o.id;
  const hh = (a: number, b: number, s: number) => hash2(a + seed * 31, b, s);
  const needles = [g('▲'), g('▲'), g('♠'), g('▴'), g('♣'), g('▲')];
  const topUp = 3 + XMAS_ROWS - 1;
  let up = topUp, tier = 0;
  for (const [top, bot, rows] of XMAS_TIERS) {
    for (let j = 0; j < rows; j++, up--) {
      const hw = Math.round(top + ((bot - top) * j) / Math.max(1, rows - 1));
      const garlandRow = tier % 2 === 1 && j === rows - 2;
      for (let dx = -hw; dx <= hw; dx++) {
        const side = dx / (hw + 0.5);
        const light = Math.max(0, Math.min(1, 0.58 - side * 0.34 - (j / rows) * 0.12 + (hh(dx, up, 4) - 0.5) * 0.1));
        const bg = mixc(XG_DK, XG_LIT, light);
        if (hw > 0 && Math.abs(dx) === hw) {
          // Silhouette: a triangle filled with the needle colour, open to the outside.
          cells.push({ dx, dy: 0, up, g: g(dx < 0 ? '◢' : '◣'), fg: P(bg, 1.05), bg: 0, anim: 0 });
          continue;
        }
        const r = hh(dx, up, 7);
        if (garlandRow && r < 0.85) {
          cells.push({ dx, dy: 0, up, g: g('‿'), fg: P(C('#ffd45a'), 0.85 + r * 0.2), bg: P(bg), anim: Anim.Glow });
        } else if (r < 0.24 || (j === rows - 1 && Math.abs(dx) === hw - 1 && hw > 1)) {
          cells.push({ dx, dy: 0, up, g: g('•'), fg: P(C('#fff4d0')), bg: P(bg), anim: Anim.Twinkle + (Math.floor(hh(dx, up, 9) * 16) << 4) });
        } else if (r < 0.33) {
          const b = BAUBLES[Math.floor(hh(dx, up, 11) * BAUBLES.length)];
          cells.push({ dx, dy: 0, up, g: g('●'), fg: P(b), bg: P(bg), anim: 0 });
        } else {
          const ng = needles[Math.floor(hh(dx, up, 13) * needles.length)];
          cells.push({ dx, dy: 0, up, g: ng, fg: P(mixc(XN_DK, XN_LIT, Math.min(1, light + 0.15))), bg: P(bg), anim: 0 });
        }
      }
    }
    tier++;
  }
  // Star with two small rays.
  cells.push({ dx: 0, dy: 0, up: topUp + 1, g: g('✸'), fg: P(C('#ffe27a')), bg: 0, anim: Anim.Glow });
  cells.push({ dx: -1, dy: 0, up: topUp + 1, g: g('✧'), fg: P(C('#ffeaa8')), bg: 0, anim: Anim.Glow });
  cells.push({ dx: 1, dy: 0, up: topUp + 1, g: g('✧'), fg: P(C('#ffeaa8')), bg: 0, anim: Anim.Glow });
  // Trunk (two rows) and the base row with a red skirt and presents.
  const BARK = C('#6a4426'), BARK_DK = C('#3a2414');
  for (const u of [1, 2]) {
    cells.push({ dx: -1, dy: 0, up: u, g: g('▐'), fg: P(BARK, 0.9), bg: 0, anim: 0 });
    cells.push({ dx: 0, dy: 0, up: u, g: g('▓'), fg: P(BARK), bg: P(BARK_DK), anim: 0 });
    cells.push({ dx: 1, dy: 0, up: u, g: g('▌'), fg: P(BARK, 0.8), bg: 0, anim: 0 });
  }
  cells.push({ dx: 0, dy: 0, up: 0, g: g('█'), fg: P(BARK, 0.85), bg: P(BARK_DK), anim: 0 });
  for (const dx of [-1, 1]) cells.push({ dx, dy: 0, up: 0, g: g('▀'), fg: P(C('#a8262c')), bg: 0, anim: 0 });
  [-3, -2, 2, 3].forEach((dx, k) => {
    const [box, ribbon] = PRESENTS[(k + Math.floor(seed)) % PRESENTS.length];
    cells.push({ dx, dy: 0, up: 0, g: g('┼'), fg: P(ribbon), bg: P(box), anim: 0 });
  });
  cells.push({ dx: -2, dy: 0, up: 1, g: g('┼'), fg: P(PRESENTS[(seed + 2) % 4][1]), bg: P(PRESENTS[(seed + 2) % 4][0], 0.9), anim: 0 });
  return cells;
}

// ------------------------------------------------------------------ registry
const rect = (w: number, h: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) out.push([dx, dy]);
  return out;
};

export const OBJECT_DEFS: Record<ObjKind, ObjectDef> = {
  tree: {
    label: 'Tree', variants: ['oak', 'pine', 'birch', 'willow', 'blossom', 'christmas'],
    props: [{ key: 'size', label: 'Size', min: 1, max: 3, step: 1 }, { key: 'seed', label: 'Shape seed', min: 0, max: 999, step: 1 }],
    defaults: { size: 2, seed: 1 }, solid: false,
    footprint: (o) => (o.variant === 'christmas' ? XMAS_FOOTPRINT : [[0, 0]]),
    sprite: (o) => (o.variant === 'christmas' ? christmasTree(o) : o.variant === 'pine' ? pineTree(o) : roundTree(o, o.variant in TREE_LOOK ? o.variant : 'oak')),
    light: (o) => (o.variant === 'blossom' ? { r: 5, color: C('#ff9ad8'), intensity: 0.45, up: 3 }
      : o.variant === 'christmas' ? { r: 12, color: C('#ffd08a'), intensity: 1.2, up: 11 } : null),
  },
  rock: {
    label: 'Rock', variants: ['boulder', 'big', 'formation'],
    props: [{ key: 'moss', label: 'Moss', min: 0, max: 1, step: 1 }, { key: 'seed', label: 'Shape seed', min: 0, max: 999, step: 1 }],
    defaults: { moss: 0, seed: 1 }, solid: true,
    footprint: (o) => (o.variant === 'boulder' ? [[0, 0]] : o.variant === 'big' ? rect(2, 2) : rect(3, 2)),
    sprite: rockSprite,
  },
  stone: {
    label: 'Standing stone', variants: ['rune'],
    props: [{ key: 'glow', label: 'Rune glow', min: 0, max: 1, step: 1 }], defaults: { glow: 1 }, solid: true,
    footprint: () => [[0, 0]], sprite: standingStone,
    light: (o) => ((o.props.glow ?? 1) > 0 ? { r: 5, color: C('#7ff4e2'), intensity: 0.7, up: 1 } : null),
  },
  mushroom: {
    label: 'Mushrooms', variants: ['red', 'brown', 'glow', 'violet'],
    props: [{ key: 'count', label: 'Cluster', min: 1, max: 3, step: 1 }], defaults: { count: 2 }, solid: false,
    footprint: () => [[0, 0]], sprite: mushroomSprite,
    light: (o) => (MUSH[o.variant]?.glow ? { r: 4, color: MUSH[o.variant].cap, intensity: 0.75, up: 0 } : null),
  },
  bridge: {
    label: 'Bridge', variants: ['wood'],
    props: [{ key: 'length', label: 'Length', min: 3, max: 16, step: 1 }, { key: 'z', label: 'Deck height', min: -5, max: 40, step: 0.1 }],
    defaults: { length: 7, z: 5 }, solid: false,
    footprint: (o) => Array.from({ length: Math.max(3, o.props.length ?? 7) }, (_, i) => [i, 0] as [number, number]),
    sprite: bridgeSprite,
  },
  cottage: {
    label: 'Cottage', variants: ['terracotta', 'slate'],
    props: [], defaults: {}, solid: true,
    footprint: () => rect(5, 3), sprite: cottageSprite,
    light: () => ({ r: 8, color: C('#ffc46a'), intensity: 1.05, up: 1 }),
  },
  mill: {
    label: 'Water mill', variants: ['stone'],
    props: [{ key: 'wheelSide', label: 'Wheel side (-1 left, 1 right)', min: -1, max: 1, step: 2 }], defaults: { wheelSide: 1 }, solid: true,
    footprint: () => rect(4, 3), sprite: millSprite,
    light: () => ({ r: 7, color: C('#ffc46a'), intensity: 0.9, up: 1 }),
  },
};
