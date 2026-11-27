import type { Engine } from '../../engine/Engine';
import type { SceneLayer } from '../../engine/render/Composer';
import type { CellBuffer } from '../../engine/render/CellBuffer';
import type { Camera } from '../../engine/world/Camera';
import { g } from '../../engine/render/glyphs';
import { hex, pack, unpack, type RGB } from '../../engine/core/color';
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
import type { NetClient } from '../net/NetClient';
import { nodeId, type RpgCmd, type RpgEvent, type NodeQuery, type GatherNode, type GroundLoot, type RpgView, type ShopEntry } from '../rpg/Rpg';
import type { Item } from '../rpg/items';
import { SHOPS, CREATURE_COMBAT } from '../rpg/content';
import { attackCooldown, count, weaponOf } from '../rpg/hero';
import { Hud, type Tag } from '../rpg/hud';
import { styleFor } from './dragonStyles';

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
  deer: C('#b07a3e'), deerLeg: C('#6e4a26'), deerHead: C('#e2bd84'), wolf: C('#a3a7ae'), wolfLeg: C('#5e6168'), wolfHead: C('#d4d6da'),
  bear: C('#7a4e2c'), bearLeg: C('#4a2e1a'), bearHead: C('#b08a5a'), fox: C('#ff7a2a'), foxLeg: C('#8a3a14'), foxTip: C('#fff4e6'),
  bird0: C('#f4eedc'), bird1: C('#2e2620'), bird2: C('#e0503c'), dead: C('#7a2222'), alert: C('#ffb347'), sleep: C('#b8c6ff'),
  skin: C('#e8c39e'), player: C('#5cc8ff'), playerHead: C('#ffe27a'), say: C('#ffffff'),
  hit: C('#ff4a3d'), loot: C('#ffd166'), swing: C('#f4f1e6'), quest: C('#ffd23f'), shop: C('#8fd3ff'), fallen: C('#8a8f96'),
};
/** A slash mark for a swing at angle a (perpendicular to the radius). */
const slash = (a: number) => { const t = (((a + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI; return t < Math.PI / 8 || t > (7 * Math.PI) / 8 ? '─' : t < (3 * Math.PI) / 8 ? '╲' : t < (5 * Math.PI) / 8 ? '│' : '╱'; };
const ROLE: Record<string, RGB> = {
  hoe: C('#8bbf5a'), tend: C('#c9b27a'), fish: C('#5a8fc9'), gather: C('#6fae6f'), chop: C('#a0703a'), watch: C('#7a8a6a'), mine: C('#7d7d86'),
  trade: C('#d9822b'), serve: C('#c94a5a'), forge: C('#3d3d44'), craft: C('#b08850'), mill: C('#d8d0b8'),
};
const TOOL: Record<string, [string, RGB]> = { hoe: ['/', C('#c9a35a')], fish: ['⌒', C('#cfe0ff')], forge: ['✶', C('#ff8a3a')], trade: ['◆', C('#f2c94c')], chop: ['\\', C('#c9a35a')], mine: ['^', C('#9aa')], gather: ['❀', C('#9fe07a')] };

interface Cell { dx: number; up: number; ch: string; fg: RGB }

/** Left-right mirror of block and line glyphs (sprites are drawn facing east). */
const MIRROR: Record<string, string> = { '▟': '▙', '▙': '▟', '▗': '▖', '▖': '▗', '▜': '▛', '▛': '▜', '▘': '▝', '▝': '▘', '▌': '▐', '▐': '▌', '╱': '╲', '╲': '╱', '◖': '◗', '◗': '◖' };

/**
 * A creature sprite: rows from the ground up, each a string of glyphs (facing east) with a matching string of colour
 * keys (b body, d legs/dark, h head/light, t tail tip). Mirrored when the animal faces west; anchored on its front.
 */
function sprite(out: Cell[], rows: Array<[string, string]>, f: number, pal: Record<string, RGB>): void {
  for (let up = 0; up < rows.length; up++) {
    const ch = [...rows[up][0]], key = rows[up][1], n = ch.length;
    for (let i = 0; i < n; i++) {
      if (ch[i] === ' ') continue;
      out.push({ dx: f > 0 ? i - (n - 1) : (n - 1) - i, up, ch: f > 0 ? ch[i] : MIRROR[ch[i]] ?? ch[i], fg: pal[key[i]] });
    }
  }
}

const PAL = {
  deer: { b: COL.deer, d: COL.deerLeg, h: COL.deerHead },
  wolf: { b: COL.wolf, d: COL.wolfLeg, h: COL.wolfHead },
  bear: { b: COL.bear, d: COL.bearLeg, h: COL.bearHead },
  fox: { b: COL.fox, d: COL.foxLeg, h: COL.fox, t: COL.foxTip },
};

function creatureCells(c: Creature, t: number): Cell[] {
  const f = Math.cos(c.h) >= 0 ? 1 : -1;
  if (!c.alive) return [{ dx: 0, up: 0, ch: '▬', fg: COL.dead }];
  const out: Cell[] = [];
  const asleep = c.st === 'sleep' || c.st === 'rest', moving = c.st === 'flee' || c.st === 'hunt' || c.st === 'charge' || c.st === 'wander' || c.st === 'follow';
  const stride = moving && Math.sin(t * (c.st === 'flee' || c.st === 'hunt' || c.st === 'charge' ? 16 : 7) + c.look * 9) > 0;
  const legs = (a: number, b: number, w: number) => { const r = [...' '.repeat(w)]; r[a] = stride ? '╱' : '│'; r[b] = stride ? '╲' : '│'; return r.join(''); };
  switch (c.sp) {
    case 'deer':
      if (asleep) sprite(out, [['▗▄▟', 'bbb'], ['  ▴', '  h']], f, PAL.deer);
      else if (c.st === 'graze' || c.st === 'drink') sprite(out, [[legs(0, 2, 3) + '•', 'd d h'], ['▗▄▜ ', 'bbb ']], f, PAL.deer);
      else sprite(out, [[legs(0, 2, 3), 'd d'], ['▗▄▟', 'bbb'], ['  ' + (c.male ? 'Ψ' : '▴'), '  h']], f, PAL.deer);
      break;
    case 'wolf':
      if (asleep) sprite(out, [['▗▄▄▖', 'bbbb']], f, PAL.wolf);
      else sprite(out, [[' ' + legs(0, 2, 3), ' d d'], ['╱▄▄▟', 'bbbb'], ['   ▴', '   h']], f, PAL.wolf);
      break;
    case 'bear':
      if (asleep) sprite(out, [['▟██▖', 'bbbh']], f, PAL.bear);
      else sprite(out, [[stride ? '▐ ▌ ' : '▐ ▐ ', 'd d '], ['▟██●', 'bbbh']], f, PAL.bear);
      break;
    case 'fox':
      if (asleep) sprite(out, [['◖▄▖', 'tbb']], f, PAL.fox);
      else sprite(out, [['╱▄▟', 'tbb'], ['  ▴', '  h']], f, PAL.fox);
      break;
    case 'bird': {
      const col = c.look < 0.5 ? COL.bird0 : c.look < 0.85 ? COL.bird1 : COL.bird2;
      out.push({ dx: 0, up: 0, ch: c.alt > 0.5 ? (Math.sin(t * 9 + c.look * 20) > 0 ? 'v' : '⌒') : '•', fg: col });
      break;
    }
  }
  const top = c.sp === 'bird' ? 1 : c.sp === 'bear' ? 2 : 3;
  if (c.alert > 0) out.push({ dx: 0, up: top, ch: '!', fg: COL.alert });
  else if (c.st === 'sleep' && c.sp !== 'bird') out.push({ dx: 0, up: top - 1, ch: '°', fg: COL.sleep });
  return out;
}

function villagerCells(v: Villager, t: number): Cell[] {
  const col = ROLE[v.act] ?? C('#b0a090'), step = v.st === 'walk' || v.st === 'flee' ? Math.sin(t * 8 + v.look * 9) > 0 : false;
  const out: Cell[] = [{ dx: 0, up: 0, ch: step ? '△' : '▲', fg: col }, { dx: 0, up: 1, ch: '•', fg: COL.skin }];
  if (v.st === 'work' && TOOL[v.act]) { const [ch, c] = TOOL[v.act]; out.push({ dx: 1, up: 0, ch, fg: c }); }
  if (v.sayT > 0) out.push({ dx: 1, up: 2, ch: v.st === 'flee' ? '!' : '"', fg: v.st === 'flee' ? COL.alert : COL.say });
  return out;
}

const OTHER = C('#ff9f4a'), OTHER_HEAD = C('#ffffff');
function playerCells(p: Player, t: number): Cell[] {
  const step = p.v > 0.1 && Math.sin(t * (p.running ? 14 : 9)) > 0, me = p.id === 'local';
  return [{ dx: 0, up: 0, ch: step ? '△' : '▲', fg: me ? COL.player : OTHER }, { dx: 0, up: 1, ch: '@', fg: me ? COL.playerHead : OTHER_HEAD }];
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
    const draw = (x: number, y: number, alt: number, cells: Cell[], backing = false) => {
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
        if (backing) { const [r, g2, b] = unpack(buf.bg[k]); buf.bg[k] = pack(r * 0.62, g2 * 0.62, b * 0.62); }
        buf.depth[k] = wy + 0.75;
        buf.kind[k] = 5;
        buf.pick[k] = wy * w.w + wx;
        drawn++;
      }
    };
    const sim = lw.sim, now = performance.now() / 1000;
    const flashed = (id: string, cells: Cell[]) => { if ((lw.flash.get(id) ?? 0) > now) for (const c of cells) c.fg = COL.hit; return cells; };
    for (const g of sim.rpg.loot.values()) draw(g.x, g.y, 0, [{ dx: 0, up: 0, ch: '◈', fg: COL.loot }], true);
    for (const c of sim.wildlife.creatures.values()) if (c.tier === 0 && c.st !== 'dead') draw(c.x, c.y, c.alt, flashed(c.id, creatureCells(c, t)), c.alt < 1);
    for (const v of sim.villages.people.values()) {
      if (!v.out) continue;
      const cells = villagerCells(v, t), m = lw.markers.get(v.id);
      if (m && v.sayT <= 0) cells.push({ dx: 0, up: 2, ch: m, fg: m === '◆' ? COL.shop : COL.quest });
      draw(v.x, v.y, 0, cells);
    }
    for (const p of sim.players.values()) {
      if (p.hero && p.hero.dead >= 0 && p.id === 'local' || p.alive === false) { draw(p.x, p.y, 0, [{ dx: 0, up: 0, ch: '▬', fg: COL.fallen }, { dx: 1, up: 0, ch: '•', fg: COL.fallen }]); continue; }
      draw(p.x, p.y, 0, flashed(p.id, playerCells(p, t)));
      // A swing: three slash marks in an arc in front, for a moment.
      const sw = lw.swings.get(p.id === 'local' ? lw.me : p.id);
      if (sw && now - sw.t < 0.16) for (const da of [-0.65, 0, 0.65]) { const a = sw.h + da; draw(p.x + Math.cos(a) * 1.7, p.y + Math.sin(a) * 1.7, 1, [{ dx: 0, up: 0, ch: slash(a), fg: COL.swing }]); }
    }
    this.drawn = drawn;
  }
}

const D_STATE: Record<DState, DragonState> = {
  sleep: 'SLEEPING', rest: 'RESTING', takeoff: 'TAKING_OFF', patrol: 'FLYING', hunt: 'GLIDING', dive: 'DESCENDING', feed: 'DRINKING', drink: 'DRINKING',
  migrate: 'FLYING', land: 'LANDING', defend: 'CIRCLING', inspect: 'CIRCLING',
};

/** One dragon drawn by the existing renderer: a Dragon entity used only for its animation and drawing. */
interface Puppet { d: Dragon; layer: DragonRenderer; last: [number, number] }

export interface Interaction { label: string; cmd: RpgCmd }

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
  /** Online play: the world server's connection (the server simulates the living world). */
  net: NetClient | null = null;
  /** On-screen bars and numbers (browser only). */
  hud: Hud | null = null;
  /** Short-lived effects: creatures flashing when hit, swings to draw (by player id), quest markers by villager. */
  readonly flash = new Map<string, number>();
  readonly swings = new Map<string, { h: number; t: number }>();
  readonly markers = new Map<string, string>();
  private nextAttack = 0;
  private markerT = 0;
  private findsT = 0;
  /** Things the panel shows: the open tab, a shop. */
  ui = { tab: 'world' as string };

  // ---------------------------------------------------------------- the interface's link
  // The interface reads the character, the rules' view and the world from this object and sends commands through
  // `command()`. It is told when to look again: `revision` rises (and listeners are called) whenever something it
  // shows may have changed. That is after rules events (offline, or from the server), after a command applied here,
  // and on the server's character, welcome and error messages. Health and stamina change every frame, so displays of
  // those also refresh on a timer.
  /** Raised whenever something the interface shows may have changed. */
  revision = 0;
  /** The latest rules events (numbered, newest last, at most 60): notices, the target frame. */
  readonly recent: Array<{ seq: number; at: number; ev: RpgEvent }> = [];
  private seq = 0;
  private listeners = new Set<() => void>();
  /** Be told of changes (a stable function, as React's useSyncExternalStore wants). Returns the unsubscribe. */
  readonly subscribe = (f: () => void): (() => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  /** Something the interface shows may have changed: raise the revision and tell the listeners. */
  changed(): void { this.revision++; for (const f of [...this.listeners]) f(); }

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
        if (ev.code === 'Space') { ev.preventDefault(); this.keys.add('Space'); }
        if (ev.code === 'KeyQ' && !ev.repeat) this.dodge();
        if (ev.code === 'KeyH' && !ev.repeat) this.command({ t: 'use' });
        if (ev.code === 'KeyE' && !ev.repeat) this.interact();
        if (ev.code === 'KeyF' && !ev.repeat) this.watchNearestDragon();
        const tab = ({ KeyI: 'pack', KeyC: 'hero', KeyJ: 'quests', KeyK: 'craft' } as Record<string, string>)[ev.code];
        if (tab && !ev.repeat) { this.ui.tab = this.ui.tab === tab ? 'world' : tab; this.changed(); }
      };
      const up = (ev: KeyboardEvent) => this.keys.delete(ev.code);
      const blur = () => this.keys.clear();
      window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
      this.off.push(() => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); });
      engine.claimSpace = true;
    }
    this.sim.rpg.nodes = new WindowNodes(engine, session);
  }

  dispose(): void { for (const f of this.off) f(); this.off = []; this.engine.claimSpace = false; this.hud?.dispose(); this.hud = null; }

  /** Panel state from the rules: the quest offered, the open shop and its stock, trade offers. */
  view(): RpgView { return this.net ? this.net.view : this.sim.rpg.viewFor('local'); }
  sellPrice(vid: string, it: Item): number { return this.sim.rpg.sellPrice(this.player, vid, it); }
  buyPrice(e: ShopEntry): number { return this.sim.rpg.buyPrice(this.player, e); }
  stationsHere() { return this.sim.rpg.stationsNear(this.player.x, this.player.y); }

  /** The id this traveller has in the rules (the server's id when online). */
  get me(): string { return this.net?.id || 'local'; }

  /** Run a command: here (single player) or on the world server (online). */
  command(c: RpgCmd): void {
    if (this.net) { this.net.cmd(c); return; }
    this.sim.rpg.command('local', c);
    this.processEvents();
    useUnsaved();
    this.changed(); // also when the command emitted nothing (equipping, for one)
  }

  /** Swing at whatever is in front, turning toward the nearest creature in reach. */
  attack(): void {
    const p = this.player, t = this.sim.clock.t;
    if (p.hero.dead >= 0 || (this.net && performance.now() / 1000 < this.nextAttack)) return;
    const w = weaponOf(p.hero);
    let h = p.h, bd = w.reach + 1.4;
    for (const c of this.sim.wildlife.creatures.values()) {
      if (!c.alive || (c.sp === 'bird' && c.alt > 2)) continue;
      const d = Math.hypot(c.x - p.x, c.y - p.y) - CREATURE_COMBAT[c.sp].size;
      if (d < bd) { bd = d; h = Math.atan2(c.y - p.y, c.x - p.x); }
    }
    p.h = h;
    if (this.net) { this.nextAttack = performance.now() / 1000 + attackCooldown(p.hero); this.swings.set(this.me, { h, t: performance.now() / 1000 }); }
    void t;
    this.command({ t: 'attack', h });
  }

  dodge(): void {
    const k = this.keyInput(), p = this.player;
    const h = Math.hypot(k.dx, k.dy) > 0.01 ? Math.atan2(k.dy, k.dx) : p.h + Math.PI;
    if (this.net) { p.hero.dodgeUntil = this.sim.clock.t + 0.35; p.hero.dodgeH = h; }
    this.command({ t: 'dodge', h });
  }

  /** Turn rules events into effects, messages and HUD numbers. */
  processEvents(evs: RpgEvent[] = this.sim.rpg.drain()): void {
    const me = this.me, now = performance.now() / 1000, hud = this.hud, p = this.player, z = (x: number, y: number) => this.q.height(x, y);
    for (const ev of evs) {
      switch (ev.e) {
        case 'msg': if (ev.who === me) this.message = ev.text; break; // shown by the interface's notices
        case 'swing': this.swings.set(ev.who === me ? me : ev.who, { h: ev.h, t: now }); break;
        case 'hit': this.flash.set(ev.target, now + 0.18); hud?.float(ev.x, ev.y, z(ev.x, ev.y) + 1.5, `${ev.dmg}${ev.crit ? '!' : ''}`, ev.crit ? '#e8c477' : ev.who === me ? '#f3ecdc' : '#d9a37c', ev.crit); break;
        case 'kill': hud?.float(ev.x, ev.y, z(ev.x, ev.y) + 2, '✶', '#e8c477', true); break;
        case 'hurt': if (ev.who === me) { hud?.float(p.x, p.y, z(p.x, p.y) + 2, `-${ev.dmg}`, '#e06a5b'); hud?.hurt(); } this.flash.set(ev.who === me ? 'local' : ev.who, now + 0.18); break;
        case 'evade': if (ev.who === me) hud?.float(p.x, p.y, z(p.x, p.y) + 2, 'dodged', '#8cc6d8'); break;
        case 'xp': if (ev.who === me) hud?.float(p.x, p.y, z(p.x, p.y) + 2.5, `+${ev.n} xp`, '#d8b45c', false, 1.4); break;
        case 'level': if (ev.who === me) { hud?.float(p.x, p.y, z(p.x, p.y) + 3, `Level ${ev.level}!`, '#e8c477', true, 2.2); this.message = `Level ${ev.level}! Two attribute points to spend.`; } break; // the interface shows a banner
        case 'skill': if (ev.who === me) { const t = `${ev.skill[0].toUpperCase()}${ev.skill.slice(1)} is now ${ev.level}.`; hud?.float(p.x, p.y, z(p.x, p.y) + 3, t, '#a8d08d', false, 1.8); } break;
        case 'respawn': if (ev.who === me) { p.x = ev.x; p.y = ev.y; this.follow = 'player'; if (!this.q.detailed(p.x, p.y)) this.session.loadAt(this.engine, this.session.bp.coords.cellToMap([p.x, p.y])); } break;
        case 'quest': if (ev.who === me && ev.status === 'ready') hud?.float(p.x, p.y, z(p.x, p.y) + 3, 'Quest ready!', '#e8c477', true, 2); break;
        default: break;
      }
    }
    if (!evs.length) return;
    for (const ev of evs) this.recent.push({ seq: ++this.seq, at: now, ev });
    if (this.recent.length > 60) this.recent.splice(0, this.recent.length - 60);
    this.changed();
  }

  /** Quest markers over villagers near the traveller ("!" has work, "?" waiting for you), once a second. */
  private updateMarkers(): void {
    this.markers.clear();
    const p = this.player, h = p.hero;
    for (const v of this.sim.villages.people.values()) {
      if (!v.out || Math.hypot(v.x - p.x, v.y - p.y) > 90) continue;
      const q = h.quests.find((x) => x.giver === v.id);
      if (q) { if (q.status === 'ready' || ((q.kind === 'gather' || q.kind === 'craft') && count(h, q.target) >= q.need)) this.markers.set(v.id, '?'); continue; }
      if (h.quests.some((x) => x.kind === 'deliver' && x.target === v.village)) { this.markers.set(v.id, '?'); continue; }
      if (h.quests.length < 5 && this.sim.rpg.isGiver(v)) this.markers.set(v.id, '!');
      else if (SHOPS[v.tag]) this.markers.set(v.id, '◆');
    }
  }

  /** Finds taken (here or by others online) disappear from the loaded area. */
  sweepFinds(): void {
    const s = this.session, e = this.engine, S = s.win.S, [ox, oy] = s.win.origin, taken = this.sim.rpg.taken;
    if (!taken.size) return;
    for (const o of [...e.objects.objects.values()]) if (o.kind === 'cache' && taken.has(nodeId(o.variant, o.x + ox * S, o.y + oy * S))) e.objects.remove(o.id);
  }

  /** HUD tags: health bars over wounded creatures, names over other players. */
  private tags(): Tag[] {
    const out: Tag[] = [], p = this.player;
    for (const c of this.sim.wildlife.creatures.values()) {
      if (!c.alive || c.tier !== 0) continue;
      const max = CREATURE_COMBAT[c.sp].hp;
      if (c.hp >= max || Math.hypot(c.x - p.x, c.y - p.y) > 60) continue;
      out.push({ id: c.id, x: c.x, y: c.y, z: this.q.height(c.x, c.y) + c.alt + 2, frac: c.hp / max, text: c.foe ? '!' : '', colour: '#ffb347' });
    }
    for (const o of this.sim.players.values()) {
      if (o.id === 'local' || Math.hypot(o.x - p.x, o.y - p.y) > 80) continue;
      out.push({ id: `p:${o.id}`, x: o.x, y: o.y, z: this.q.height(o.x, o.y) + 2.5, text: o.name, colour: '#ffb38a', frac: o.hpFrac });
    }
    return out;
  }

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
    if (this.keys.has('Space') && !e.clock.paused && !s.travel) this.attack();
    const ts = performance.now();
    if (this.net) this.net.frame(dt);
    else this.sim.update(simDt, { hour: e.env.time, rain: e.env.rain });
    this.processEvents();
    this.stats.simMs = performance.now() - ts;
    const now = performance.now() / 1000;
    if (now - this.markerT > 1) { this.markerT = now; this.updateMarkers(); }
    if (now - this.findsT > 1) { this.findsT = now; this.sweepFinds(); }
    if (!this.hud && e.renderer && typeof document !== 'undefined' && e.renderer.canvas.isConnected) this.hud = new Hud(e, s);
    this.hud?.update(this.tags(), p.hero.dead >= 0 ? this.sim.clock.t - p.hero.dead : -1, p.hero.homeName);
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
        const layer = new DragonRenderer(dragon, styleFor(d.id));
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

  /** What E would do here: talk, pick up loot, take a find, explore an old place, gather (nearest first), or null. */
  interaction(): Interaction | null {
    const p = this.player, s = this.session, e = this.engine, S = s.win.S, [ox, oy] = s.win.origin;
    if (p.hero.dead >= 0) return null;
    // Standing on loot: pick it up (before anyone nearby).
    let lb: GroundLoot | null = null, ld = 2.4;
    for (const g of this.sim.rpg.loot.values()) { const d = Math.hypot(g.x - p.x, g.y - p.y); if (d < ld) { ld = d; lb = g; } }
    if (lb && ld < 1.5) return { label: `Pick up: ${lb.label}`, cmd: { t: 'pickup', id: lb.id } };
    // In a crowd, the one waiting for you ("?") comes first, then those with work ("!"), then shops, then the nearest.
    let vb: Villager | null = null, vs = Infinity;
    for (const v of this.sim.villages.people.values()) {
      if (!v.out) continue;
      const d = Math.hypot(v.x - p.x, v.y - p.y);
      if (d > 2.5) continue;
      const m = this.markers.get(v.id), score = d - (m === '?' ? 3 : m === '!' ? 1.5 : m === '◆' ? 0.5 : 0);
      if (score < vs) { vs = score; vb = v; }
    }
    if (vb) {
      const m = this.markers.get(vb.id), what = m === '!' ? ' (has work)' : m === '?' ? ' (quest)' : SHOPS[vb.tag] ? ' (shop)' : '';
      return { label: `Talk to ${vb.name}${what}`, cmd: { t: 'talk', vid: vb.id } };
    }
    if (lb) return { label: `Pick up: ${lb.label}`, cmd: { t: 'pickup', id: lb.id } };
    const [wx, wy] = s.win.toWindow(p.x, p.y);
    const near = e.objects.inRect(Math.floor(wx) - 6, Math.floor(wy) - 6, Math.floor(wx) + 6, Math.floor(wy) + 6, []);
    let best: (typeof near)[number] | null = null, bd = 3.2;
    for (const o of near) {
      const gather = o.kind === 'tree' || o.kind === 'rock' || o.kind === 'mushroom';
      if (!gather && !['cache', 'tower', 'ruin', 'cave', 'stone'].includes(o.kind)) continue;
      const fp = e.objects.footprint(o);
      const d = Math.min(...fp.map(([fx, fy]) => Math.hypot(fx + 0.5 - wx, fy + 0.5 - wy))) + (gather ? 0.8 : 0); // finds and places first
      if (d < bd) { bd = d; best = o; }
    }
    if (!best) return null;
    const o = best, cx = o.x + ox * S, cy = o.y + oy * S;
    if (o.kind === 'cache') {
      const what = o.variant === 'chest' ? 'treasure chest' : o.variant === 'herbs' ? 'herbs' : o.variant === 'ore' ? 'ore' : 'relic';
      return { label: `Take the ${what}`, cmd: { t: 'gather', node: nodeId(o.variant, cx, cy) } };
    }
    if (o.kind === 'tree' || o.kind === 'rock' || o.kind === 'mushroom') {
      return { label: o.kind === 'tree' ? 'Cut wood' : o.kind === 'rock' ? 'Break rock' : 'Pick mushrooms', cmd: { t: 'gather', node: nodeId(o.kind, cx, cy) } };
    }
    const place = s.terrain.places().find((q) => Math.hypot(q.x - cx, q.y - cy) < 12);
    if (!place) return null;
    const label = o.kind === 'tower' ? `Climb ${place.name}` : o.kind === 'cave' ? `Explore ${place.name}` : o.kind === 'ruin' ? `Search ${place.name}` : `Read ${place.name}`;
    return { label, cmd: { t: 'explore', place: place.id } };
  }

  interact(): void {
    const it = this.interaction();
    if (!it) { this.message = 'Nothing to do here.'; this.changed(); return; }
    this.command(it.cmd);
    if (it.cmd.t === 'talk' && SHOPS[this.sim.villages.people.get(it.cmd.vid)?.tag ?? '']) this.ui.tab = 'shop';
    if (it.cmd.t === 'gather' && !this.net) this.sweepFinds();
  }
}

/** World objects in the loaded window by node id (`kind:x,y`, continent cells), for validating gathering. */
class WindowNodes implements NodeQuery {
  constructor(private engine: Engine, private s: ContinentSession) {}
  node(id: string): GatherNode | null {
    const m = /^([a-z]+):(-?\d+),(-?\d+)$/.exec(id);
    if (!m) return null;
    const S = this.s.win.S, [ox, oy] = this.s.win.origin, x = +m[2] - ox * S, y = +m[3] - oy * S;
    for (const o of this.engine.objects.inRect(x - 1, y - 1, x + 1, y + 1, [])) {
      if (o.x !== x || o.y !== y) continue;
      if (o.kind === m[1] || (o.kind === 'cache' && o.variant === m[1])) return { kind: o.kind, variant: o.variant, x: +m[2], y: +m[3] };
    }
    return null;
  }
}

/** Mark the world unsaved (if the app's store is loaded). */
let markUnsaved: (() => void) | null = null;
export const setUnsavedHook = (f: () => void) => { markUnsaved = f; };
const useUnsaved = () => markUnsaved?.();
