import type { World } from '../world/World';
import type { ObjectStore } from '../objects/ObjectStore';
import { OBJECT_DEFS, type ObjKind, type WorldObject } from '../objects/defs';
import { Mat, Cover } from '../world/materials';
import { hash2, mulberry32 } from '../core/rng';
import { assignSurface } from '../gen/terrain';
import { History, Composite, type Command } from './History';

export type EditTool =
  | 'select' | 'terrain' | 'raise' | 'lower' | 'water' | 'source' | 'drain' | 'channel' | 'waterfall'
  | 'rock' | 'tree' | 'flowers' | 'mushroom' | 'bridge' | 'cottage' | 'mill' | 'ripple' | 'eraser';

/** What the editor needs from the water system (WaterSystem implements it; tests can too). */
export interface WaterLike {
  readonly view: { depth: Float32Array; velX: Float32Array; velY: Float32Array };
  addWater(x: number, y: number, r: number, amount: number): void;
  disturb(x: number, y: number, r: number, strength: number): void;
  setSource(x: number, y: number, rate: number): void;
  setDrain(x: number, y: number, rate: number): void;
  terrainChanged(x0: number, y0: number, x1: number, y1: number): void;
}

export interface ToolOptions {
  /** Brush radius in cells. */
  radius: number;
  /** 0.1..1: rate of raise/lower/water brushes, density of plant brushes. */
  strength: number;
  /** Terrain brush material (Mat). */
  material: number;
  /** Grass & flowers brush cover (Cover). */
  cover: number;
  waterMode: 'add' | 'remove';
  /** Source / drain rate (m^3/s). */
  rate: number;
  /** Waterfall drop (m). */
  drop: number;
  /** Channel depth (m). */
  depth: number;
  /** Variant per object kind ('mixed' = random for trees, rocks, mushrooms). */
  variants: Record<string, string>;
  /** Tree size 1..3 (0 = random). */
  treeSize: number;
}

export const DEFAULT_OPTIONS: ToolOptions = {
  radius: 3, strength: 0.5, material: Mat.Path, cover: Cover.Flowers, waterMode: 'add', rate: 3, drop: 3, depth: 1.2,
  variants: { tree: 'mixed', rock: 'mixed', mushroom: 'mixed', cottage: 'terracotta', mill: 'stone', bridge: 'wood', stone: 'rune' },
  treeSize: 0,
};

/** Tools that act continuously while the pointer is held (applied every frame, not only on movement). */
const CONTINUOUS = new Set<EditTool>(['raise', 'lower', 'water']);
const PLANTS = new Set<ObjKind>(['tree', 'mushroom']);
const ELEV_MIN = -6, ELEV_MAX = 70;

/** Before-values of every terrain cell a stroke touched (recorded lazily, once per cell). */
class TerrainPatch {
  readonly pos = new Map<number, number>();
  readonly idx: number[] = [];
  readonly elev: number[] = [];
  readonly mat: number[] = [];
  readonly cover: number[] = [];
  readonly cvar: number[] = [];
  readonly magic: number[] = [];
  x0 = 1e9; y0 = 1e9; x1 = -1e9; y1 = -1e9;
  constructor(readonly world: World) {}
  touch(i: number): void {
    if (this.pos.has(i)) return;
    const w = this.world, x = i % w.w, y = (i / w.w) | 0;
    this.pos.set(i, this.idx.length);
    this.idx.push(i); this.elev.push(w.elev[i]); this.mat.push(w.mat[i]); this.cover.push(w.cover[i]); this.cvar.push(w.coverVar[i]); this.magic.push(w.magic[i]);
    if (x < this.x0) this.x0 = x; if (x > this.x1) this.x1 = x; if (y < this.y0) this.y0 = y; if (y > this.y1) this.y1 = y;
  }
  /** Elevation before the stroke. */
  orig(i: number): number { const p = this.pos.get(i); return p === undefined ? this.world.elev[i] : this.elev[p]; }
  get empty(): boolean { return this.idx.length === 0; }
}

interface Stroke {
  tool: EditTool;
  i: number;
  x: number;
  y: number;
  patch: TerrainPatch;
  cmds: Command[];
  /** Channel: running bed level (never rises along the stroke). */
  bed?: number;
  /** Select: object being dragged. */
  move?: { id: number; ox: number; oy: number; offX: number; offY: number; moved: boolean };
  lastPlaced?: [number, number];
  salt: number;
}

/**
 * The sandbox editor: every tool, applied to the world, objects and water. Terrain strokes record before/after
 * values of the cells they touch; object edits record the object. Each stroke becomes one undoable command.
 * Water volume is simulation state and is not part of the history; sources and drains are.
 */
export class Editor {
  world: World;
  objects: ObjectStore;
  water: WaterLike | null;
  readonly history = new History();
  /** Placed sources and drains: cell index -> rate (m^3/s). */
  readonly sources = new Map<number, number>();
  readonly drains = new Map<number, number>();
  options: ToolOptions = { ...DEFAULT_OPTIONS, variants: { ...DEFAULT_OPTIONS.variants } };
  selectedId = 0;
  /** Selection or object changes (for the inspector). */
  onSelect: ((o: WorldObject | null) => void) | null = null;
  /** Short user-facing messages (placement refused, etc.). */
  onMessage: ((msg: string) => void) | null = null;
  /** Any edit applied (marks the world unsaved). */
  onEdit: (() => void) | null = null;
  private stroke: Stroke | null = null;
  private salt = 1;
  private lastEdit: { id: number; time: number; before: Partial<WorldObject>; cmd: Command } | null = null;

  constructor(world: World, objects: ObjectStore, water: WaterLike | null) {
    this.world = world;
    this.objects = objects;
    this.water = water;
  }

  /** Rebind after a world load or regeneration. */
  bind(world: World, objects: ObjectStore, water: WaterLike | null): void {
    this.world = world; this.objects = objects; this.water = water;
    this.sources.clear(); this.drains.clear();
    this.history.clear();
    this.select(0);
  }

  get active(): boolean { return this.stroke !== null; }

  // ------------------------------------------------------------------ pointer strokes
  begin(tool: EditTool, i: number): void {
    if (this.stroke) this.end();
    if (i < 0) return;
    const w = this.world, x = i % w.w, y = (i / w.w) | 0;
    const s: Stroke = { tool, i, x, y, patch: new TerrainPatch(w), cmds: [], salt: this.salt++ };
    this.stroke = s;
    switch (tool) {
      case 'select': {
        const o = this.objects.at(i);
        this.select(o ? o.id : 0);
        if (o) s.move = { id: o.id, ox: o.x, oy: o.y, offX: x - o.x, offY: y - o.y, moved: false };
        else this.ripple(x, y); // clicking open water with the default tool makes ripples
        break;
      }
      case 'ripple': this.ripple(x, y); break;
      case 'raise': case 'lower': case 'water': this.tick(1 / 30); break;
      case 'terrain': this.paintMaterial(s, x, y); break;
      case 'flowers': this.paintCover(s, x, y); break;
      case 'eraser': this.erase(s, x, y); break;
      case 'channel': s.bed = s.patch.orig(i) - this.options.depth; this.carveChannel(s, x, y); break;
      case 'waterfall': this.waterfall(s, x, y); break;
      case 'source': case 'drain': this.toggleSourceDrain(tool, x, y); break;
      case 'tree': case 'mushroom': case 'rock': this.placePlantOrRock(s, tool, x, y); break;
      case 'bridge': this.placeBridge(s, x, y); break;
      case 'cottage': case 'mill': this.placeBuilding(s, tool, x, y); break;
    }
  }

  drag(i: number): void {
    const s = this.stroke;
    if (!s || i < 0) return;
    const w = this.world, x = i % w.w, y = (i / w.w) | 0;
    if (x === s.x && y === s.y) return;
    const px = s.x, py = s.y;
    s.i = i; s.x = x; s.y = y;
    switch (s.tool) {
      case 'select': {
        const m = s.move;
        if (!m) break;
        if (this.objects.update(m.id, { x: x - m.offX, y: y - m.offY })) { m.moved = true; this.emitSelect(); }
        break;
      }
      case 'ripple': this.ripple(x, y); break;
      case 'terrain': this.alongSegment(px, py, x, y, 1, (ax, ay) => this.paintMaterial(s, ax, ay)); break;
      case 'flowers': this.alongSegment(px, py, x, y, 1, (ax, ay) => this.paintCover(s, ax, ay)); break;
      case 'eraser': this.alongSegment(px, py, x, y, 1, (ax, ay) => this.erase(s, ax, ay)); break;
      case 'channel': this.alongSegment(px, py, x, y, 0.5, (ax, ay) => this.carveChannel(s, ax, ay)); break;
      case 'tree': case 'mushroom': this.placePlantOrRock(s, s.tool, x, y); break;
      default: break;
    }
  }

  /** Continuous tools, called every frame with the frame time. */
  tick(dt: number): void {
    const s = this.stroke;
    if (!s || !CONTINUOUS.has(s.tool)) return;
    if (s.tool === 'water') this.waterBrush(s.x, s.y, dt);
    else this.raiseLower(s, s.x, s.y, (s.tool === 'raise' ? 1 : -1) * dt);
  }

  end(): void {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    const parts: Command[] = [];
    if (s.tool === 'lower') {
      // Plants don't stay standing in a dug pit.
      const w = this.world;
      for (let k = 0; k < s.patch.idx.length; k++) {
        const i = s.patch.idx[k];
        if (s.patch.elev[k] - w.elev[i] > 0.8) this.removePlantAt(s, i % w.w, (i / w.w) | 0);
      }
    }
    if (!s.patch.empty) {
      this.retouch(s.patch);
      parts.push(this.terrainCommand(s.patch));
    }
    parts.push(...s.cmds);
    if (s.move?.moved) {
      const o = this.objects.objects.get(s.move.id);
      if (o) parts.push(this.updateCommand(o.id, { x: s.move.ox, y: s.move.oy }, { x: o.x, y: o.y }, 'Move'));
    }
    if (parts.length) {
      this.history.push(parts.length === 1 ? parts[0] : new Composite(LABELS[s.tool], parts));
      this.onEdit?.();
    }
  }

  // ------------------------------------------------------------------ undo / redo / selection
  undo(): string | null { if (this.stroke) this.end(); const l = this.history.undo(); this.afterHistory(); return l; }
  redo(): string | null { if (this.stroke) this.end(); const l = this.history.redo(); this.afterHistory(); return l; }

  private afterHistory(): void {
    if (this.selectedId && !this.objects.objects.has(this.selectedId)) this.selectedId = 0;
    this.emitSelect();
    this.onEdit?.();
  }

  select(id: number): void {
    this.selectedId = id;
    this.emitSelect();
  }

  private emitSelect(): void {
    const o = this.selectedId ? this.objects.objects.get(this.selectedId) ?? null : null;
    this.onSelect?.(o ? { ...o, props: { ...o.props } } : null);
  }

  /** Delete the selected object (undoable). */
  deleteSelected(): boolean {
    const o = this.selectedId ? this.objects.objects.get(this.selectedId) : null;
    if (!o) return false;
    const cmd = this.removeCommand(o);
    cmd.redo();
    this.history.push(cmd);
    this.select(0);
    this.onEdit?.();
    return true;
  }

  /** Change variant / props / position of an object from the inspector (undoable). */
  editObject(id: number, patch: Partial<Pick<WorldObject, 'x' | 'y' | 'variant' | 'props'>>): boolean {
    const o = this.objects.objects.get(id);
    if (!o) return false;
    const before = { x: o.x, y: o.y, variant: o.variant, props: { ...o.props } };
    if (!this.objects.update(id, patch)) { this.onMessage?.('Blocked: something is in the way'); return false; }
    const after = { x: o.x, y: o.y, variant: o.variant, props: { ...o.props } };
    // Successive edits of the same object within a second (a slider drag) become one undo step.
    const now = Date.now(), le = this.lastEdit;
    if (le && le.id === id && now - le.time < 1000 && this.history.last === le.cmd) {
      le.cmd = this.updateCommand(id, le.before, after, 'Edit object');
      le.time = now;
      this.history.replaceLast(le.cmd);
    } else {
      const cmd = this.updateCommand(id, before, after, 'Edit object');
      this.lastEdit = { id, time: now, before, cmd };
      this.history.push(cmd);
    }
    this.emitSelect();
    this.onEdit?.();
    return true;
  }

  // ------------------------------------------------------------------ tools
  private disc(x: number, y: number, r: number, fn: (i: number, d: number, cx: number, cy: number) => void): void {
    const w = this.world, R = Math.ceil(r);
    for (let yy = y - R; yy <= y + R; yy++) for (let xx = x - R; xx <= x + R; xx++) {
      if (!w.inBounds(xx, yy)) continue;
      const d = Math.hypot(xx - x, yy - y);
      if (d <= r + 0.01) fn(yy * w.w + xx, d, xx, yy);
    }
  }

  private alongSegment(x0: number, y0: number, x1: number, y1: number, step: number, fn: (x: number, y: number) => void): void {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 1; k <= n; k++) fn(Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n));
  }

  private ripple(x: number, y: number): void {
    const ws = this.water;
    if (!ws || ws.view.depth[y * this.world.w + x] < 0.025) return;
    ws.disturb(x, y, 1.6, 0.6 + this.options.strength * 1.2);
  }

  private raiseLower(s: Stroke, x: number, y: number, signedDt: number): void {
    const w = this.world, r = this.options.radius, rate = 1 + 4 * this.options.strength; // m/s at the centre
    this.disc(x, y, r, (i, d) => {
      const f = (1 - (d / (r + 0.5)) ** 2) ** 2;
      s.patch.touch(i);
      w.elev[i] = Math.max(ELEV_MIN, Math.min(ELEV_MAX, w.elev[i] + signedDt * rate * f));
    });
    this.terrainTouched(x - r, y - r, x + r, y + r);
  }

  private paintMaterial(s: Stroke, x: number, y: number): void {
    const w = this.world, m = this.options.material;
    this.disc(x, y, this.options.radius, (i, _d, cx, cy) => {
      s.patch.touch(i);
      const h = hash2(cx, cy, 401);
      w.mat[i] = m;
      w.cover[i] = coverFor(m, h, hash2(cx, cy, 402));
      if (m === Mat.Glade) w.magic[i] = Math.max(w.magic[i], 200);
    });
    this.terrainTouched(x - this.options.radius, y - this.options.radius, x + this.options.radius, y + this.options.radius);
  }

  private paintCover(s: Stroke, x: number, y: number): void {
    const w = this.world, c = this.options.cover, dens = 0.25 + this.options.strength * 0.75;
    const depth = this.water?.view.depth;
    this.disc(x, y, this.options.radius, (i, _d, cx, cy) => {
      if (depth && depth[i] > 0.05) return;
      if (w.mat[i] === Mat.Path || w.mat[i] === Mat.Cliff) return;
      if (c !== Cover.None && hash2(cx, cy, 500 + s.salt) > dens) return;
      s.patch.touch(i);
      w.cover[i] = c;
      if (c === Cover.Flowers) w.coverVar[i] = Math.floor(hash2(cx, cy, 503) * 6);
    });
    this.terrainTouched(x - this.options.radius, y - this.options.radius, x + this.options.radius, y + this.options.radius);
  }

  private waterBrush(x: number, y: number, dt: number): void {
    const ws = this.water;
    if (!ws) return;
    const r = this.options.radius, area = Math.PI * r * r;
    const amount = (this.options.waterMode === 'add' ? 1 : -1) * (0.6 + 2.4 * this.options.strength) * area * dt;
    ws.addWater(x, y, r, amount);
    this.onEdit?.();
  }

  /** Source/drain tool: click an existing marker (within 1 cell) to remove it, elsewhere to place one. */
  private toggleSourceDrain(tool: 'source' | 'drain', x: number, y: number): void {
    const map = tool === 'source' ? this.sources : this.drains;
    let hit = -1;
    for (const i of map.keys()) { const ix = i % this.world.w, iy = (i / this.world.w) | 0; if (Math.abs(ix - x) <= 1 && Math.abs(iy - y) <= 1) hit = i; }
    const i = hit >= 0 ? hit : y * this.world.w + x;
    const before = map.get(i) ?? 0, after = hit >= 0 ? 0 : this.options.rate;
    const cmd = this.sourceCommand(tool, i, before, after);
    cmd.redo();
    this.stroke?.cmds.push(cmd);
  }

  /** Register a source/drain without history (generation, loading). */
  setSourceDirect(kind: 'source' | 'drain', x: number, y: number, rate: number): void {
    const i = y * this.world.w + x;
    this.applySource(kind, i, rate);
  }

  private applySource(kind: 'source' | 'drain', i: number, rate: number): void {
    const map = kind === 'source' ? this.sources : this.drains, x = i % this.world.w, y = (i / this.world.w) | 0;
    if (rate > 0) map.set(i, rate); else map.delete(i);
    if (kind === 'source') this.water?.setSource(x, y, rate); else this.water?.setDrain(x, y, rate);
  }

  private carveChannel(s: Stroke, x: number, y: number): void {
    const w = this.world, r = Math.max(1, this.options.radius), depth = this.options.depth;
    // The bed follows the ground minus the depth but never rises along the stroke, so a channel dragged
    // downhill always drains towards its end.
    s.bed = Math.min(s.bed ?? Infinity, s.patch.orig(y * w.w + x) - depth);
    const bed = s.bed;
    this.disc(x, y, r, (i, d, cx, cy) => {
      const target = bed + (d / (r + 0.5)) ** 2 * depth * 0.9;
      if (w.elev[i] <= target) return;
      s.patch.touch(i);
      w.elev[i] = target;
      w.mat[i] = d < r * 0.75 ? Mat.Sand : Mat.Mud;
      w.cover[i] = Cover.None;
      if (d < r * 0.75) this.removePlantAt(s, cx, cy);
    });
    this.terrainTouched(x - r, y - r, x + r, y + r);
  }

  /**
   * Waterfall tool: lowers the bed downstream of the click by `drop` metres, following the flow (or southwards on
   * dry ground) until the original ground is already that low, or the map edge. The cut ends where the land was
   * lower anyway, so the new fall lasts instead of filling up into a pool. The lip at the click becomes stone.
   */
  private waterfall(s: Stroke, x: number, y: number): void {
    const w = this.world, r = Math.max(2, this.options.radius), drop = this.options.drop;
    const path = this.traceDownstream(x, y, 360);
    let bed0 = Infinity;
    this.disc(x, y, 1.5, (i) => { bed0 = Math.min(bed0, w.elev[i]); });
    // Initial downstream direction (average over the first few path steps): the lip is the line through the
    // click perpendicular to it, and nothing behind that line is lowered.
    const look = Math.min(path.length - 1, 4);
    let ddx = 0, ddy = 1;
    if (look > 0) {
      ddx = (path[look] % w.w) - x; ddy = ((path[look] / w.w) | 0) - y;
      const l = Math.hypot(ddx, ddy) || 1; ddx /= l; ddy /= l;
    }
    let lowered = 0;
    for (let k = 1; k < path.length; k++) {
      const p = path[k], px = p % w.w, py = (p / w.w) | 0;
      const target = bed0 - drop - 0.015 * k;
      if (s.patch.orig(p) < target - 0.05 && k > r + 2) break;
      this.disc(px, py, r, (i, d, cx, cy) => {
        if ((cx - x) * ddx + (cy - y) * ddy < 0.5) return;
        const t = target + (d / (r + 0.5)) ** 2 * drop * 0.85;
        if (w.elev[i] <= t) return;
        s.patch.touch(i);
        w.elev[i] = t;
        if (w.mat[i] !== Mat.Stone && w.mat[i] !== Mat.Cliff) { w.mat[i] = d < r * 0.7 ? Mat.Sand : Mat.Mud; w.cover[i] = Cover.None; }
        if (d < r * 0.7) this.removePlantAt(s, cx, cy);
        lowered++;
      });
    }
    // Stone lip just upstream of the drop.
    this.disc(x, y, r, (i, _d, cx, cy) => {
      if ((cx - x) * ddx + (cy - y) * ddy >= 0.5) return;
      s.patch.touch(i);
      w.mat[i] = Mat.Stone; w.cover[i] = Cover.None;
    });
    if (!lowered) this.onMessage?.('The ground here is already lower downstream');
    this.terrainTouched(s.patch.x0, s.patch.y0, s.patch.x1, s.patch.y1);
  }

  /** Follow the flow downstream: velocity direction where water moves, otherwise the lowest surface ahead. */
  traceDownstream(x: number, y: number, max: number): number[] {
    const w = this.world, v = this.water?.view;
    const i0 = y * w.w + x;
    let dx = 0, dy = 1;
    if (v) {
      let vx = 0, vy = 0;
      this.disc(x, y, 2, (i) => { vx += v.velX[i]; vy += v.velY[i]; });
      const sp = Math.hypot(vx, vy);
      if (sp > 0.05) { dx = vx / sp; dy = vy / sp; }
    }
    const path = [i0], seen = new Set([i0]);
    let cx = x, cy = y;
    for (let k = 0; k < max; k++) {
      let best = -1, bestScore = Infinity, bx = 0, by = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const nx = cx + ox, ny = cy + oy;
        if (!w.inBounds(nx, ny)) continue;
        const n = ny * w.w + nx;
        if (seen.has(n)) continue;
        const len = Math.hypot(ox, oy), align = (ox * dx + oy * dy) / len;
        if (align < 0.2) continue;
        const surf = w.elev[n] + (v ? v.depth[n] : 0);
        const score = surf - 1.2 * align;
        if (score < bestScore) { bestScore = score; best = n; bx = ox / len; by = oy / len; }
      }
      if (best < 0) break;
      path.push(best); seen.add(best);
      cx = best % w.w; cy = (best / w.w) | 0;
      dx = dx * 0.7 + bx * 0.3; dy = dy * 0.7 + by * 0.3;
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      if (cx === 0 || cy === 0 || cx === w.w - 1 || cy === w.h - 1) break;
    }
    return path;
  }

  private rng(s: Stroke): () => number { return mulberry32((s.salt * 7919 + s.x * 31 + s.y * 17) >>> 0); }

  private placePlantOrRock(s: Stroke, kind: 'tree' | 'mushroom' | 'rock', x: number, y: number): void {
    // Click places one; dragging scatters with spacing (trees and mushrooms).
    if (s.lastPlaced) {
      const spacing = kind === 'tree' ? Math.max(2.5, this.options.radius * 0.8) : 1.8;
      if (Math.hypot(x - s.lastPlaced[0], y - s.lastPlaced[1]) < spacing) return;
    }
    const rnd = this.rng(s);
    let px = x, py = y;
    if (s.lastPlaced && this.options.radius > 1) { px += Math.round((rnd() - 0.5) * this.options.radius); py += Math.round((rnd() - 0.5) * this.options.radius); }
    let variant = this.options.variants[kind] ?? 'mixed';
    const defs = OBJECT_DEFS[kind];
    if (variant === 'mixed' || !defs.variants.includes(variant)) {
      const pool = kind === 'tree' ? ['oak', 'oak', 'pine', 'birch', 'pine'] : kind === 'mushroom' ? ['red', 'brown', 'glow', 'violet'] : ['boulder', 'big', 'formation'];
      variant = pool[Math.floor(rnd() * pool.length)];
    }
    const props: Record<string, number> = {};
    if (kind === 'tree') { props.size = this.options.treeSize || 1 + Math.floor(rnd() * 3); props.seed = Math.floor(rnd() * 1000); }
    if (kind === 'rock') { props.seed = Math.floor(rnd() * 1000); props.moss = rnd() < 0.4 ? 1 : 0; }
    if (kind === 'mushroom') props.count = 1 + Math.floor(rnd() * 3);
    const o = { kind, x: px, y: py, variant, props } as Omit<WorldObject, 'id'>;
    if (kind === 'rock' && variant !== 'boulder') { o.x -= 1; } // centre multi-cell rocks on the cursor
    const why = this.whyNot(o);
    if (why) { if (!s.lastPlaced) this.onMessage?.(why); return; }
    this.addObject(s, o);
    s.lastPlaced = [x, y];
  }

  private whyNot(o: Omit<WorldObject, 'id'>): string | null {
    const why = this.objects.canPlace(o);
    if (why) return `Can't place here: ${why}`;
    if (o.kind !== 'bridge') {
      const depth = this.water?.view.depth;
      if (depth) for (const [dx, dy] of OBJECT_DEFS[o.kind].footprint(o as WorldObject)) {
        const i = (o.y + dy) * this.world.w + o.x + dx;
        if (depth[i] > (o.kind === 'rock' ? 1.5 : 0.15)) return o.kind === 'rock' ? "Can't place here: the water is too deep" : "Can't place here: needs dry ground";
      }
    }
    return null;
  }

  private placeBridge(s: Stroke, x: number, y: number): void {
    // Span the water under the click (left to right), or a default 7-cell bridge on dry ground.
    const w = this.world, depth = this.water?.view.depth;
    const wet = (xx: number) => !!depth && w.inBounds(xx, y) && depth[y * w.w + xx] > 0.04;
    let x0 = x, x1 = x;
    if (wet(x)) {
      while (x0 > 0 && wet(x0 - 1) && x - x0 < 24) x0--;
      while (x1 < w.w - 1 && wet(x1 + 1) && x1 - x < 24) x1++;
      x0 = Math.max(0, x0 - 1); x1 = Math.min(w.w - 1, x1 + 1);
      if (x1 - x0 + 1 > 24) { this.onMessage?.('Too wide for a bridge (24 cells max)'); return; }
    } else { x0 = x - 3; x1 = x + 3; }
    let z = Math.max(w.elevAt(x0, y), w.elevAt(x1, y));
    for (let xx = x0; xx <= x1; xx++) z = Math.max(z, w.elevAt(xx, y) + (depth ? depth[y * w.w + xx] : 0));
    const o = { kind: 'bridge' as const, x: x0, y, variant: 'wood', props: { length: Math.max(3, x1 - x0 + 1), z: Math.round((z + 0.4) * 10) / 10 } };
    const why = this.objects.canPlace(o);
    if (why) { this.onMessage?.(`Can't place here: ${why}`); return; }
    this.addObject(s, o);
  }

  private placeBuilding(s: Stroke, kind: 'cottage' | 'mill', x: number, y: number): void {
    const w = this.world, fw = kind === 'cottage' ? 5 : 4, fh = 3;
    const ax = x - (fw >> 1), ay = y - 1;
    const props: Record<string, number> = {};
    if (kind === 'mill') {
      // Put the wheel on the side with water.
      const depth = this.water?.view.depth;
      const at = (cx: number) => (depth && w.inBounds(cx, ay + 2) ? depth[(ay + 2) * w.w + cx] : 0);
      props.wheelSide = at(ax + 5) >= at(ax - 2) ? 1 : -1;
      if (at(ax + 5) < 0.05 && at(ax - 2) < 0.05) this.onMessage?.('Tip: place the mill beside a stream so the wheel stands in water');
    }
    const o = { kind, x: ax, y: ay, variant: this.options.variants[kind] ?? OBJECT_DEFS[kind].variants[0], props } as Omit<WorldObject, 'id'>;
    const why = this.whyNot(o);
    if (why) { this.onMessage?.(why); return; }
    // Level the ground under the building (part of the same undo step).
    let sum = 0, n = 0;
    for (let yy = ay; yy < ay + fh; yy++) for (let xx = ax; xx < ax + fw; xx++) { sum += w.elev[yy * w.w + xx]; n++; }
    const z = sum / n;
    for (let yy = ay; yy < ay + fh; yy++) for (let xx = ax; xx < ax + fw; xx++) {
      const i = yy * w.w + xx;
      s.patch.touch(i);
      w.elev[i] = z; w.mat[i] = Mat.Dirt; w.cover[i] = Cover.None;
    }
    this.terrainTouched(ax, ay, ax + fw - 1, ay + fh - 1);
    this.addObject(s, o);
  }

  private erase(s: Stroke, x: number, y: number): void {
    const r = this.options.radius, w = this.world;
    const list = this.objects.inRect(x - r - 3, y - r - 3, x + r + 3, y + r + 3, []);
    for (const o of list) {
      if (!this.objects.objects.has(o.id)) continue;
      const hit = this.objects.footprint(o).some(([fx, fy]) => Math.hypot(fx - x, fy - y) <= r);
      if (!hit) continue;
      const cmd = this.removeCommand(o);
      cmd.redo();
      s.cmds.push(cmd);
      if (o.id === this.selectedId) this.select(0);
    }
    for (const kind of ['source', 'drain'] as const) {
      const map = kind === 'source' ? this.sources : this.drains;
      for (const [i, rate] of [...map]) {
        if (Math.hypot((i % w.w) - x, ((i / w.w) | 0) - y) > r) continue;
        const cmd = this.sourceCommand(kind, i, rate, 0);
        cmd.redo();
        s.cmds.push(cmd);
      }
    }
    this.disc(x, y, r, (i) => {
      if (w.cover[i] === Cover.None) return;
      s.patch.touch(i);
      w.cover[i] = Cover.None;
    });
    this.terrainTouched(x - r, y - r, x + r, y + r);
  }

  private removePlantAt(s: Stroke, x: number, y: number): void {
    const o = this.objects.at(y * this.world.w + x);
    if (!o || !PLANTS.has(o.kind)) return;
    const cmd = this.removeCommand(o);
    cmd.redo();
    s.cmds.push(cmd);
  }

  private addObject(s: Stroke, o: Omit<WorldObject, 'id'>): number | null {
    const id = this.objects.add(o);
    if (id === null) return null;
    const placed = { ...this.objects.objects.get(id)! };
    placed.props = { ...placed.props };
    s.cmds.push({
      label: `Place ${OBJECT_DEFS[o.kind].label.toLowerCase()}`,
      undo: () => { this.objects.remove(placed.id); },
      redo: () => { this.objects.add({ ...placed, props: { ...placed.props } }); },
    });
    return id;
  }

  // ------------------------------------------------------------------ commands
  private removeCommand(o: WorldObject): Command {
    const saved = { ...o, props: { ...o.props } };
    return {
      label: `Remove ${OBJECT_DEFS[o.kind].label.toLowerCase()}`,
      undo: () => { this.objects.add({ ...saved, props: { ...saved.props } }); },
      redo: () => { this.objects.remove(saved.id); },
    };
  }

  private updateCommand(id: number, before: Partial<WorldObject>, after: Partial<WorldObject>, label: string): Command {
    return {
      label,
      undo: () => { this.objects.update(id, before); },
      redo: () => { this.objects.update(id, after); },
    };
  }

  private sourceCommand(kind: 'source' | 'drain', i: number, before: number, after: number): Command {
    return {
      label: after > 0 ? `Place ${kind}` : `Remove ${kind}`,
      undo: () => this.applySource(kind, i, before),
      redo: () => this.applySource(kind, i, after),
    };
  }

  private terrainCommand(p: TerrainPatch): Command {
    const w = this.world, n = p.idx.length;
    const before = { elev: Float32Array.from(p.elev), mat: Uint8Array.from(p.mat), cover: Uint8Array.from(p.cover), cvar: Uint8Array.from(p.cvar), magic: Uint8Array.from(p.magic) };
    const after = { elev: new Float32Array(n), mat: new Uint8Array(n), cover: new Uint8Array(n), cvar: new Uint8Array(n), magic: new Uint8Array(n) };
    const idx = Int32Array.from(p.idx);
    for (let k = 0; k < n; k++) {
      const i = idx[k];
      after.elev[k] = w.elev[i]; after.mat[k] = w.mat[i]; after.cover[k] = w.cover[i]; after.cvar[k] = w.coverVar[i]; after.magic[k] = w.magic[i];
    }
    const apply = (v: typeof before) => {
      for (let k = 0; k < n; k++) {
        const i = idx[k];
        w.elev[i] = v.elev[k]; w.mat[i] = v.mat[k]; w.cover[i] = v.cover[k]; w.coverVar[i] = v.cvar[k]; w.magic[i] = v.magic[k];
      }
      this.terrainTouched(p.x0, p.y0, p.x1, p.y1);
    };
    return { label: 'Terrain edit', undo: () => apply(before), redo: () => apply(after) };
  }

  /** Terrain changed in a rectangle: re-shade it and let the water know. */
  private terrainTouched(x0: number, y0: number, x1: number, y1: number): void {
    this.world.markTerrainDirty(x0 - 2, y0 - 2, x1 + 2, y1 + 2);
    this.water?.terrainChanged(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
  }

  /** After elevation edits: steep new slopes become cliff; former cliff that is no longer steep gets ground again. */
  private retouch(p: TerrainPatch): void {
    const w = this.world;
    const x0 = Math.max(0, p.x0 - 1), y0 = Math.max(0, p.y0 - 1), x1 = Math.min(w.w - 1, p.x1 + 1), y1 = Math.min(w.h - 1, p.y1 + 1);
    let elevChanged = false;
    for (let k = 0; k < p.idx.length && !elevChanged; k++) if (p.elev[k] !== w.elev[p.idx[k]]) elevChanged = true;
    if (!elevChanged) return;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * w.w + x, m = w.mat[i];
      if (m === Mat.Path || m === Mat.Glade || m === Mat.Sand || m === Mat.Mud || m === Mat.Dirt) continue;
      const gx = w.elevAt(x + 1, y) - w.elevAt(x - 1, y), gy = w.elevAt(x, y + 1) - w.elevAt(x, y - 1);
      const slope = Math.hypot(gx, gy) * 0.5;
      if (slope > 1.35 && m !== Mat.Cliff && m !== Mat.Stone) { p.touch(i); w.mat[i] = Mat.Cliff; w.cover[i] = Cover.None; }
      else if (slope < 1.0 && m === Mat.Cliff) { p.touch(i); assignSurface(w, w.seed, x, y, x, y); }
    }
    this.terrainTouched(x0, y0, x1, y1);
  }
}

const LABELS: Record<EditTool, string> = {
  select: 'Move', terrain: 'Paint terrain', raise: 'Raise terrain', lower: 'Lower terrain', water: 'Water', source: 'Source',
  drain: 'Drain', channel: 'Carve channel', waterfall: 'Waterfall', rock: 'Place rock', tree: 'Plant trees', flowers: 'Paint plants',
  mushroom: 'Place mushrooms', bridge: 'Place bridge', cottage: 'Place cottage', mill: 'Place mill', ripple: 'Ripple', eraser: 'Erase',
};

/** Ground cover that goes with a painted material (deterministic per cell). */
function coverFor(m: number, h: number, h2: number): number {
  switch (m) {
    case Mat.Grass: return h > 0.75 ? Cover.TallGrass : Cover.ShortGrass;
    case Mat.Meadow: return h > 0.8 ? Cover.Flowers : h > 0.5 ? Cover.TallGrass : h2 > 0.7 ? Cover.Clover : Cover.ShortGrass;
    case Mat.Moss: return h > 0.55 ? Cover.MossPatch : h > 0.4 ? Cover.Fern : Cover.None;
    case Mat.ForestFloor: return h > 0.7 ? Cover.Fern : h > 0.45 ? Cover.Litter : Cover.None;
    case Mat.Stone: return h > 0.85 ? Cover.MossPatch : Cover.None;
    case Mat.Glade: return h > 0.8 ? Cover.Flowers : Cover.None;
    default: return Cover.None;
  }
}
