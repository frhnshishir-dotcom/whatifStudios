/** What the dragon remembers: where it has been, good resting places, water it found, landmarks it likes. */
export interface Spot { x: number; y: number; t: number; score: number; kind: string }

const MAX_VISITED = 24, MAX_REST = 8, MAX_WATER = 16, MAX_MARKS = 16;

export class DragonMemory {
  visited: Spot[] = [];
  rest: Spot[] = [];
  water: Spot[] = [];
  landmarks: Spot[] = [];

  /** 0 (not recently) .. 1 (just visited): how recently the dragon was within r cells of (x, y). */
  recency(x: number, y: number, r: number, now: number, window = 240): number {
    let v = 0;
    for (const s of this.visited) {
      if (Math.hypot(s.x - x, s.y - y) > r) continue;
      v = Math.max(v, 1 - Math.min(1, (now - s.t) / window));
    }
    return v;
  }

  noteVisit(x: number, y: number, now: number, kind = 'place'): void {
    const last = this.visited[this.visited.length - 1];
    if (last && Math.hypot(last.x - x, last.y - y) < 6) { last.t = now; return; }
    this.visited.push({ x, y, t: now, score: 1, kind });
    if (this.visited.length > MAX_VISITED) this.visited.shift();
  }

  /** Remember water; nearby entries merge. Returns true if it is new. */
  noteWater(x: number, y: number, now: number): boolean {
    for (const s of this.water) if (Math.hypot(s.x - x, s.y - y) < 14) { s.t = now; return false; }
    this.water.push({ x, y, t: now, score: 1, kind: 'water' });
    if (this.water.length > MAX_WATER) this.water.shift();
    return true;
  }

  /** Remember a resting place; a good rest there raises its score. */
  noteRest(x: number, y: number, quality: number, now: number, kind = 'rest'): void {
    for (const s of this.rest) if (Math.hypot(s.x - x, s.y - y) < 8) { s.score = Math.min(3, s.score + quality * 0.5); s.t = now; return; }
    this.rest.push({ x, y, t: now, score: quality, kind });
    this.rest.sort((a, b) => b.score - a.score);
    if (this.rest.length > MAX_REST) this.rest.pop();
  }

  noteLandmark(x: number, y: number, kind: string, now: number): void {
    for (const s of this.landmarks) if (Math.hypot(s.x - x, s.y - y) < 10) { s.t = now; s.score++; return; }
    this.landmarks.push({ x, y, t: now, score: 1, kind });
    if (this.landmarks.length > MAX_MARKS) this.landmarks.shift();
  }

  nearestWater(x: number, y: number): Spot | null {
    let best: Spot | null = null, bd = Infinity;
    for (const s of this.water) { const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = s; } }
    return best;
  }

  toJSON() { return { visited: this.visited, rest: this.rest, water: this.water, landmarks: this.landmarks }; }

  /** Restore from saved data, keeping only well-formed in-bounds entries. */
  load(raw: unknown, w: number, h: number): void {
    const r = (raw ?? {}) as Record<string, unknown>;
    const list = (v: unknown, max: number): Spot[] => (Array.isArray(v) ? v : [])
      .filter((s): s is Spot => !!s && typeof s === 'object' && [s.x, s.y, s.t, s.score].every((n) => typeof n === 'number' && Number.isFinite(n)) && s.x >= 0 && s.y >= 0 && s.x < w && s.y < h)
      .slice(-max).map((s) => ({ x: s.x, y: s.y, t: s.t, score: s.score, kind: typeof s.kind === 'string' ? s.kind.slice(0, 24) : 'place' }));
    this.visited = list(r.visited, MAX_VISITED);
    this.rest = list(r.rest, MAX_REST);
    this.water = list(r.water, MAX_WATER);
    this.landmarks = list(r.landmarks, MAX_MARKS);
  }
}
