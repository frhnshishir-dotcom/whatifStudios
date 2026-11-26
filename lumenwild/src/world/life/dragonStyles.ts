import { PAL, CLASSIC, type DragonStyle, type Palette } from '../../engine/dragon/DragonPoses';
import { hex } from '../../engine/core/color';

/**
 * The continent's five dragons, each recognisable: its own scales, membranes, ridge glow and eyes, and its size
 * (from world/dragons/territories.json: huge, large, medium). All use the refined wing (longer span, a third finger
 * bone, a lit leading edge) and bank into turns. The Valley's dragon keeps the classic look.
 */
const P = (o: Partial<Record<keyof Palette, string>>): Palette => ({ ...PAL, ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, hex(v as string)])) }) as Palette;
const REFINED = { fingers3: true, bank: true, rim: true };

export const DRAGON_STYLES: Record<string, DragonStyle> = {
  // Elder storm dragon (huge): slate-blue scales, storm-cloud wings, lightning-cyan ridge and eyes.
  'dragon-aurath': { ...REFINED, scale: 1.22, span: 1.16, body: 1.12, pal: P({ scaleDark: '#0b1018', scale: '#2a3a52', scaleLit: '#8fb2d8', belly: '#3a4a5e', ridge: '#7ff0ff', membrane: '#1d2c48', membraneLit: '#4a72a8', membraneEdge: '#060a12', bone: '#0a1220', boneLit: '#9cc4ee', horn: '#e8e2c8', eye: '#9ff4ff', eyeLit: '#e0ffff' }) },
  // Obsidian fire dragon (large): black scales, crimson wings, ember ridge (the classic colours, refined shape).
  'dragon-emberfang': { ...REFINED, scale: 1.04, span: 1.06, body: 1, pal: P({ ridge: '#ff6a1c', membraneLit: '#9a2230' }) },
  // Frost dragon (large): pale ice scales, translucent blue wings, glacier-blue ridge.
  'dragon-rimeclaw': { ...REFINED, scale: 1.04, span: 1.1, body: 0.98, pal: P({ scaleDark: '#4d6478', scale: '#b8c9d8', scaleLit: '#ffffff', belly: '#9cb6cc', ridge: '#7fd8ff', membrane: '#6d98bc', membraneLit: '#cfe8ff', membraneEdge: '#24384c', bone: '#24384c', boneLit: '#e8f6ff', horn: '#f4f8ff', eye: '#5fe0ff', eyeLit: '#d0f8ff', claw: '#e8eef4' }) },
  // Forest drake (medium): moss-green scales, leaf wings, amber ridge.
  'dragon-mossheart': { ...REFINED, scale: 0.86, span: 0.92, body: 0.94, pal: P({ scaleDark: '#121c0c', scale: '#2f4a22', scaleLit: '#7fa34a', belly: '#5a5a2a', ridge: '#ffc24a', membrane: '#3d5a1c', membraneLit: '#7a9a32', membraneEdge: '#0f1808', bone: '#16220c', boneLit: '#a3c46a', horn: '#d8c89a', eye: '#ffd24a' }) },
  // Corrupted dragon (large): ash-grey scales, bruised violet wings, a sickly green glow.
  'dragon-ashmaw': { ...REFINED, scale: 1.08, span: 1.04, body: 1.04, pal: P({ scaleDark: '#0c0a0c', scale: '#3a3438', scaleLit: '#7c7078', belly: '#3a2238', ridge: '#a6ff4a', membrane: '#3a1838', membraneLit: '#6a2c66', membraneEdge: '#08040a', bone: '#0a060c', boneLit: '#5a4a58', horn: '#9a948a', eye: '#c6ff3a', eyeLit: '#eaffaa' }) },
};

export const styleFor = (id: string): DragonStyle => DRAGON_STYLES[id] ?? { ...CLASSIC, ...REFINED };
