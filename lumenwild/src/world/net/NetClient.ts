import type { LivingWorld } from '../life/client';
import type { Creature, Species, CState } from '../life/wildlife';
import type { DState } from '../life/dragons';
import { ContinentEdits, editToJSON } from '../edits';
import { findId, type ClientMsg, type ServerMsg } from './protocol';

/**
 * Online play: the browser joins a world server (`?server=ws://host:port`). The server simulates the living world;
 * this client sends the traveller's moves, region edits and requests to take finds, and draws what the server's
 * snapshots say: other players, dragons, creatures and villagers. A token kept in the browser resumes the same player
 * after a reload or a dropped connection (it reconnects by itself).
 */
export class NetClient {
  ws: WebSocket | null = null;
  id = '';
  connected = false;
  readonly stats = { snaps: 0, sent: 0, lastSnapT: 0, players: 0, reconnects: 0, villagers: 0 };
  message = '';
  private taken = new Set<string>();
  private lastSent = new Map<string, string>();
  private moveT = 0;
  private editT = 0;
  private sweepT = 0;
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
      this.send({ type: 'hello', name: this.name, token });
    };
    ws.onmessage = (e) => { try { this.receive(JSON.parse(String(e.data)) as ServerMsg); } catch { /* ignore malformed */ } };
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

  private receive(m: ServerMsg): void {
    const lw = this.lw, s = lw.session, e = lw.engine, p = lw.player;
    switch (m.type) {
      case 'welcome': {
        this.id = m.id; this.connected = true; this.message = `Online as ${this.name}`;
        try { localStorage.setItem(this.tokenKey(), m.token); } catch { /* private mode */ }
        p.x = m.x; p.y = m.y; p.inv = { ...m.inv };
        this.unstick = true;
        this.taken = new Set(m.taken);
        // The shared world's changes, then the window rebuilt around the traveller.
        const edits = ContinentEdits.fromJSON(m.edits, s.win.S * s.win.S);
        for (const [k, v] of edits.regions) this.lastSent.set(k, JSON.stringify(editToJSON(v)));
        s.loadAt(e, s.bp.coords.cellToMap([p.x, p.y]), edits);
        this.sweepTaken();
        break;
      }
      case 'snap': this.applySnap(m); break;
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
      case 'took': p.inv = { ...m.inv }; this.taken.add(m.id); lw.message = `Took ${m.n} ${m.item}.`; break;
      case 'denied': this.taken.add(m.id); lw.message = `Someone got there first (${m.reason}).`; this.sweepTaken(); break;
      case 'joined': lw.sim.note(`${m.name} joined the world.`); break;
      case 'left': lw.sim.note(`${m.name} left.`); lw.sim.players.delete(m.id); break;
      case 'pong': break;
    }
  }

  private applySnap(m: Extract<ServerMsg, { type: 'snap' }>): void {
    const sim = this.lw.sim, q = this.lw.q;
    this.stats.snaps++; this.stats.lastSnapT = m.t;
    this.lw.engine.env.time = m.hour;
    // Other players.
    const seen = new Set<string>(['local']);
    for (const [id, name, x, y, h, run] of m.players) {
      if (id === this.id) continue;
      seen.add(id);
      const o = sim.players.get(id) ?? sim.addPlayer(id, name, x, y);
      o.v = Math.hypot(x - o.x, y - o.y) * 5; o.x = x; o.y = y; o.h = h; o.running = run === 1;
    }
    for (const id of [...sim.players.keys()]) if (!seen.has(id)) sim.players.delete(id);
    this.stats.players = sim.players.size;
    // Dragons: the server's.
    for (const [id, , x, y, alt, h, st] of m.dragons) {
      const d = sim.dragons.dragons.find((q2) => q2.id === id);
      if (!d) continue;
      d.x = x; d.y = y; d.alt = alt; d.h = h; d.st = st as DState; d.z = q.height(x, y) + alt; d.v = 20;
    }
    // Creatures near us: exactly the server's set.
    const wl = sim.wildlife.creatures, keep = new Set<string>();
    for (const [id, sp, x, y, alt, h, st, alive] of m.creatures) {
      keep.add(id);
      let c = wl.get(id);
      if (!c) {
        c = { id, kind: 'creature', sp: sp as Species, tag: sp as Species, x, y, alt, alive: alive === 1, h, st: st as CState, stT: 0, next: 1e12, tx: x, ty: y, target: null, hunger: 0, thirst: 0, energy: 1, stamina: 1, homeX: x, homeY: y, group: id, leader: true, male: id.length % 2 === 0, look: (id.charCodeAt(id.length - 1) % 10) / 10, alert: 0, diedAt: -1, tier: 0, water: null } as Creature;
        wl.set(id, c);
      }
      c.x = x; c.y = y; c.alt = alt; c.h = h; c.st = st as CState; c.alive = alive === 1; c.tier = q.detailed(x, y) ? 0 : 1;
      c.alert = st === 'flee' || st === 'charge' ? 1 : 0;
    }
    for (const id of [...wl.keys()]) if (!keep.has(id)) wl.delete(id);
    // Villagers: the same people (generated the same way here), placed where the server has them.
    let placed = 0;
    for (const [id, x, y, h, st, , out] of m.villagers) {
      const v = sim.villages.people.get(id);
      if (!v) continue;
      v.x = x; v.y = y; v.h = h; v.st = st as never; v.out = out === 1; placed++;
    }
    this.stats.villagers = placed;
  }

  /** Remove finds others have taken from the loaded window. */
  private sweepTaken(): void {
    const s = this.lw.session, e = this.lw.engine, S = s.win.S, [ox, oy] = s.win.origin;
    for (const o of [...e.objects.objects.values()]) if (o.kind === 'cache' && this.taken.has(findId(o.variant, o.x + ox * S, o.y + oy * S))) e.objects.remove(o.id);
  }

  /** Ask for a find; the server decides (the first player wins). */
  take(variant: string, cx: number, cy: number): void { this.send({ type: 'take', id: findId(variant, cx, cy) }); }

  /** Per frame: send the traveller's moves (10 per second), our region edits (every 3 s, when changed). */
  frame(dt: number): void {
    if (!this.connected) return;
    const p = this.lw.player;
    if (this.unstick && this.lw.q.detailed(p.x, p.y)) {
      this.unstick = false;
      if (!this.lw.q.walkable(p.x, p.y)) search: for (let r = 1; r < 30; r++) for (let k = 0; k < 16; k++) {
        const x = p.x + Math.cos((k / 16) * 6.28) * r, y = p.y + Math.sin((k / 16) * 6.28) * r;
        if (this.lw.q.walkable(x, y)) { p.x = x; p.y = y; break search; }
      }
    }
    this.moveT += dt; this.editT += dt; this.sweepT += dt; this.popT += dt;
    // The local roster of villagers near us (their positions come from the server's snapshots).
    if (this.popT >= 2) { this.popT = 0; this.lw.sim.populateVillages([p]); }
    if (this.moveT >= 0.1) { this.moveT = 0; this.send({ type: 'move', x: p.x, y: p.y, h: p.h, run: p.running }); }
    if (this.sweepT >= 1) { this.sweepT = 0; this.sweepTaken(); }
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
