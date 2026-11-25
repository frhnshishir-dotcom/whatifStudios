import type { WorldData, MapPt } from './schema';

/**
 * Per-player map knowledge: a fog bitmap (one bit per fogCellUnits square), discovered locations and known routes.
 * Pure data and functions, so the same code can run on the server later (authoritative, persisted per player).
 */
export interface DiscoveryState {
  version: 1;
  /** Fog cells per side and the revealed bits (row-major). */
  size: number;
  fog: Uint8Array;
  discovered: Set<string>;
  knownRoutes: Set<string>;
}

export function createDiscovery(d: WorldData): DiscoveryState {
  const size = Math.ceil(d.coordinates.map.max / d.discovery.fogCellUnits);
  const s: DiscoveryState = { version: 1, size, fog: new Uint8Array(Math.ceil((size * size) / 8)), discovered: new Set(), knownRoutes: new Set() };
  const start = d.discovery.start;
  reveal(d, s, start.at, start.revealRadius);
  for (const id of d.discovery.knownAtStart) {
    if (d.roads.some((r) => r.id === id)) s.knownRoutes.add(id);
    else s.discovered.add(id);
  }
  for (const id of s.discovered) {
    const p = placeOf(d, id);
    if (p) reveal(d, s, p, 10);
  }
  return s;
}

function placeOf(d: WorldData, id: string): MapPt | null {
  return d.settlements.find((q) => q.id === id)?.at ?? d.landmarks.find((q) => q.id === id)?.at ?? null;
}

const bit = (s: DiscoveryState, cx: number, cy: number) => cy * s.size + cx;
export function isRevealed(d: WorldData, s: DiscoveryState, p: MapPt): boolean {
  const u = d.discovery.fogCellUnits, cx = Math.floor(p[0] / u), cy = Math.floor(p[1] / u);
  if (cx < 0 || cy < 0 || cx >= s.size || cy >= s.size) return false;
  const b = bit(s, cx, cy);
  return (s.fog[b >> 3] & (1 << (b & 7))) !== 0;
}

/**
 * Reveal the map within `radius` units of `at` (a player walking, a viewpoint). Places within the radius are
 * discovered. Returns the number of fog cells newly revealed.
 */
export function reveal(d: WorldData, s: DiscoveryState, at: MapPt, radius: number): number {
  const u = d.discovery.fogCellUnits;
  let n = 0;
  for (let cy = Math.floor((at[1] - radius) / u); cy <= Math.floor((at[1] + radius) / u); cy++) {
    for (let cx = Math.floor((at[0] - radius) / u); cx <= Math.floor((at[0] + radius) / u); cx++) {
      if (cx < 0 || cy < 0 || cx >= s.size || cy >= s.size) continue;
      if (Math.hypot((cx + 0.5) * u - at[0], (cy + 0.5) * u - at[1]) > radius) continue;
      const b = bit(s, cx, cy);
      if (!(s.fog[b >> 3] & (1 << (b & 7)))) { s.fog[b >> 3] |= 1 << (b & 7); n++; }
    }
  }
  for (const p of [...d.settlements, ...d.landmarks]) if (Math.hypot(p.at[0] - at[0], p.at[1] - at[1]) <= radius) s.discovered.add(p.id);
  return n;
}

/** A player standing at `at`: reveals around them, and sees tall landmarks from their `visibleFrom` distance. */
export function observe(d: WorldData, s: DiscoveryState, at: MapPt): string[] {
  reveal(d, s, at, d.discovery.playerRevealRadius);
  const seen: string[] = [];
  for (const l of d.landmarks) {
    if (l.visibleFrom && !s.discovered.has(l.id) && Math.hypot(l.at[0] - at[0], l.at[1] - at[1]) <= l.visibleFrom) {
      s.discovered.add(l.id);
      reveal(d, s, l.at, d.discovery.rumourRadius);
      seen.push(l.id);
    }
  }
  return seen;
}

/** What the map shows for a place: hidden until discovered; rumoured places show as unconfirmed markers. */
export function mapState(d: WorldData, s: DiscoveryState, id: string): 'shown' | 'rumour' | 'hidden' {
  if (s.discovered.has(id)) return 'shown';
  const l = d.landmarks.find((q) => q.id === id);
  return l?.discovery === 'rumoured' ? 'rumour' : 'hidden';
}

/** Percent of a region's land that is revealed; `inRegion` tells whether a map point belongs to the region. */
export function explorationPercent(d: WorldData, s: DiscoveryState, inRegion: (x: number, y: number) => boolean): number {
  const u = d.discovery.fogCellUnits;
  let total = 0, open = 0;
  for (let cy = 0; cy < s.size; cy++) for (let cx = 0; cx < s.size; cx++) {
    if (!inRegion((cx + 0.5) * u, (cy + 0.5) * u)) continue;
    total++;
    const b = bit(s, cx, cy);
    if (s.fog[b >> 3] & (1 << (b & 7))) open++;
  }
  return total ? Math.round((open / total) * 1000) / 10 : 0;
}

/** Plain JSON for saves (the fog as base64). */
export function serializeDiscovery(s: DiscoveryState): { version: 1; size: number; fog: string; discovered: string[]; knownRoutes: string[] } {
  let bin = '';
  for (let i = 0; i < s.fog.length; i++) bin += String.fromCharCode(s.fog[i]);
  return { version: 1, size: s.size, fog: btoa(bin), discovered: [...s.discovered].sort(), knownRoutes: [...s.knownRoutes].sort() };
}

export function deserializeDiscovery(j: ReturnType<typeof serializeDiscovery>): DiscoveryState {
  const bin = atob(j.fog), fog = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) fog[i] = bin.charCodeAt(i);
  return { version: 1, size: j.size, fog, discovered: new Set(j.discovered), knownRoutes: new Set(j.knownRoutes) };
}
