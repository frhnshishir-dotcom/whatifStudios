import type { LivingWorld } from '../life/client';
import type { Creature, Species, CState } from '../life/wildlife';
import type { DState } from '../life/dragons';
import { ContinentEdits, editToJSON } from '../edits';
import { heroFromJSON } from '../rpg/hero';
import { CREATURE_COMBAT } from '../rpg/content';
import type { RpgCmd, RpgView, GroundLoot } from '../rpg/Rpg';
import { PROTOCOL, type ClientMsg, type ServerMsg } from './protocol';

/**
 * Online play: the browser joins a world server (`?server=ws://host:port`). The server simulates the living world
 * and applies the RPG rules; this client sends the traveller's moves, region edits and commands (attack, gather,
 * craft, buy, trade...), and draws what the server says: other players, dragons, creatures, villagers, loot, and its
 * own character. Everything the server moves is interpolated between snapshots (5 per second) so it glides.
 * A token kept in the browser resumes the same player after a reload or a dropped connection (it reconnects by itself).
 */

interface Lerp { fx: number; fy: number; tx: number; ty: number; fa: number; ta: number; t0: number }
const SNAP_DT = 0.2;

export class NetClient {
  ws: WebSocket | null = null;
  id = '';
  connected = false;
  readonly stats = { snaps: 0, sent: 0, lastSnapT: 0, players: 0, reconnects: 0, villagers: 0, corrections: 0, events: 0, heroSyncs: 0, bytesIn: 0 };
  message = '';
  view: RpgView = { offer: null, shop: null, stock: [], offers: [] };
  private lastSent = new Map<string, string>();
  private lerp = new Map<string, Lerp>();
  private moveT = 0;
  private editT = 0;
  private popT = 1e9;
  private closedByUs = false;
  /** After joining: if the server's spot is blocked here (a building, water), step to the nearest open ground. */
  private unstick = false;

  constructor(private lw: LivingWorld, readonly url: string, private name = 'Traveller') { this.open(); }

  private tokenKey(): string { return `lumenwild:token:${this.url}`; }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      let token: string | undefined;
      try { token = localStorage.getItem(this.tokenKey()) ?? undefined; } catch { /* private mode */ }
      this.send({ type: 'hello', name: this.name, token, v: PROTOCOL });
    };
    ws.onmessage = (e) => { const text = String(e.data); this.stats.bytesIn += text.length; try { this.receive(JSON.parse(text) as ServerMsg); } catch { /* ignore malformed */ } };
    ws.onclose = () => {
      this.connected = false;
      if (this.closedByUs) return;
      this.message = 'Connection lost; reconnecting…';
      this.stats.reconnects++;
      setTimeout(() => this.open(), 1500);
    };
  }

  close(): void { this.closedByUs = true; this.ws?.close(); }

  send(m: ClientMsg): void { if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify(m)); this.stats.sent++; } }

  /** An RPG command for the server to decide. */
  cmd(c: RpgCmd): void { this.send({ type: 'cmd', cmd: c }); }

  private receive(m: ServerMsg): void {
    const lw = this.lw, s = lw.session, e = lw.engine, p = lw.player;
    switch (m.type) {
      case 'welcome': {
        this.id = m.id; this.connected = true; this.message = `Online as ${this.name}`;
        try { localStorage.setItem(this.tokenKey(), m.token); } catch { /* private mode */ }
        p.x = m.x; p.y = m.y;
        heroFromJSON(m.hero, p.hero);
        lw.sim.clock.t = m.t;
        this.unstick = true;
        lw.sim.rpg.taken.clear();
        for (const id of m.taken) lw.sim.rpg.taken.add(id);
        // The shared world's changes, then the window rebuilt around the traveller.
        const edits = ContinentEdits.fromJSON(m.edits, s.win.S * s.win.S);
        for (const [k, v] of edits.regions) this.lastSent.set(k, JSON.stringify(editToJSON(v)));
        s.loadAt(e, s.bp.coords.cellToMap([p.x, p.y]), edits);
        lw.sweepFinds();
        break;
      }
      case 'snap': this.applySnap(m); break;
      case 'hero': heroFromJSON(m.hero, p.hero); this.view = m.view; this.stats.heroSyncs++; break;
      case 'ev': this.stats.events += m.evs.length; lw.sim.rpg.events.push(...m.evs); break;
      case 'correct': p.x = m.x; p.y = m.y; this.stats.corrections++; if (!lw.q.detailed(p.x, p.y)) s.loadAt(e, s.bp.coords.cellToMap([p.x, p.y])); break;
      case 'taken': for (const id of m.ids) lw.sim.rpg.taken.add(id); lw.sweepFinds(); break;
      case 'edit': {
        // Another player's changes: merged into ours; if that region is loaded, the window is rebuilt with it.
        const cur = s.collectEdits(e), one = ContinentEdits.fromJSON(m.edit ? { [m.key]: m.edit } : {}, s.win.S * s.win.S);
        const [rx, ry] = m.key.split(',').map(Number);
        cur.set(rx, ry, one.get(rx, ry) ?? null);
        this.lastSent.set(m.key, m.edit ? JSON.stringify(m.edit) : '');
        const [ox, oy] = s.win.origin;
        if (rx >= ox && ry >= oy && rx < ox + 3 && ry < oy + 3) s.loadAt(e, s.bp.coords.cellToMap([p.x, p.y]), cur);
        else s.edits = cur;
        break;
      }
      case 'joined': lw.sim.note(`${m.name} joined the world.`); break;
      case 'left': lw.sim.note(`${m.name} left.`); lw.sim.players.delete(m.id); break;
      case 'error': this.message = m.reason; lw.message = m.reason; this.closedByUs = true; break;
      case 'rejected':
        // Not applied on the server: say why, and stop re-sending that region until it changes again.
        lw.message = `Not saved to the shared world: ${m.reason}.`;
        if (m.what === 'edit') { const all = s.collectEdits(e), [rx, ry] = m.key.split(',').map(Number), ed = all.get(rx, ry); this.lastSent.set(m.key, ed ? JSON.stringify(editToJSON(ed)) : ''); }
        break;
      case 'pong': break;
    }
  }

  /** Glide toward the latest position over one snapshot interval. */
  private target(id: string, x: number, y: number, a: number, cx: number, cy: number, ca: number): void {
    const l = this.lerp.get(id), now = performance.now() / 1000;
    if (!l || Math.hypot(x - cx, y - cy) > 30) { this.lerp.set(id, { fx: x, fy: y, tx: x, ty: y, fa: a, ta: a, t0: now }); return; }
    l.fx = cx; l.fy = cy; l.fa = ca; l.tx = x; l.ty = y; l.ta = a; l.t0 = now;
  }

  private applySnap(m: Extract<ServerMsg, { type: 'snap' }>): void {
    const lw = this.lw, sim = lw.sim, q = lw.q, p = lw.player;
    this.stats.snaps++; this.stats.lastSnapT = m.t;
    lw.engine.env.time = m.hour;
    if (Math.abs(sim.clock.t - m.t) > 0.5) sim.clock.t = m.t;
    // Our own health, stamina and whether we are down: the server's word.
    const [hp, st, down] = m.me;
    p.hero.hp = hp; p.stamina = st;
    if (down && p.hero.dead < 0) p.hero.dead = sim.clock.t;
    if (!down) p.hero.dead = -1;
    p.alive = !down;
    // Other players.
    const seen = new Set<string>(['local']);
    for (const [id, name, x, y, h, run, frac, dn] of m.players) {
      if (id === this.id) continue;
      seen.add(id);
      const o = sim.players.get(id) ?? sim.addPlayer(id, name, x, y);
      this.target(`p:${id}`, x, y, h, o.x, o.y, o.h);
      o.running = run === 1; o.hpFrac = frac; o.alive = dn !== 1;
    }
    for (const id of [...sim.players.keys()]) if (!seen.has(id)) { sim.players.delete(id); this.lerp.delete(`p:${id}`); }
    this.stats.players = sim.players.size;
    // Dragons: the server's.
    for (const [id, , x, y, alt, h, st2] of m.dragons) {
      const d = sim.dragons.dragons.find((q2) => q2.id === id);
      if (!d) continue;
      this.target(`d:${id}`, x, y, h, d.x, d.y, d.h);
      d.alt = alt; d.st = st2 as DState; d.v = 20;
    }
    // Creatures near us: exactly the server's set.
    const wl = sim.wildlife.creatures, keep = new Set<string>();
    for (const [id, sp, x, y, alt, h, st2, alive, frac, fight] of m.creatures) {
      keep.add(id);
      let c = wl.get(id);
      if (!c) {
        c = { id, kind: 'creature', sp: sp as Species, tag: sp as Species, x, y, alt, alive: alive === 1, h, st: st2 as CState, stT: 0, next: 1e12, tx: x, ty: y, target: null, hunger: 0, thirst: 0, energy: 1, stamina: 1, homeX: x, homeY: y, group: id, leader: true, male: id.length % 2 === 0, look: (id.charCodeAt(id.length - 1) % 10) / 10, alert: 0, diedAt: -1, tier: 0, water: null, hp: CREATURE_COMBAT[sp as Species].hp, foe: null, atkT: 0 } as Creature;
        wl.set(id, c);
      }
      this.target(`c:${id}`, x, y, h, c.x, c.y, c.h);
      c.alt = alt; c.st = st2 as CState; c.alive = alive === 1; c.tier = q.detailed(x, y) ? 0 : 1;
      c.hp = frac * CREATURE_COMBAT[c.sp].hp; c.foe = fight ? 'someone' : null;
      c.alert = st2 === 'flee' || st2 === 'charge' || st2 === 'fight' ? 1 : 0;
    }
    for (const id of [...wl.keys()]) if (!keep.has(id)) { wl.delete(id); this.lerp.delete(`c:${id}`); }
    // Villagers: the same people (generated the same way here), placed where the server has them.
    let placed = 0;
    for (const [id, x, y, h, st2, , out] of m.villagers) {
      const v = sim.villages.people.get(id);
      if (!v) continue;
      this.target(`v:${id}`, x, y, h, v.x, v.y, v.h);
      v.st = st2 as never; v.out = out === 1; placed++;
    }
    this.stats.villagers = placed;
    // Loot on the ground.
    const loot = sim.rpg.loot, ids = new Set<string>();
    for (const [id, x, y, label] of m.loot) { ids.add(id); if (!loot.has(id)) loot.set(id, { id, x, y, label, items: [], coins: 0, t: m.t, owner: null } as GroundLoot); }
    for (const id of [...loot.keys()]) if (!ids.has(id)) loot.delete(id);
  }

  /** Move everything the server moves a little closer to where it last said. */
  private glide(): void {
    const now = performance.now() / 1000, sim = this.lw.sim;
    for (const [k, l] of this.lerp) {
      const a = Math.min(1, (now - l.t0) / SNAP_DT), x = l.fx + (l.tx - l.fx) * a, y = l.fy + (l.ty - l.fy) * a;
      let da = l.ta - l.fa; da = Math.atan2(Math.sin(da), Math.cos(da));
      const h = l.fa + da * a, id = k.slice(2);
      const o = k[0] === 'p' ? sim.players.get(id) : k[0] === 'c' ? sim.wildlife.creatures.get(id) : k[0] === 'v' ? sim.villages.people.get(id) : sim.dragons.dragons.find((d) => d.id === id);
      if (!o) { this.lerp.delete(k); continue; }
      const moved = Math.hypot(x - o.x, y - o.y);
      o.x = x; o.y = y; o.h = h;
      if (k[0] === 'p') (o as { v: number }).v = moved * 60;
      if (k[0] === 'd') { const d = o as { z: number; alt: number }; d.z = this.lw.q.height(x, y) + d.alt; }
    }
  }

  /** Per frame: send the traveller's moves (10 per second) and region edits (every 3 s, when changed); interpolate. */
  frame(dt: number): void {
    this.lw.sim.clock.t += dt;
    this.glide();
    if (!this.connected) return;
    const p = this.lw.player;
    if (this.unstick && this.lw.q.detailed(p.x, p.y)) {
      this.unstick = false;
      if (!this.lw.q.walkable(p.x, p.y)) search: for (let r = 1; r < 30; r++) for (let k = 0; k < 16; k++) {
        const x = p.x + Math.cos((k / 16) * 6.28) * r, y = p.y + Math.sin((k / 16) * 6.28) * r;
        if (this.lw.q.walkable(x, y)) { p.x = x; p.y = y; break search; }
      }
    }
    this.moveT += dt; this.editT += dt; this.popT += dt;
    // The local roster of villagers near us (their positions come from the server's snapshots).
    if (this.popT >= 2) { this.popT = 0; this.lw.sim.populateVillages([p]); }
    if (this.moveT >= 0.1) { this.moveT = 0; this.send({ type: 'move', x: p.x, y: p.y, h: p.h, run: p.running }); }
    if (this.editT >= 3) {
      this.editT = 0;
      const s = this.lw.session, all = s.collectEdits(this.lw.engine), [ox, oy] = s.win.origin;
      for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++) {
        const key = `${ox + gx},${oy + gy}`, ed = all.get(ox + gx, oy + gy), json = ed ? JSON.stringify(editToJSON(ed)) : '';
        if ((this.lastSent.get(key) ?? '') === json) continue;
        this.lastSent.set(key, json);
        this.send({ type: 'edit', key, edit: ed ? editToJSON(ed) : null });
      }
    }
  }
}
