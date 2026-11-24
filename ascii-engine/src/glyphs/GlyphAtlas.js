import * as THREE from 'three';

// Procedural glyph atlas. A bitmap 5x7 font (identical on every OS, no system font) plus vector marks,
// drawn on a canvas. 16x16 cells of 32 px (512x512). Each row is a "set"; ramp sets are sorted by measured
// ink coverage so a luminance value maps straight to a glyph column (classic ASCII ramp, but in 3D).

export const CELL = 32;
export const GRID = 16;

// prettier-ignore
const FONT = {
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '..#..', '.....'],
  ',': ['.....', '.....', '.....', '.....', '..#..', '..#..', '.#...'],
  "'": ['..#..', '..#..', '.....', '.....', '.....', '.....', '.....'],
  '`': ['.#...', '..#..', '.....', '.....', '.....', '.....', '.....'],
  '"': ['.#.#.', '.#.#.', '.....', '.....', '.....', '.....', '.....'],
  ':': ['.....', '..#..', '.....', '.....', '.....', '..#..', '.....'],
  ';': ['.....', '..#..', '.....', '.....', '..#..', '..#..', '.#...'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  '_': ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '*': ['.....', '#.#.#', '.###.', '#####', '.###.', '#.#.#', '.....'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '%': ['##...', '##..#', '...#.', '..#..', '.#...', '#..##', '...##'],
  '@': ['.###.', '#...#', '#.###', '#.#.#', '#.###', '#....', '.####'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '\\': ['#....', '#....', '.#...', '..#..', '...#.', '....#', '....#'],
  '|': ['..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  '[': ['.###.', '.#...', '.#...', '.#...', '.#...', '.#...', '.###.'],
  ']': ['.###.', '...#.', '...#.', '...#.', '...#.', '...#.', '.###.'],
  '<': ['...#.', '..#..', '.#...', '#....', '.#...', '..#..', '...#.'],
  '>': ['.#...', '..#..', '...#.', '....#', '...#.', '..#..', '.#...'],
  '^': ['..#..', '.#.#.', '#...#', '.....', '.....', '.....', '.....'],
  'v': ['.....', '.....', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  '~': ['.....', '.....', '.#...', '#.#.#', '...#.', '.....', '.....'],
  'o': ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  'x': ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  'y': ['.....', '.....', '#...#', '#...#', '.####', '....#', '.###.'],
  'Y': ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  'I': ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'M': ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  'N': ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'W': ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '$': ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
};

// Vector marks (drawn with canvas paths, centred in the cell).
const MARKS = {
  DOT: (g) => { g.beginPath(); g.arc(16, 16, 3.2, 0, Math.PI * 2); g.fill(); },
  DOT2: (g) => { g.beginPath(); g.arc(16, 16, 6, 0, Math.PI * 2); g.fill(); },
  RING: (g) => { g.lineWidth = 2.5; g.beginPath(); g.arc(16, 16, 9, 0, Math.PI * 2); g.stroke(); },
  SQ: (g) => { g.lineWidth = 2.5; g.strokeRect(8, 8, 16, 16); },
  SQF: (g) => { g.fillRect(10, 10, 12, 12); },
  DIA: (g) => { g.lineWidth = 2.5; g.beginPath(); g.moveTo(16, 6); g.lineTo(26, 16); g.lineTo(16, 26); g.lineTo(6, 16); g.closePath(); g.stroke(); },
  CROSS: (g) => { g.lineWidth = 2.5; g.beginPath(); g.moveTo(8, 8); g.lineTo(24, 24); g.moveTo(24, 8); g.lineTo(8, 24); g.stroke(); },
  PLUS: (g) => { g.lineWidth = 2.5; g.beginPath(); g.moveTo(16, 7); g.lineTo(16, 25); g.moveTo(7, 16); g.lineTo(25, 16); g.stroke(); },
  TRI: (g) => { g.lineWidth = 2.5; g.beginPath(); g.moveTo(16, 7); g.lineTo(25, 24); g.lineTo(7, 24); g.closePath(); g.stroke(); },
  GRID: (g) => { g.lineWidth = 2; g.beginPath(); for (const v of [11, 21]) { g.moveTo(v, 6); g.lineTo(v, 26); g.moveTo(6, v); g.lineTo(26, v); } g.stroke(); },
  BAR: (g) => { g.fillRect(13, 4, 6, 24); },
  TICK: (g) => { g.fillRect(14.5, 9, 3, 14); },
  // Strokes: drawn horizontally, rotated in the shader along the particle tangent.
  DASH: (g) => { g.fillRect(9, 14.5, 14, 3); },
  LINE: (g) => { g.fillRect(2, 15, 28, 2); },
  DASH2: (g) => { g.fillRect(4, 10, 24, 2.5); g.fillRect(4, 19.5, 24, 2.5); },
  HAIR: (g) => { g.lineWidth = 1.6; g.beginPath(); g.moveTo(3, 18); g.quadraticCurveTo(16, 12, 29, 15); g.stroke(); },
};

// Set rows. `ramp: true` sets are sorted by coverage (dark -> bright).
export const SETS = [
  { name: 'ramp', ramp: true, glyphs: ['.', '`', ':', '-', '=', '+', '*', 'o', '#', '%', '@'] },
  { name: 'arch', ramp: true, glyphs: ['.', ':', '-', '_', '=', '|', '+', '[', ']', 'H', '#', '0', '1', 'SQ', 'GRID', 'x'] },
  { name: 'veg', ramp: true, glyphs: [',', "'", '`', '.', '/', '\\', '|', 'v', 'y', 'Y', '^', '(', ')', '*', 'TICK', '"'] },
  { name: 'terrain', ramp: true, glyphs: ['.', ',', '`', '-', '_', '~', ':', '=', '+', 'x', '#'] },
  { name: 'char', ramp: true, glyphs: ['DOT', '.', ':', '+', 'PLUS', '*', 'o', 'DOT2', 'x', '0', '#', '@'] },
  { name: 'stroke', ramp: false, glyphs: ['DASH', 'LINE', 'DASH2', 'TICK', 'HAIR'] },
  { name: 'code', ramp: true, glyphs: ['1', '7', '0', '2', '3', '4', '5', '6', '8', '9', 'A', 'E', 'F', '$', '&', '?'] },
  { name: 'mark', ramp: false, glyphs: ['DOT', 'DOT2', 'RING', 'SQ', 'SQF', 'DIA', 'CROSS', 'PLUS', 'TRI', 'GRID', 'BAR', 'TICK'] },
];

export const SET = Object.fromEntries(SETS.map((s, i) => [s.name.toUpperCase(), i]));

function drawGlyph(g, key) {
  if (MARKS[key]) { MARKS[key](g); return; }
  const rows = FONT[key];
  if (!rows) throw new Error(`GlyphAtlas: no glyph for ${JSON.stringify(key)}`);
  // 5x7 bits at 4 px -> 20x28, centred in the 32 px cell.
  const px = 4, x0 = 6, y0 = 2;
  for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
    if (rows[r][c] === '#') g.fillRect(x0 + c * px, y0 + r * px, px, px);
  }
}

function coverageOf(key) {
  const c = document.createElement('canvas');
  c.width = c.height = CELL;
  const g = c.getContext('2d');
  g.fillStyle = g.strokeStyle = '#fff';
  drawGlyph(g, key);
  const d = g.getImageData(0, 0, CELL, CELL).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += d[i];
  return s / (255 * CELL * CELL);
}

/**
 * Build the atlas. Returns { texture, sets, setLen (Float32Array(16)), index(setName, glyphKey) }.
 * extraSets: optional [{ name, ramp, glyphs }] appended after the built-in rows (up to 16 rows in total).
 */
export function createGlyphAtlas({ extraSets = [] } = {}) {
  const sets = [...SETS, ...extraSets].slice(0, GRID).map((s) => {
    if (!s.ramp) return { ...s, glyphs: [...s.glyphs] };
    const withCov = s.glyphs.map((k) => ({ k, cov: coverageOf(k) }));
    withCov.sort((a, b) => a.cov - b.cov);
    return { ...s, glyphs: withCov.map((x) => x.k), coverage: withCov.map((x) => x.cov) };
  });

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CELL * GRID;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = g.strokeStyle = '#fff';
  g.lineCap = 'round';
  sets.forEach((s, row) => {
    s.glyphs.forEach((k, col) => {
      g.save();
      g.translate(col * CELL, row * CELL);
      g.beginPath();
      g.rect(0, 0, CELL, CELL);
      g.clip();
      drawGlyph(g, k);
      g.restore();
    });
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.flipY = true;
  texture.needsUpdate = true;

  const setLen = new Float32Array(GRID);
  sets.forEach((s, i) => { setLen[i] = s.glyphs.length; });

  const index = (setName, key) => {
    const row = sets.findIndex((s) => s.name === setName);
    const col = row >= 0 ? sets[row].glyphs.indexOf(key) : -1;
    if (col < 0) throw new Error(`GlyphAtlas: ${key} not in set ${setName}`);
    return row * GRID + col;
  };

  return { texture, canvas, sets, setLen, index };
}
