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
import type { ClientMsg, ServerMsg, SnapCreature, SnapDragon, SnapPlayer, SnapVillager } from '../src/world/net/protocol';
import { acceptWebSockets, type WSConn } from './ws';

/**
 * The authoritative world server (runs locally; no cloud). It owns the shared state: players and their sessions,
 * every region's changes, which finds have been taken, and the living world (the same LifeSim the browser runs,
 * here backed by regions generated around the players). Clients send their moves and edits; the server validates
 * them, steps the world at 10 Hz and sends each client a snapshot of what is near it about 5 times a second.
 * Sessions survive disconnects (resume with the token); the whole state is written to a JSON file and read back on
 * start, so a restart loses nothing.
 */

interface Session { id: string; token: string; name: string; conn: WSConn | null; lastSeen: number; lastMove: number }

/** Exact terrain from regions generated around players; coarse (smooth ground, rivers, lakes) elsewhere. */
class GenQuery implements TerrainQuery {
  private cache = new Map<string, RegionData>();
  private site;
  private ids: string[];
  constructor(private ct: ContinentTerrain, private bp: Blueprint) { this.site = ct.siteQuery(); this.ids = bp.data.regions.map((r) => r.id); }
  /** Generate the 3 x 3 regions around a point (once each; at most 64 kept). */
  ensureAround(x: number, y: number): void {
    const rx = Math.floor(x / 256), ry = Math.floor(y / 256);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = `${rx + dx},${ry + dy}`;
      if (this.cache.has(k)) { const r = this.cache.get(k)!; this.cache.delete(k); this.cache.set(k, r); continue; }
      this.cache.set(k, this.ct.generateRegion(rx + dx, ry + dy));
      while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value as string);
    }
  }
  private cell(x: number, y: number): { r: RegionData; i: number } | null {
    const r = this.cache.get(`${Math.floor(x / 256)},${Math.floor(y / 256)}`);
    return r ? { r, i: (Math.floor(y) - r.oy) * 256 + (Math.floor(x) - r.ox) } : null;
  }
  detailed(x: number, y: number): boolean { return !!this.cell(x, y); }
  height(x: number, y: number): number { const c = this.cell(x, y); return c ? c.r.elev[c.i] : this.site.z(x, y); }
  water(x: number, y: number): boolean { const c = this.cell(x, y); return c ? c.r.waterKind[c.i] !== WK_NONE : this.site.wet(x, y, 0); }
  walkable(x: number, y: number): boolean { return !this.water(x, y); }
  biome(x: number, y: number): string { const c = this.cell(x, y); return c ? this.ids[c.r.biome[c.i]] ?? 'sea' : regionAt(this.bp, x / 100, y / 100); }
}

export interface ServerOptions { port?: number; dataFile?: string | null; saveEverySec?: number; dayLength?: number; log?: (s: string) => void }

export class WorldServer {
  readonly bp: Blueprint;
  readonly terrain: ContinentTerrain;
  readonly q: GenQuery;
  readonly sim: LifeSim;
  readonly sessions = new Map<string, Session>();
  readonly edits = new Map<string, RegionEditJSON>();
  readonly taken = new Set<string>();
  readonly stats = { tickMs: 0, ticks: 0, snaps: 0, clients: 0 };
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

  private send(c: WSConn | null, m: ServerMsg): void { if (c?.open) c.send(JSON.stringify(m)); }
  private broadcast(m: ServerMsg, except?: string): void { for (const s of this.sessions.values()) if (s.id !== except) this.send(s.conn, m); }

  private connect(c: WSConn): void {
    let me: Session | null = null;
    c.onmessage = (text) => {
      let m: ClientMsg;
      try { m = JSON.parse(text) as ClientMsg; } catch { return; }
      if (m.type === 'hello') { me = this.hello(c, m.name, m.token); return; }
      if (!me) return;
      me.lastSeen = Date.now();
      const p = this.sim.players.get(me.id);
      switch (m.type) {
        case 'move': if (p) this.move(me, p, m.x, m.y, m.h, m.run); break;
        case 'edit': if (typeof m.key === 'string' && /^-?\d+,-?\d+$/.test(m.key)) { if (m.edit) this.edits.set(m.key, m.edit); else this.edits.delete(m.key); this.broadcast({ type: 'edit', key: m.key, edit: m.edit, by: me.id }, me.id); } break;
        case 'take': if (p) this.take(me, p, String(m.id)); break;
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

  /** Join or resume. A known token resumes the same player (position, pack); otherwise a new player at Lumenfall. */
  private hello(c: WSConn, name: string, token?: string): Session {
    let s = token ? [...this.sessions.values()].find((q) => q.token === token) : undefined;
    if (s) { s.conn?.close(); s.conn = c; }
    else {
      const id = `p${++this.n}-${randomUUID().slice(0, 6)}`;
      s = { id, token: randomUUID(), name: String(name || 'Traveller').slice(0, 24), conn: c, lastSeen: Date.now(), lastMove: Date.now() };
      this.sessions.set(id, s);
      // New players start on Lumenfall's square (open, paved ground), a step apart.
      const sq = this.terrain.village(this.bp.data.settlements[0].id)!.square, k = this.sessions.size;
      this.sim.addPlayer(id, s.name, sq.x + ((k % 5) - 2) * 2, sq.y + Math.floor(k / 5) * 2);
    }
    const p = this.sim.players.get(s.id) ?? this.sim.addPlayer(s.id, s.name, this.bp.data.settlements[0].at[0] * 100, this.bp.data.settlements[0].at[1] * 100);
    s.lastMove = Date.now();
    this.q.ensureAround(p.x, p.y);
    this.stats.clients = [...this.sessions.values()].filter((q) => q.conn).length;
    this.send(c, { type: 'welcome', id: s.id, token: s.token, x: p.x, y: p.y, inv: p.inv, edits: Object.fromEntries(this.edits), taken: [...this.taken], hour: this.hour });
    this.broadcast({ type: 'joined', id: s.id, name: s.name }, s.id);
    this.log(`${s.name} (${s.id}) ${token && s.token === token ? 'resumed' : 'joined'}`);
    return s;
  }

  /** Accept a move if it is possible at running speed (with slack for network jitter); otherwise keep the old spot. */
  private move(s: Session, p: Player, x: number, y: number, h: number, run: boolean): void {
    if (![x, y, h].every(Number.isFinite)) return;
    const now = Date.now(), dt = Math.max(0.05, (now - s.lastMove) / 1000), d = Math.hypot(x - p.x, y - p.y);
    s.lastMove = now;
    if (d > RUN * 1.6 * dt + 2) return; // too fast: ignored (the client snaps back from the next snapshot)
    p.walked += d; p.x = x; p.y = y; p.h = h; p.running = !!run; p.v = d / dt;
  }

  /** Take a find: the first player to ask gets it; it stays taken for everyone. */
  private take(s: Session, p: Player, id: string): void {
    const m = /^(chest|herbs|ore|relic):(-?\d+),(-?\d+)$/.exec(id);
    if (!m) return this.send(s.conn, { type: 'denied', id, reason: 'unknown find' });
    if (this.taken.has(id)) return this.send(s.conn, { type: 'denied', id, reason: 'already taken' });
    if (Math.hypot(+m[2] - p.x, +m[3] - p.y) > 6) return this.send(s.conn, { type: 'denied', id, reason: 'too far away' });
    this.taken.add(id);
    const item = m[1] === 'chest' ? 'coins' : m[1] === 'relic' ? 'relics' : m[1], n = m[1] === 'chest' ? 25 : 1;
    p.inv[item] = (p.inv[item] ?? 0) + n;
    this.send(s.conn, { type: 'took', id, item, n, inv: p.inv });
  }

  /** Step the living world (players who left more than a minute ago stop counting as present). */
  tick(dt: number): void {
    const t0 = performance.now();
    this.hour = (this.hour + (dt * 24) / (this.opts.dayLength ?? 480)) % 24;
    const now = Date.now();
    for (const s of this.sessions.values()) {
      const p = this.sim.players.get(s.id);
      if (!s.conn && now - s.lastSeen > 60_000 && p) this.sim.players.delete(s.id);
      if (s.conn && !p) this.sim.addPlayer(s.id, s.name, 50000, 51000);
    }
    if (this.stats.ticks % 10 === 0) for (const p of this.sim.players.values()) this.q.ensureAround(p.x, p.y);
    this.sim.update(dt, { hour: this.hour, rain: 0 });
    this.stats.ticks++;
    this.stats.tickMs = performance.now() - t0;
  }

  /** What each connected player sees near them. */
  snapshots(): void {
    const t = this.sim.clock.t, players: SnapPlayer[] = [...this.sim.players.values()].map((p) => [p.id, p.name, round(p.x), round(p.y), +p.h.toFixed(2), p.running ? 1 : 0]);
    const dragons: SnapDragon[] = this.sim.dragons.dragons.map((d) => [d.id, d.name, round(d.x), round(d.y), Math.round(d.alt), +d.h.toFixed(2), d.st]);
    for (const s of this.sessions.values()) {
      if (!s.conn) continue;
      const p = this.sim.players.get(s.id);
      if (!p) continue;
      const creatures: SnapCreature[] = [], villagers: SnapVillager[] = [];
      for (const c of this.sim.wildlife.creatures.values()) if (Math.hypot(c.x - p.x, c.y - p.y) < 600 && (c.alive || c.st !== 'dead')) creatures.push([c.id, c.sp, round(c.x), round(c.y), +c.alt.toFixed(1), +c.h.toFixed(2), c.st, c.alive ? 1 : 0]);
      for (const v of this.sim.villages.people.values()) if (Math.hypot(v.x - p.x, v.y - p.y) < 400) villagers.push([v.id, round(v.x), round(v.y), +v.h.toFixed(2), v.st, v.act, v.out ? 1 : 0]);
      this.send(s.conn, { type: 'snap', t, hour: +this.hour.toFixed(3), players, dragons, creatures, villagers });
      this.stats.snaps++;
    }
  }

  // ------------------------------------------------------------------ persistence (local JSON file)
  save(file = this.opts.dataFile): void {
    if (!file) return;
    const data = {
      version: 1, hour: this.hour, n: this.n,
      sessions: [...this.sessions.values()].map((s) => ({ id: s.id, token: s.token, name: s.name })),
      players: [...this.sessions.values()].map((s) => { const p = this.sim.players.get(s.id) ?? this.parked.get(s.id); return p ? { id: s.id, x: p.x, y: p.y, inv: p.inv, walked: p.walked } : null; }).filter(Boolean),
      edits: Object.fromEntries(this.edits), taken: [...this.taken], life: this.sim.toJSON(),
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(data));
    renameSync(file + '.tmp', file);
  }

  /** Players of sessions that were saved while away (restored into the world when they reconnect). */
  private parked = new Map<string, Player>();

  private load(file: string): void {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      this.hour = typeof d.hour === 'number' ? d.hour : this.hour;
      this.n = d.n ?? 0;
      for (const s of d.sessions ?? []) this.sessions.set(s.id, { id: s.id, token: s.token, name: s.name, conn: null, lastSeen: Date.now(), lastMove: Date.now() });
      for (const p of d.players ?? []) { const pl = this.sim.addPlayer(p.id, this.sessions.get(p.id)?.name ?? 'Traveller', p.x, p.y); pl.inv = p.inv ?? {}; pl.walked = p.walked ?? 0; }
      for (const [k, v] of Object.entries(d.edits ?? {})) this.edits.set(k, v as RegionEditJSON);
      for (const t of d.taken ?? []) this.taken.add(t);
      if (d.life) this.sim.load(d.life);
      this.log(`Loaded ${this.sessions.size} sessions, ${this.edits.size} edited regions, ${this.taken.size} taken finds from ${file}`);
    } catch (e) { this.log(`Could not read ${file}: ${(e as Error).message}`); }
  }
}

const round = (v: number) => Math.round(v * 10) / 10;
