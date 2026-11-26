import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { WORLD } from '../src/world/data';
import { buildBlueprint, regionAt, type Blueprint } from '../src/world/blueprint';
import { ContinentTerrain, WK_NONE, type RegionData } from '../src/world/terrain';
import { LifeSim, RUN, type Player } from '../src/world/life/LifeSim';
import type { TerrainQuery } from '../src/world/life/core';
import type { RegionEditJSON } from '../src/world/edits';
import { PROTOCOL, type ClientMsg, type ServerMsg, type SnapCreature, type SnapDragon, type SnapPlayer, type SnapVillager, type SnapLoot } from '../src/world/net/protocol';
import { OBJECT_DEFS } from '../src/engine/objects/defs';
import { heroToJSON, heroFromJSON, maxHp } from '../src/world/rpg/hero';
import { CREATURE_COMBAT } from '../src/world/rpg/content';
import type { NodeQuery, GatherNode, RpgEvent } from '../src/world/rpg/Rpg';
import { acceptWebSockets, type WSConn } from './ws';

/**
 * The authoritative world server (runs locally; no cloud). It owns the shared state: players and their sessions,
 * every region's changes, which finds have been taken, and the living world (the same LifeSim the browser runs,
 * here backed by regions generated around the players). Clients send their moves and edits; the server validates
 * them, steps the world at 10 Hz and sends each client a snapshot of what is near it about 5 times a second.
 * Sessions survive disconnects (resume with the token); the whole state is written to a JSON file and read back on
 * start, so a restart loses nothing.
 */

interface Session {
  id: string; token: string; name: string; conn: WSConn | null; lastSeen: number; lastMove: number;
  /** The player (kept while away; back in the world when they reconnect). */
  player: Player;
  /** Last character state sent, the last correction (ms), commands this second (flood limit). */
  heroSent: string; lastCorrect: number; cmds: number; cmdT: number;
}
const PERSONAL = new Set(['msg', 'xp', 'level', 'skill', 'quest']);
const NEAR = 120;

/** Exact terrain from regions generated around players; coarse (smooth ground, rivers, lakes) elsewhere. */
class GenQuery implements TerrainQuery, NodeQuery {
  private cache = new Map<string, RegionData>();
  /** Per region: cells blocked by solid objects, and bridge decks (walkable over water). */
  private masks = new Map<string, { solid: Uint8Array; deck: Uint8Array }>();
  private site;
  private ids: string[];
  constructor(private ct: ContinentTerrain, private bp: Blueprint) { this.site = ct.siteQuery(); this.ids = bp.data.regions.map((r) => r.id); }
  /** Generate the 3 x 3 regions around a point (once each; at most 64 kept). */
  ensureAround(x: number, y: number): void {
    const rx = Math.floor(x / 256), ry = Math.floor(y / 256);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = `${rx + dx},${ry + dy}`;
      if (this.cache.has(k)) { const r = this.cache.get(k)!; this.cache.delete(k); this.cache.set(k, r); continue; }
      const r = this.ct.generateRegion(rx + dx, ry + dy);
      this.cache.set(k, r);
      this.masks.set(k, masksOf(r));
      while (this.cache.size > 64) { const old = this.cache.keys().next().value as string; this.cache.delete(old); this.masks.delete(old); }
    }
  }
  private cell(x: number, y: number): { r: RegionData; i: number } | null {
    const r = this.cache.get(`${Math.floor(x / 256)},${Math.floor(y / 256)}`);
    return r ? { r, i: (Math.floor(y) - r.oy) * 256 + (Math.floor(x) - r.ox) } : null;
  }
  detailed(x: number, y: number): boolean { return !!this.cell(x, y); }
  height(x: number, y: number): number { const c = this.cell(x, y); return c ? c.r.elev[c.i] : this.site.z(x, y); }
  water(x: number, y: number): boolean { const c = this.cell(x, y); return c ? c.r.waterKind[c.i] !== WK_NONE : this.site.wet(x, y, 0); }
  /** Land or a bridge deck; not inside a building or rock; not a cliff (as the browser's window query decides). */
  walkable(x: number, y: number): boolean {
    const c = this.cell(x, y);
    if (!c) return !this.site.wet(x, y, 0);
    const m = this.masks.get(`${c.r.rx},${c.r.ry}`)!;
    if (m.deck[c.i]) return true;
    if (m.solid[c.i] || c.r.waterKind[c.i] !== WK_NONE) return false;
    const lx = c.i % 256, ly = Math.floor(c.i / 256), e = c.r.elev;
    if (lx < 1 || ly < 1 || lx > 254 || ly > 254) return true;
    return Math.abs(e[c.i + 1] - e[c.i - 1]) + Math.abs(e[c.i + 256] - e[c.i - 256]) < 3.2;
  }
  /** A generated object at a node id (`kind:x,y`): trees, rocks, mushrooms, finds. */
  node(id: string): GatherNode | null {
    const m = /^([a-z]+):(-?\d+),(-?\d+)$/.exec(id);
    if (!m) return null;
    const x = +m[2], y = +m[3], r = this.cache.get(`${Math.floor(x / 256)},${Math.floor(y / 256)}`);
    if (!r) return null;
    for (const o of r.objects) if (o.x + r.ox === x && o.y + r.oy === y && (o.kind === m[1] || (o.kind === 'cache' && o.variant === m[1]))) return { kind: o.kind, variant: o.variant, x, y };
    return null;
  }
  biome(x: number, y: number): string { const c = this.cell(x, y); return c ? this.ids[c.r.biome[c.i]] ?? 'sea' : regionAt(this.bp, x / 100, y / 100); }
}

/** Solid and deck cells of a generated region, from its objects' footprints. */
function masksOf(r: RegionData): { solid: Uint8Array; deck: Uint8Array } {
  const solid = new Uint8Array(256 * 256), deck = new Uint8Array(256 * 256);
  for (const o of r.objects) {
    const def = OBJECT_DEFS[o.kind as keyof typeof OBJECT_DEFS];
    if (!def || (!def.solid && o.kind !== 'span')) continue;
    const wo = { id: 0, kind: o.kind, x: o.x, y: o.y, variant: o.variant, props: { ...def.defaults, ...(o.props ?? {}) } } as Parameters<typeof def.footprint>[0];
    for (const [dx, dy] of def.footprint(wo)) {
      const x = o.x + dx, y = o.y + dy;
      if (x < 0 || y < 0 || x >= 256 || y >= 256) continue;
      (o.kind === 'span' ? deck : solid)[y * 256 + x] = 1;
    }
  }
  return { solid, deck };
}

export interface ServerOptions { port?: number; dataFile?: string | null; saveEverySec?: number; dayLength?: number; log?: (s: string) => void }

export class WorldServer {
  readonly bp: Blueprint;
  readonly terrain: ContinentTerrain;
  readonly q: GenQuery;
  readonly sim: LifeSim;
  readonly sessions = new Map<string, Session>();
  readonly edits = new Map<string, RegionEditJSON>();
  readonly stats = { tickMs: 0, maxTickMs: 0, ticks: 0, snaps: 0, clients: 0, bytesOut: 0, rejectedMoves: 0, commands: 0, events: 0 };
  /** Finds taken (the rules' set), and how many of them have been announced. */
  get taken(): Set<string> { return this.sim.rpg.taken; }
  private takenSent = 0;
  hour = 9;
  private http: Server | null = null;
  private timers: NodeJS.Timeout[] = [];
  private n = 0;
  private log: (s: string) => void;

  constructor(private opts: ServerOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.bp = buildBlueprint(WORLD);
    this.terrain = new ContinentTerrain(this.bp);
    this.q = new GenQuery(this.terrain, this.bp);
    this.sim = new LifeSim(this.bp, this.terrain, this.q);
    this.sim.rpg.authoritative = true;
    this.sim.rpg.nodes = this.q;
    this.sim.start(null);
    if (opts.dataFile && existsSync(opts.dataFile)) this.load(opts.dataFile);
  }

  /** Listen (port 0 = any free port). Resolves with the port. */
  listen(): Promise<number> {
    const http = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`Lumenwild world server: ${this.stats.clients} clients\n`); });
    this.http = http;
    acceptWebSockets(http, (c) => this.connect(c));
    this.timers.push(setInterval(() => this.tick(0.1), 100));
    this.timers.push(setInterval(() => this.snapshots(), 200));
    if (this.opts.dataFile) this.timers.push(setInterval(() => this.save(), (this.opts.saveEverySec ?? 30) * 1000));
    return new Promise((res) => http.listen(this.opts.port ?? 8787, () => res((http.address() as { port: number }).port)));
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const s of this.sessions.values()) s.conn?.close();
    if (this.opts.dataFile) this.save();
    await new Promise<void>((res) => (this.http ? this.http.close(() => res()) : res()));
  }

  private send(c: WSConn | null, m: ServerMsg): void { if (c?.open) { const t = JSON.stringify(m); this.stats.bytesOut += t.length; c.send(t); } }
  private broadcast(m: ServerMsg, except?: string): void { for (const s of this.sessions.values()) if (s.id !== except) this.send(s.conn, m); }

  private connect(c: WSConn): void {
    let me: Session | null = null;
    c.onmessage = (text) => {
      let m: ClientMsg;
      try { m = JSON.parse(text) as ClientMsg; } catch { return; }
      if (m.type === 'hello') {
        if (m.v !== undefined && m.v !== PROTOCOL) { this.send(c, { type: 'error', reason: `This server speaks protocol ${PROTOCOL}; your game speaks ${m.v}. Reload the page.` }); c.close(); return; }
        me = this.hello(c, m.name, m.token); return;
      }
      if (!me) return;
      me.lastSeen = Date.now();
      const p = this.sim.players.get(me.id);
      switch (m.type) {
        case 'move': if (p) this.move(me, p, m.x, m.y, m.h, m.run); break;
        case 'edit': if (typeof m.key === 'string' && /^-?\d+,-?\d+$/.test(m.key)) { if (m.edit) this.edits.set(m.key, m.edit); else this.edits.delete(m.key); this.broadcast({ type: 'edit', key: m.key, edit: m.edit, by: me.id }, me.id); } break;
        case 'cmd': {
          if (!p || !m.cmd) break;
          const now = Date.now();
          if (now - me.cmdT > 1000) { me.cmdT = now; me.cmds = 0; }
          if (++me.cmds > 30) break; // flood limit
          this.stats.commands++;
          this.sim.rpg.command(me.id, m.cmd);
          this.flushEvents();
          break;
        }
        case 'ping': this.send(c, { type: 'pong', t: m.t }); break;
      }
    };
    c.onclose = () => {
      if (!me) return;
      me.conn = null; me.lastSeen = Date.now();
      this.stats.clients = [...this.sessions.values()].filter((s) => s.conn).length;
      this.broadcast({ type: 'left', id: me.id, name: me.name });
      this.log(`${me.name} (${me.id}) disconnected`);
    };
  }

  /** Join or resume. A known token resumes the same player (position, character); otherwise a new player at Lumenfall. */
  private hello(c: WSConn, name: string, token?: string): Session {
    let s = token ? [...this.sessions.values()].find((q) => q.token === token) : undefined;
    if (s) { s.conn?.close(); s.conn = c; }
    else {
      const id = `p${++this.n}-${randomUUID().slice(0, 6)}`;
      // New players start on Lumenfall's square (open, paved ground), a step apart.
      const sq = this.terrain.village(this.bp.data.settlements[0].id)!.square, k = this.sessions.size + 1;
      const player = this.sim.addPlayer(id, String(name || 'Traveller').slice(0, 24), sq.x + ((k % 5) - 2) * 2, sq.y + Math.floor(k / 5) * 2);
      s = { id, token: randomUUID(), name: player.name, conn: c, lastSeen: Date.now(), lastMove: Date.now(), player, heroSent: '', lastCorrect: 0, cmds: 0, cmdT: 0 };
      this.sessions.set(id, s);
    }
    const p = s.player;
    if (!this.sim.players.has(s.id)) this.sim.players.set(s.id, p);
    s.lastMove = Date.now(); s.heroSent = '';
    this.q.ensureAround(p.x, p.y);
    this.stats.clients = [...this.sessions.values()].filter((q) => q.conn).length;
    this.send(c, { type: 'welcome', id: s.id, token: s.token, x: p.x, y: p.y, hero: heroToJSON(p.hero), edits: Object.fromEntries(this.edits), taken: [...this.taken], hour: this.hour, t: this.sim.clock.t, v: PROTOCOL });
    this.broadcast({ type: 'joined', id: s.id, name: s.name }, s.id);
    this.log(`${s.name} (${s.id}) ${token && s.token === token ? 'resumed' : 'joined'}`);
    return s;
  }

  /**
   * Accept a move if it is possible: no faster than running (a dodge roll a little faster), not while down, and not
   * into a wall, a rock or water (checked at the destination and halfway). Otherwise the client is corrected.
   */
  private move(s: Session, p: Player, x: number, y: number, h: number, run: boolean): void {
    if (![x, y, h].every(Number.isFinite)) return;
    const now = Date.now(), dt = Math.max(0.05, (now - s.lastMove) / 1000), d = Math.hypot(x - p.x, y - p.y);
    s.lastMove = now;
    const speed = this.sim.clock.t < p.hero.dodgeUntil + 0.3 ? 14 : RUN;
    const blocked = d > 0.3 && this.q.detailed(x, y) && (!this.q.walkable(x, y) || !this.q.walkable((x + p.x) / 2, (y + p.y) / 2));
    if (p.hero.dead >= 0 || d > speed * 1.6 * dt + 2 || blocked) {
      this.stats.rejectedMoves++;
      if (d > 0.05 && now - s.lastCorrect > 300) { s.lastCorrect = now; this.send(s.conn, { type: 'correct', x: p.x, y: p.y }); }
      return;
    }
    p.walked += d; p.x = x; p.y = y; p.h = h; p.running = !!run; p.v = d / dt;
  }

  /** Send rules events: each player gets its own (messages, xp, quests) and what happens within 120 m of it. */
  flushEvents(): void {
    const evs = this.sim.rpg.drain();
    if (evs.length) {
      this.stats.events += evs.length;
      const per = new Map<string, RpgEvent[]>();
      for (const ev of evs) {
        const actor = this.sim.players.get(ev.who);
        const at = 'x' in ev ? ev : actor;
        for (const s of this.sessions.values()) {
          if (!s.conn) continue;
          const mine = ev.who === s.id;
          if (PERSONAL.has(ev.e) ? !mine : !(mine || (at && Math.hypot(at.x - s.player.x, at.y - s.player.y) < NEAR))) continue;
          let list = per.get(s.id);
          if (!list) { list = []; per.set(s.id, list); }
          list.push(ev);
        }
        if (ev.e === 'respawn') { const s = this.sessions.get(ev.who); if (s) { this.q.ensureAround(ev.x, ev.y); this.send(s.conn, { type: 'correct', x: ev.x, y: ev.y }); } }
      }
      for (const [id, list] of per) this.send(this.sessions.get(id)!.conn, { type: 'ev', evs: list });
    }
    // Finds taken since the last announcement.
    if (this.taken.size > this.takenSent) {
      const ids = [...this.taken].slice(this.takenSent);
      this.takenSent = this.taken.size;
      this.broadcast({ type: 'taken', ids });
    }
  }

  /** Step the living world (players who left more than a minute ago stop counting as present). */
  tick(dt: number): void {
    const t0 = performance.now();
    this.hour = (this.hour + (dt * 24) / (this.opts.dayLength ?? 480)) % 24;
    const now = Date.now();
    for (const s of this.sessions.values()) {
      // Away for a minute: out of the world (kept in the session; back when they reconnect).
      if (!s.conn && now - s.lastSeen > 60_000 && this.sim.players.has(s.id)) this.sim.players.delete(s.id);
      if (s.conn && !this.sim.players.has(s.id)) this.sim.players.set(s.id, s.player);
    }
    if (this.stats.ticks % 10 === 0) for (const p of this.sim.players.values()) this.q.ensureAround(p.x, p.y);
    this.sim.update(dt, { hour: this.hour, rain: 0 });
    this.flushEvents();
    this.stats.ticks++;
    this.stats.tickMs = performance.now() - t0;
    this.stats.maxTickMs = Math.max(this.stats.maxTickMs, this.stats.tickMs);
  }

  /** What each connected player sees near them. */
  snapshots(): void {
    const t = this.sim.clock.t, players: SnapPlayer[] = [...this.sim.players.values()].map((p) => [p.id, p.name, round(p.x), round(p.y), +p.h.toFixed(2), p.running ? 1 : 0, +(Math.max(0, p.hero.hp) / maxHp(p.hero)).toFixed(2), p.hero.dead >= 0 ? 1 : 0]);
    const dragons: SnapDragon[] = this.sim.dragons.dragons.map((d) => [d.id, d.name, round(d.x), round(d.y), Math.round(d.alt), +d.h.toFixed(2), d.st]);
    for (const s of this.sessions.values()) {
      if (!s.conn) continue;
      const p = this.sim.players.get(s.id);
      if (!p) continue;
      const creatures: SnapCreature[] = [], villagers: SnapVillager[] = [], loot: SnapLoot[] = [];
      for (const c of this.sim.wildlife.creatures.values()) if (Math.hypot(c.x - p.x, c.y - p.y) < 600 && (c.alive || c.st !== 'dead')) creatures.push([c.id, c.sp, round(c.x), round(c.y), +c.alt.toFixed(1), +c.h.toFixed(2), c.st, c.alive ? 1 : 0, +(c.hp / CREATURE_COMBAT[c.sp].hp).toFixed(2), c.foe ? 1 : 0]);
      for (const v of this.sim.villages.people.values()) if (Math.hypot(v.x - p.x, v.y - p.y) < 400) villagers.push([v.id, round(v.x), round(v.y), +v.h.toFixed(2), v.st, v.act, v.out ? 1 : 0]);
      for (const g of this.sim.rpg.loot.values()) if (Math.hypot(g.x - p.x, g.y - p.y) < NEAR) loot.push([g.id, round(g.x), round(g.y), g.label]);
      this.send(s.conn, { type: 'snap', t, hour: +this.hour.toFixed(3), me: [Math.round(p.hero.hp * 10) / 10, +p.stamina.toFixed(3), p.hero.dead >= 0 ? 1 : 0], players, dragons, creatures, villagers, loot });
      // The character, when it changed.
      const view = this.sim.rpg.viewFor(s.id), hero = heroToJSON(p.hero), key = JSON.stringify([hero, view]);
      if (key !== s.heroSent) { s.heroSent = key; this.send(s.conn, { type: 'hero', hero, view }); }
      this.stats.snaps++;
    }
  }

  // ------------------------------------------------------------------ persistence (local JSON file)
  save(file = this.opts.dataFile): void {
    if (!file) return;
    const data = {
      version: 2, hour: this.hour, n: this.n,
      sessions: [...this.sessions.values()].map((s) => ({ id: s.id, token: s.token, name: s.name })),
      players: [...this.sessions.values()].map((s) => ({ id: s.id, x: s.player.x, y: s.player.y, walked: s.player.walked, hero: heroToJSON(s.player.hero) })),
      edits: Object.fromEntries(this.edits), life: this.sim.toJSON(),
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(data));
    renameSync(file + '.tmp', file);
  }

  private load(file: string): void {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      this.hour = typeof d.hour === 'number' ? d.hour : this.hour;
      this.n = d.n ?? 0;
      const saved = new Map<string, { x: number; y: number; walked?: number; hero?: unknown; inv?: Record<string, unknown> }>((d.players ?? []).map((p: { id: string }) => [p.id, p]));
      for (const s of d.sessions ?? []) {
        const sp = saved.get(s.id), player = this.sim.addPlayer(s.id, s.name, sp?.x ?? 50000, sp?.y ?? 51000);
        this.sim.players.delete(s.id); // in the world again when they reconnect
        if (sp?.hero) heroFromJSON(sp.hero, player.hero); else if (sp?.inv) this.sim.legacyPack(player, sp.inv);
        player.walked = sp?.walked ?? 0;
        this.sessions.set(s.id, { id: s.id, token: s.token, name: s.name, conn: null, lastSeen: Date.now() - 120_000, lastMove: Date.now(), player, heroSent: '', lastCorrect: 0, cmds: 0, cmdT: 0 });
      }
      for (const [k, v] of Object.entries(d.edits ?? {})) this.edits.set(k, v as RegionEditJSON);
      if (d.life) { const live = this.sim.players; const keep = new Map(live); live.clear(); this.sim.load(d.life); for (const [k, v] of keep) live.set(k, v); }
      for (const t of d.taken ?? []) this.taken.add(t); // version 1 files
      this.takenSent = this.taken.size;
      this.log(`Loaded ${this.sessions.size} sessions, ${this.edits.size} edited regions, ${this.taken.size} taken finds from ${file}`);
    } catch (e) { this.log(`Could not read ${file}: ${(e as Error).message}`); }
  }
}

const round = (v: number) => Math.round(v * 10) / 10;
