import type { Engine } from '../../engine/Engine';
import type { SceneLayer } from '../../engine/render/Composer';
import type { CellBuffer } from '../../engine/render/CellBuffer';
import type { Camera } from '../../engine/world/Camera';
import { g } from '../../engine/render/glyphs';
import { hex, pack, type RGB } from '../../engine/core/color';
import { Dragon } from '../../engine/dragon/Dragon';
import { DragonRenderer } from '../../engine/dragon/DragonRenderer';
import { animate } from '../../engine/dragon/DragonAnimation';
import type { DragonState } from '../../engine/dragon/DragonEntity';
import { regionAt } from '../blueprint';
import type { ContinentSession } from '../session';
import type { TerrainQuery } from './core';
import { LifeSim, type Player, type PlayerInput } from './LifeSim';
import type { Creature } from './wildlife';
import type { Villager } from './villagers';
import type { DragonAgent, DState } from './dragons';

/**
 * The living world in the browser: the player avatar (WASD to walk, Shift to run, E to interact, F to watch the
 * nearest dragon), the simulation stepped with the engine's clock, a layer drawing creatures, villagers and players,
 * and dragons drawn by the existing dragon renderer (puppeted from the continent dragons' state).
 */

/** Ground, water and walkability from the loaded window (exact), or coarse answers outside it. */
export class WindowQuery implements TerrainQuery {
  private site;
  private ids: string[];
  constructor(private engine: Engine, private s: ContinentSession) {
    this.site = s.terrain.siteQuery();
    this.ids = s.bp.data.regions.map((r) => r.id);
  }
  private idx(x: number, y: number): number {
    const S = this.s.win.S, W = this.s.win.W, wx = Math.floor(x - this.s.win.origin[0] * S), wy = Math.floor(y - this.s.win.origin[1] * S);
    return wx < 1 || wy < 1 || wx >= W - 1 || wy >= W - 1 ? -1 : wy * W + wx;
  }
  detailed(x: number, y: number): boolean { return this.idx(x, y) >= 0; }
  private deck(i: number): number | null { const o = this.engine.objects.at(i); return o && o.kind === 'span' ? (o.props.z ?? 0) : null; }
  height(x: number, y: number): number {
    const i = this.idx(x, y);
    if (i < 0) return this.site.z(x, y);
    const d = this.deck(i);
    return (d ?? this.engine.world.elev[i]) + this.s.win.datum;
  }
  water(x: number, y: number): boolean {
    const i = this.idx(x, y);
    if (i < 0) return this.site.wet(x, y, 0);
    const depth = this.engine.water ? this.engine.water.view.depth[i] : 0;
    return (this.s.win.waterKind[i] !== 0 || depth > 0.35) && this.deck(i) === null;
  }
  walkable(x: number, y: number): boolean {
    const i = this.idx(x, y);
    if (i < 0) return !this.site.wet(x, y, 0);
    if (this.deck(i) !== null) return true;
    const w = this.engine.world;
    if (w.solid[i] || this.water(x, y)) return false;
    const W = this.s.win.W;
    return Math.abs(w.elev[i + 1] - w.elev[i - 1]) + Math.abs(w.elev[i + W] - w.elev[i - W]) < 3.2;
  }
  biome(x: number, y: number): string {
    const i = this.idx(x, y);
    if (i >= 0) return this.ids[this.s.win.biome[i]] ?? 'sea';
    return regionAt(this.s.bp, x / this.s.bp.coords.metresPerUnit, y / this.s.bp.coords.metresPerUnit);
  }
}

const C = (s: string) => hex(s);
const P = (c: RGB, k = 1) => pack(c[0] * k, c[1] * k, c[2] * k);
/** Colours by species, villager job group and player. */
const COL: Record<string, RGB> = {
  deer: C('#a8743c'), deerHead: C('#d9b37a'), wolf: C('#8d9199'), bear: C('#5a3a22'), fox: C('#e0742a'), foxTip: C('#f4efe6'),
  bird0: C('#e8e2d0'), bird1: C('#4a3e36'), bird2: C('#c94a3a'), dead: C('#7a2222'), alert: C('#ffb347'), sleep: C('#b8c6ff'),
  skin: C('#e8c39e'), player: C('#5cc8ff'), playerHead: C('#ffe27a'), say: C('#ffffff'),
};
const ROLE: Record<string, RGB> = {
  hoe: C('#8bbf5a'), tend: C('#c9b27a'), fish: C('#5a8fc9'), gather: C('#6fae6f'), chop: C('#a0703a'), watch: C('#7a8a6a'), mine: C('#7d7d86'),
  trade: C('#d9822b'), serve: C('#c94a5a'), forge: C('#3d3d44'), craft: C('#b08850'), mill: C('#d8d0b8'),
};
const TOOL: Record<string, [string, RGB]> = { hoe: ['/', C('#c9a35a')], fish: ['⌒', C('#cfe0ff')], forge: ['✶', C('#ff8a3a')], trade: ['◆', C('#f2c94c')], chop: ['\\', C('#c9a35a')], mine: ['^', C('#9aa')], gather: ['❀', C('#9fe07a')] };

interface Cell { dx: number; up: number; ch: string; fg: RGB; bg?: RGB }

function creatureCells(c: Creature, t: number): Cell[] {
  const f = Math.cos(c.h) >= 0 ? 1 : -1, back = f > 0 ? 0 : 1, front = f > 0 ? 1 : 0;
  if (!c.alive) return [{ dx: 0, up: 0, ch: '▬', fg: COL.dead }];
  const out: Cell[] = [];
  const asleep = c.st === 'sleep' || c.st === 'rest';
  switch (c.sp) {
    case 'deer':
      if (asleep) out.push({ dx: 0, up: 0, ch: '▬', fg: COL.deer }, { dx: 1, up: 0, ch: '▬', fg: COL.deer });
      else out.push({ dx: back, up: 0, ch: '▄', fg: COL.deer }, { dx: front, up: 0, ch: '▄', fg: COL.deer }, { dx: front, up: 1, ch: c.st === 'graze' ? '▖' : c.male ? 'Ψ' : '^', fg: COL.deerHead });
      break;
    case 'wolf':
      out.push({ dx: back, up: 0, ch: asleep ? '▬' : '▄', fg: COL.wolf }, { dx: front, up: 0, ch: asleep ? '▬' : '▄', fg: COL.wolf });
      if (!asleep) out.push({ dx: front, up: 1, ch: '▴', fg: COL.wolf }, { dx: back - f, up: 0, ch: '~', fg: COL.wolf });
      break;
    case 'bear':
      out.push({ dx: back, up: 0, ch: '▓', fg: COL.bear, bg: P(COL.bear, 0.6) as unknown as RGB }, { dx: front, up: 0, ch: '▓', fg: COL.bear });
      if (!asleep) out.push({ dx: back, up: 1, ch: '▄', fg: COL.bear }, { dx: front, up: 1, ch: '●', fg: COL.bear });
      break;
    case 'fox':
      out.push({ dx: 0, up: 0, ch: asleep ? '◖' : '▄', fg: COL.fox });
      if (!asleep) out.push({ dx: 0, up: 1, ch: '▴', fg: COL.fox }, { dx: -f, up: 0, ch: '~', fg: COL.foxTip });
      break;
    case 'bird': {
      const col = c.look < 0.5 ? COL.bird0 : c.look < 0.85 ? COL.bird1 : COL.bird2;
      out.push({ dx: 0, up: 0, ch: c.alt > 0.5 ? (Math.sin(t * 9 + c.look * 20) > 0 ? 'v' : '^') : '·', fg: col });
      break;
    }
  }
  if (c.alert > 0) out.push({ dx: 0, up: c.sp === 'bird' ? 1 : 2, ch: '!', fg: COL.alert });
  else if (c.st === 'sleep' && c.sp !== 'bird') out.push({ dx: 1, up: 1, ch: '°', fg: COL.sleep });
  return out;
}

function villagerCells(v: Villager, t: number): Cell[] {
  const col = ROLE[v.act] ?? C('#b0a090'), step = v.st === 'walk' || v.st === 'flee' ? Math.sin(t * 8 + v.look * 9) > 0 : false;
  const out: Cell[] = [{ dx: 0, up: 0, ch: step ? '△' : '▲', fg: col }, { dx: 0, up: 1, ch: '•', fg: COL.skin }];
  if (v.st === 'work' && TOOL[v.act]) { const [ch, c] = TOOL[v.act]; out.push({ dx: 1, up: 0, ch, fg: c }); }
  if (v.sayT > 0) out.push({ dx: 1, up: 2, ch: v.st === 'flee' ? '!' : '"', fg: v.st === 'flee' ? COL.alert : COL.say });
  return out;
}

function playerCells(p: Player, t: number): Cell[] {
  const step = p.v > 0.1 && Math.sin(t * (p.running ? 14 : 9)) > 0;
  return [{ dx: 0, up: 0, ch: step ? '△' : '▲', fg: COL.player }, { dx: 0, up: 1, ch: '@', fg: COL.playerHead }];
}

/** Draws creatures, villagers and players over the terrain (occluded by nearer terrain like objects are). */
export class LifeLayer implements SceneLayer {
  readonly name = 'life';
  drawn = 0;
  constructor(private lw: LivingWorld) {}
  after(buf: CellBuffer, cam: Camera, t: number): void {
    const lw = this.lw, s = lw.session, e = lw.engine, w = e.world, S = s.win.S, ox = s.win.origin[0] * S, oy = s.win.origin[1] * S;
    const x0 = Math.floor(cam.x), y0 = Math.floor(cam.y), hs = cam.heightScale, cols = buf.cols, rows = buf.rows;
    let drawn = 0;
    const draw = (x: number, y: number, alt: number, cells: Cell[]) => {
      const wx = Math.floor(x - ox), wy = Math.floor(y - oy);
      if (wx < x0 - 4 || wx > x0 + cols + 4 || wy < y0 - 8 || wy > y0 + rows + 60) return;
      const z = (lw.q.height(x, y) - s.win.datum) + alt;
      for (const c of cells) {
        const col = wx + c.dx - x0, row = wy - y0 - Math.round(z * hs) - c.up;
        if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
        const k = row * cols + col;
        if (alt < 1 && buf.depth[k] > wy + 0.85) continue;
        buf.glyph[k] = g(c.ch);
        buf.fg[k] = P(c.fg);
        if (c.bg) buf.bg[k] = c.bg as unknown as number;
        buf.depth[k] = wy + 0.75;
        buf.kind[k] = 5;
        buf.pick[k] = wy * w.w + wx;
        drawn++;
      }
    };
    const sim = lw.sim;
    for (const c of sim.wildlife.creatures.values()) if (c.tier === 0 && c.st !== 'dead') draw(c.x, c.y, c.alt, creatureCells(c, t));
    for (const v of sim.villages.people.values()) if (v.out) draw(v.x, v.y, 0, villagerCells(v, t));
    for (const p of sim.players.values()) draw(p.x, p.y, 0, playerCells(p, t));
    this.drawn = drawn;
  }
}

const D_STATE: Record<DState, DragonState> = {
  sleep: 'SLEEPING', rest: 'RESTING', takeoff: 'TAKING_OFF', patrol: 'FLYING', hunt: 'GLIDING', dive: 'DESCENDING', feed: 'DRINKING', drink: 'DRINKING',
  migrate: 'FLYING', land: 'LANDING', defend: 'CIRCLING', inspect: 'CIRCLING',
};

/** One dragon drawn by the existing renderer: a Dragon entity used only for its animation and drawing. */
interface Puppet { d: Dragon; layer: DragonRenderer; last: [number, number] }

export interface Interaction { label: string; run: () => string }

export class LivingWorld {
  readonly sim: LifeSim;
  readonly q: WindowQuery;
  readonly layer: LifeLayer;
  readonly player: Player;
  private keys = new Set<string>();
  private puppets = new Map<string, Puppet>();
  private off: Array<() => void> = [];
  /** Camera follows: the player, a dragon (by id), or nothing (free camera). */
  follow: 'player' | string | null = 'player';
  /** Last interaction message. */
  message = '';
  readonly stats = { frameMs: 0, simMs: 0, puppets: 0 };
  /** External input (tests, scripted demos): overrides the keyboard while set. */
  input: PlayerInput | null = null;

  constructor(readonly engine: Engine, readonly session: ContinentSession) {
    this.q = new WindowQuery(engine, session);
    this.sim = new LifeSim(session.bp, session.terrain, this.q);
    const [hx, hy] = engine.home ?? [session.win.W / 2, session.win.W / 2];
    const [cx, cy] = session.win.toContinent(hx, hy);
    // Start just outside the village square.
    this.player = this.sim.addPlayer('local', 'Traveller', cx + 6, cy + 14);
    // Start on dry, open ground (search outward if the spot is water or inside something).
    search: for (let r = 0; r < 200; r += 2) for (let k = 0; k < (r ? 16 : 1); k++) {
      const x = cx + 6 + Math.cos((k / 16) * 6.28) * r, y = cy + 14 + Math.sin((k / 16) * 6.28) * r;
      if (this.q.walkable(x, y)) { this.player.x = x; this.player.y = y; break search; }
    }
    this.sim.start({ x: cx, y: cy });
    this.layer = new LifeLayer(this);
    const layers = engine.composer.layers, k = layers.indexOf(engine.atmosphere);
    layers.splice(k < 0 ? layers.length : k, 0, this.layer);
    if (typeof window !== 'undefined') {
      const typing = (ev: KeyboardEvent) => { const t = ev.target as HTMLElement | null; return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable); };
      const down = (ev: KeyboardEvent) => {
        if (typing(ev)) return;
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight'].includes(ev.code)) {
          this.keys.add(ev.code);
          if (this.follow !== 'player') { this.follow = 'player'; if (!this.q.detailed(this.player.x, this.player.y)) this.session.loadAt(this.engine, this.session.bp.coords.cellToMap([this.player.x, this.player.y])); }
        }
        if (ev.code === 'KeyE' && !ev.repeat) this.interact();
        if (ev.code === 'KeyF' && !ev.repeat) this.watchNearestDragon();
      };
      const up = (ev: KeyboardEvent) => this.keys.delete(ev.code);
      const blur = () => this.keys.clear();
      window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
      this.off.push(() => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); });
    }
  }

  dispose(): void { for (const f of this.off) f(); this.off = []; }

  private keyInput(): PlayerInput {
    if (this.input) return this.input;
    const k = this.keys;
    return { dx: (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0), dy: (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0), run: k.has('ShiftLeft') || k.has('ShiftRight') };
  }

  /** Per frame (from the continent session): move the player, step the world, follow with the camera, draw dragons. */
  frame(dt: number): void {
    const t0 = performance.now(), e = this.engine, s = this.session, p = this.player;
    const simDt = e.clock.paused ? 0 : dt * e.clock.speed;
    if (s.travel) {
      const [mx, my] = s.travel.position(), c = s.bp.coords.mapToCell([mx, my]);
      p.x = c[0]; p.y = c[1];
    } else if (!e.clock.paused) this.sim.movePlayer(p, this.keyInput(), dt);
    const ts = performance.now();
    this.sim.update(simDt, { hour: e.env.time, rain: e.env.rain });
    this.stats.simMs = performance.now() - ts;
    // Camera: keep the followed thing in the middle (the window streams after it).
    const target = this.follow === 'player' ? p : this.follow ? this.sim.dragons.dragons.find((d) => d.id === this.follow) : null;
    if (target && !s.travel) {
      const [wx, wy] = s.win.toWindow(target.x, target.y), W = s.win.W;
      const cx = Math.max(1, Math.min(W - 2, Math.round(wx))), cy = Math.max(1, Math.min(W - 2, Math.round(wy)));
      const alt = 'z' in target ? Math.min((target as DragonAgent).alt, 36) : 0;
      e.cam.centerOn(wx, wy, W, W, e.world.elevAt(cx, cy) + alt);
    }
    this.updatePuppets(dt);
    this.stats.frameMs = performance.now() - t0;
  }

  private updatePuppets(dt: number): void {
    const s = this.session, e = this.engine, W = s.win.W, seen = new Set<string>();
    for (const d of this.sim.dragons.dragons) {
      const [wx, wy] = s.win.toWindow(d.x, d.y);
      if (wx < -40 || wy < -40 || wx > W + 40 || wy > W + 40) continue;
      seen.add(d.id);
      let pp = this.puppets.get(d.id);
      if (!pp) {
        const dragon = new Dragon(e.world, e.objects, e.water ? e.water.view : null, e.env as never, e.world.seed);
        dragon.e.name = d.name; dragon.e.autonomous = false; dragon.e.effects = false;
        const layer = new DragonRenderer(dragon);
        const layers = e.composer.layers, k = layers.indexOf(e.atmosphere);
        layers.splice(k < 0 ? layers.length : k, 0, layer);
        pp = { d: dragon, layer, last: [wx, wy] };
        this.puppets.set(d.id, pp);
      }
      const en = pp.d.e, cx = Math.max(1, Math.min(W - 2, Math.round(wx))), cy = Math.max(1, Math.min(W - 2, Math.round(wy)));
      const jump = Math.hypot(wx - pp.last[0], wy - pp.last[1]) > 40;
      en.x = wx; en.y = wy;
      // Height drawn above the ground is capped: high dragons appear small with their shadow far below (the 2.5D
      // view cannot lift a sprite hundreds of metres).
      en.z = e.world.elevAt(cx, cy) + Math.min(d.alt, 36);
      en.heading = d.h; en.speed = d.v; en.vz = d.vz; en.angVel = d.turn / Math.max(1e-3, dt);
      const st = D_STATE[d.st];
      if (en.state !== st) { en.prevState = en.state; en.state = st; en.stateTime = 0; }
      en.time += dt; en.stateTime += dt;
      if (jump) en.resetTail();
      animate(en, dt);
      pp.last = [wx, wy];
    }
    for (const [id, pp] of this.puppets) if (!seen.has(id)) {
      const layers = e.composer.layers, k = layers.indexOf(pp.layer);
      if (k >= 0) layers.splice(k, 1);
      this.puppets.delete(id);
    }
    this.stats.puppets = this.puppets.size;
  }

  /** The nearest dragon (and its distance, m). */
  nearestDragon(): { d: DragonAgent; km: number } | null {
    let best: DragonAgent | null = null, bd = Infinity;
    for (const d of this.sim.dragons.dragons) { const dd = Math.hypot(d.x - this.player.x, d.y - this.player.y); if (dd < bd) { bd = dd; best = d; } }
    return best ? { d: best, km: bd / 1000 } : null;
  }

  watchNearestDragon(): void {
    const n = this.nearestDragon();
    if (!n) return;
    this.follow = this.follow === n.d.id ? 'player' : n.d.id;
    this.message = this.follow === 'player' ? 'Back to the traveller.' : `Watching ${n.d.name} (${n.km.toFixed(1)} km away). Press F or move to return.`;
    if (this.follow !== 'player' && n.km > 1.5) this.message += ' (The view jumps there.)';
    // Far away: the window loads there (the traveller stays put); coming back loads the traveller's surroundings.
    const t = this.follow === 'player' ? this.player : n.d;
    if (!this.q.detailed(t.x, t.y)) this.session.loadAt(this.engine, this.session.bp.coords.cellToMap([t.x, t.y]));
  }

  /** What E would do here (nearest interactable within 2.5 m), or null. */
  interaction(): Interaction | null {
    const p = this.player, s = this.session, e = this.engine, mpu = s.bp.coords.metresPerUnit;
    const [wx, wy] = s.win.toWindow(p.x, p.y);
    // Villagers first.
    let vb: Villager | null = null, vd = 2.5;
    for (const v of this.sim.villages.people.values()) { if (!v.out) continue; const d = Math.hypot(v.x - p.x, v.y - p.y); if (d < vd) { vd = d; vb = v; } }
    if (vb) { const v = vb; return { label: `Talk to ${v.name}`, run: () => this.sim.villages.greet(v) }; }
    const near = e.objects.inRect(Math.floor(wx) - 6, Math.floor(wy) - 6, Math.floor(wx) + 6, Math.floor(wy) + 6, []);
    let best: (typeof near)[number] | null = null, bd = 3.2;
    for (const o of near) {
      if (!['cache', 'tower', 'ruin', 'cave', 'stone'].includes(o.kind)) continue;
      const fp = e.objects.footprint(o);
      const d = Math.min(...fp.map(([fx, fy]) => Math.hypot(fx + 0.5 - wx, fy + 0.5 - wy)));
      if (d < bd) { bd = d; best = o; }
    }
    if (!best) return null;
    const o = best, place = s.terrain.places().find((q) => Math.hypot(q.x - (o.x + s.win.origin[0] * s.win.S), q.y - (o.y + s.win.origin[1] * s.win.S)) < 12);
    const discover = () => {
      if (!place) return '';
      const was = this.sim.discovery.discovered.has(place.id);
      this.sim.discovery.discovered.add(place.id);
      this.sim.revealFrom(place.x, place.y, 300);
      return was ? '' : ` Discovered: ${place.name}.`;
    };
    if (o.kind === 'cache') {
      const what = o.variant === 'chest' ? 'treasure chest' : o.variant === 'herbs' ? 'herbs' : o.variant === 'ore' ? 'ore' : 'relic';
      return { label: `Take the ${what}`, run: () => {
        e.objects.remove(o.id);
        const gain: Record<string, [string, number]> = { chest: ['coins', 20 + Math.floor(Math.random() * 30)], herbs: ['herbs', 1], ore: ['ore', 1], relic: ['relics', 1] };
        const [item, n] = gain[o.variant] ?? ['relics', 1];
        p.inv[item] = (p.inv[item] ?? 0) + n;
        useUnsaved();
        return `Took ${n} ${item}.`;
      } };
    }
    if (o.kind === 'tower') return { label: `Climb ${place?.name ?? 'the tower'}`, run: () => {
      const n = this.sim.revealFrom(o.x + s.win.origin[0] * s.win.S, o.y + s.win.origin[1] * s.win.S, 3000);
      const d = discover();
      useUnsaved();
      return `From the top you can see for kilometres (${n} map cells revealed).${d}`;
    } };
    const label = o.kind === 'cave' ? 'Explore the cave' : o.kind === 'ruin' ? 'Search the ruin' : 'Read the old stone';
    void mpu;
    return { label, run: () => { const d = discover(); useUnsaved(); return (o.kind === 'cave' ? 'Cold air and old bones in the dark.' : o.kind === 'ruin' ? 'Moss-covered stones of an older age.' : 'Worn runes, still faintly glowing.') + d; } };
  }

  interact(): void {
    const it = this.interaction();
    this.message = it ? it.run() : 'Nothing to do here.';
    if (it) this.sim.note(this.message);
  }
}

/** Mark the world unsaved (if the app's store is loaded). */
let markUnsaved: (() => void) | null = null;
export const setUnsavedHook = (f: () => void) => { markUnsaved = f; };
const useUnsaved = () => markUnsaved?.();
