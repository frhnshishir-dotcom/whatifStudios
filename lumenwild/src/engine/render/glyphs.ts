// Curated glyph registry. Every glyph the renderer can draw is listed here once; the atlas bakes them per cell size.
// mode: 'base' = text glyph on the font baseline (letters, punctuation);
//       'center' = symbol centred and fitted in the cell (dingbats, shapes from a fallback font);
//       'proc' = drawn procedurally, pixel-exact (block elements, shades, box lines: no font dependency).

export type GlyphMode = 'base' | 'center' | 'proc';
interface GlyphDef { ch: string; mode: GlyphMode; scale?: number }

const base = (s: string): GlyphDef[] => [...s].map((ch) => ({ ch, mode: 'base' }));
const center = (s: string, scale = 1): GlyphDef[] => [...s].map((ch) => ({ ch, mode: 'center', scale }));
const proc = (s: string): GlyphDef[] => [...s].map((ch) => ({ ch, mode: 'proc' }));

export const GLYPH_DEFS: GlyphDef[] = [
  { ch: ' ', mode: 'base' },
  // ASCII
  ...base(".,:;'`\"^~-_=+*|/\\()[]<>!?#%&@$oO0ivxyY"),
  ...base('’·°˚ʬψΨ¦•※⁘⁙'),
  // Fine marks for terrain texture (grass blades, tufts, pebbles, litter): baseline glyphs from Noto Sans Mono.
  ...base('ʷʹʺˈˌ¨‚„‛⁏⁚⁖⁛⁝⁞⁓‿⁀ϒ⁂'),
  // Water / maths
  ...center('≈∿≋∴∙◦○⌒⌢', 0.95),
  ...center('◯', 0.95),
  // Vegetation and flowers
  ...center('♣♠♧❀✿❋☘❦❁✾✣', 0.92),
  // Fantasy sparkle
  ...center('✧✦❂☼✶✷✸❖', 0.9),
  // Shapes for structures
  ...center('▲△◢◣⌂◆◇◈▬▭▮▯⬩', 0.95),
  ...center('◓◒●◉■□▪▫☗⚘⚙☽✱✻❉▴▵◂▸◍◌✺❃✲', 0.92),
  // Terrain and water texture: dotted moss, pebbles, cobbles, ripples and flow marks (Noto Sans Symbols 2).
  ...center('∵∶∷⋅⋰⋱≀∾∽∼⚶⌇❈❊✼◜◝◞◟◠◡⌓⌔◖◗⬮⬯▾⏜⏝⎺⎻⎼⎽⩬≂≃⋍⏖⏗', 0.9),
  // Procedural: shades, blocks, quadrants, lines, small circle
  ...proc('░▒▓█▄▀▌▐▖▗▘▝│┃║╎╏─═｡╱╲╳┼┬┴├┤┌┐└┘╭╮╯╰'),
];

/** char -> glyph index. */
export const G: Record<string, number> = {};
GLYPH_DEFS.forEach((d, i) => { G[d.ch] = i; });

/** Look up a glyph index; throws on unknown glyphs so typos fail fast in tests. */
export function g(ch: string): number {
  const i = G[ch];
  if (i === undefined) throw new Error(`glyph not in registry: ${JSON.stringify(ch)}`);
  return i;
}

/** Build an index table from a string of glyphs (for per-material variation sets). */
export function gs(chars: string): Uint16Array {
  return Uint16Array.from([...chars].map(g));
}

export const FONT_STACK = '"Noto Sans Mono", "Noto Sans Symbols 2", "DejaVu Sans Mono", monospace';

/** All characters that must be loaded from web fonts before baking (non-procedural). */
export const FONT_CHARS = GLYPH_DEFS.filter((d) => d.mode !== 'proc').map((d) => d.ch).join('');
