import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { WorldServer } from '../server/WorldServer';
import { heroToJSON } from '../src/world/rpg/hero';
import { PROTOCOL, type ServerMsg } from '../src/world/net/protocol';

/**
 * Multiplayer foundation: independent WebSocket clients against one local authoritative server. Sessions and
 * identities, a shared living world (the same dragons and creatures for everyone), edits relayed between players,
 * a contested find, reconnection with a token, and recovery after a server restart.
 */

class Client {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  id = ''; token = '';
  constructor(url: string) { this.ws = new WebSocket(url); this.ws.onmessage = (e) => { const m = JSON.parse(String(e.data)) as ServerMsg; this.msgs.push(m); if (m.type === 'welcome') { this.id = m.id; this.token = m.token; } }; }
  opened(): Promise<void> { return new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('ws error')); }); }
  send(m: object): void { this.ws.send(JSON.stringify(m)); }
  async waitFor<T extends ServerMsg['type']>(type: T, pred: (m: Extract<ServerMsg, { type: T }>) => boolean = () => true, ms = 8000): Promise<Extract<ServerMsg, { type: T }>> {
    const t0 = Date.now();
    for (;;) {
      const i = this.msgs.findIndex((m) => m.type === type && pred(m as Extract<ServerMsg, { type: T }>));
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMsg, { type: T }>;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${type}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  close(): void { this.ws.close(); }
}

async function join(url: string, name: string, token?: string): Promise<Client> {
  const c = new Client(url);
  await c.opened();
  c.send({ type: 'hello', name, token, v: PROTOCOL });
  await c.waitFor('welcome');
  return c;
}

describe('multiplayer foundation (local authoritative server)', { timeout: 180_000 }, () => {
  it('three independent clients share one world; edits, finds, reconnection and a server restart', async () => {
    const dataFile = pathJoin(mkdtempSync(pathJoin(tmpdir(), 'lumenwild-')), 'world.json');
    let server = new WorldServer({ port: 0, dataFile });
    let port = await server.listen();
    const url = () => `ws://127.0.0.1:${port}`;
    const a = await join(url(), 'Ada'), b = await join(url(), 'Bram'), c = await join(url(), 'Cora');
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    // Ada walks 30 m in a direction that is open ground (the server checks walls and water); Bram sees her there.
    const w = (await a.waitFor('snap')).players.find((p) => p[0] === a.id)!;
    const dir = [[1, 0], [0, 1], [-1, 0], [0, -1]].find(([dx, dy]) => Array.from({ length: 32 }, (_, k) => k + 1).every((k) => server.q.walkable(w[2] + dx * k, w[3] + dy * k)))!;
    expect(dir).toBeDefined();
    let x = w[2], y = w[3];
    for (let k = 0; k < 10; k++) { x += dir[0] * 3; y += dir[1] * 3; a.send({ type: 'move', x, y, h: 0, run: false }); await new Promise((r) => setTimeout(r, 120)); }
    const seen = await b.waitFor('snap', (m) => m.players.some((p) => p[0] === a.id && Math.hypot(p[2] - x, p[3] - y) < 0.5));
    expect(seen.players.length).toBe(3);
    // A move faster than running is refused and corrected (the player stays where the server last accepted).
    a.send({ type: 'move', x: x + 500, y, h: 0, run: true });
    const corr = await a.waitFor('correct');
    expect(corr.x).toBeCloseTo(x, 0);
    const after = await c.waitFor('snap', (m) => m.t > seen.t + 0.5);
    expect(after.players.find((p) => p[0] === a.id)![2]).toBeCloseTo(x, 0);
    // So is a move into a building.
    const wall = (() => { for (let r = 2; r < 60; r++) for (let k = 0; k < 16; k++) { const qx = x + Math.cos(k / 16 * 6.283) * r, qy = y + Math.sin(k / 16 * 6.283) * r; if (server.q.detailed(qx, qy) && !server.q.walkable(qx, qy) && !server.q.water(qx, qy)) return [qx, qy]; } return null; })();
    if (wall) {
      const sp = server.sim.players.get(a.id)!; sp.x = wall[0] - 1.2; sp.y = wall[1];
      a.send({ type: 'move', x: wall[0], y: wall[1], h: 0, run: false });
      await new Promise((r) => setTimeout(r, 300));
      expect(Math.hypot(sp.x - wall[0], sp.y - wall[1])).toBeGreaterThan(0.5);
      sp.x = x; sp.y = y;
    }
    expect(server.stats.rejectedMoves).toBeGreaterThan(0);
    // The same living world for everyone: dragons and creatures from one simulation.
    const sa = await a.waitFor('snap'), sb = await b.waitFor('snap', (m) => m.t === sa.t);
    expect(sb.dragons).toEqual(sa.dragons);
    expect(sa.dragons.length).toBe(5);
    expect(sa.creatures.length).toBeGreaterThan(0);
    const common = sa.creatures.filter((q) => sb.creatures.some((r) => r[0] === q[0]));
    for (const q of common) expect(sb.creatures.find((r) => r[0] === q[0])).toEqual(q);
    // Edits are relayed to the others.
    const edit = { idx: 'AAAAAA==', elev: 'AACAPw==', mat: 'Aw==', cover: 'AA==', coverVar: 'AA==', moisture: 'AA==', magic: 'AA==', removed: [], added: [], waterIdx: '', waterDepth: '', sources: [], drains: [] };
    a.send({ type: 'edit', key: '195,199', edit });
    const got = await c.waitFor('edit');
    expect(got.key).toBe('195,199'); expect(got.by).toBe(a.id); expect(got.edit).toEqual(edit);
    // A contested find (a real one, generated near Lumenfall): the first to take it gets it; it is gone for everyone.
    let cache: { x: number; y: number; variant: string } | null = null;
    const rx0 = Math.floor(x / 256), ry0 = Math.floor(y / 256);
    for (let dy = -1; dy <= 1 && !cache; dy++) for (let dx = -1; dx <= 1 && !cache; dx++) {
      const r = server.terrain.generateRegion(rx0 + dx, ry0 + dy), o = r.objects.find((q) => q.kind === 'cache');
      if (o) cache = { x: o.x + r.ox, y: o.y + r.oy, variant: o.variant };
    }
    expect(cache).not.toBeNull();
    server.q.ensureAround(cache!.x, cache!.y);
    const find = `${cache!.variant}:${cache!.x},${cache!.y}`;
    for (const id of [a.id, b.id]) { const sp = server.sim.players.get(id)!; sp.x = cache!.x + 1.5; sp.y = cache!.y + 0.5; }
    const coins0 = server.sim.players.get(a.id)!.hero.coins;
    a.send({ type: 'cmd', cmd: { t: 'gather', node: find } });
    const msgA = await a.waitFor('ev', (m) => m.evs.some((e) => e.e === 'msg' && /chest|Took|first/.test(e.text)));
    expect(JSON.stringify(msgA.evs)).toMatch(/Opened the chest|Took/);
    b.send({ type: 'cmd', cmd: { t: 'gather', node: find } });
    const msgB = await b.waitFor('ev', (m) => m.evs.some((e) => e.e === 'msg' && /chest|Took|first/.test(e.text)));
    expect(JSON.stringify(msgB.evs)).toMatch(/Someone got there first/);
    expect((await c.waitFor('taken')).ids).toContain(find);
    const ada = server.sim.players.get(a.id)!.hero;
    expect(ada.coins > coins0 || ada.inv.length > 1).toBe(true);
    const heroA = await a.waitFor('hero', (m) => JSON.stringify(m.hero) === JSON.stringify(heroToJSON(ada)), 3000);
    expect(heroA.hero.coins).toBe(ada.coins);
    x = server.sim.players.get(a.id)!.x;
    // Reconnection: Bram drops and comes back with his token: same player, same place.
    a.msgs = a.msgs.filter((m) => m.type !== 'snap'); // a fresh snapshot, not one queued earlier
    const bramAt = (await a.waitFor('snap')).players.find((p) => p[0] === b.id)!;
    b.close();
    await a.waitFor('left', (m) => m.id === b.id);
    const b2 = await join(url(), 'Bram', b.token);
    expect(b2.id).toBe(b.id);
    const back = (await b2.waitFor('snap')).players.find((p) => p[0] === b.id)!;
    expect(back[2]).toBeCloseTo(bramAt[2], 0);
    // Restart the server (state written to the file): Ada resumes with her pack, the edit and the taken find survive.
    a.close(); b2.close(); c.close();
    await server.stop();
    server = new WorldServer({ port: 0, dataFile });
    port = await server.listen();
    const a2 = await join(url(), 'Ada', a.token);
    const wel = a2.msgs.find((m) => m.type === 'welcome') ?? (await a2.waitFor('snap'), null);
    void wel;
    expect(a2.id).toBe(a.id);
    const s = await a2.waitFor('snap');
    expect(s.players.find((p) => p[0] === a.id)![2]).toBeCloseTo(x, 0);
    expect(server.edits.get('195,199')).toEqual(edit);
    expect(server.taken.has(find)).toBe(true);
    expect(server.sessions.get(a.id)!.player.hero.coins).toBe(ada.coins);
    expect(server.sessions.get(a.id)!.player.hero.inv.map((i) => i.id)).toEqual(ada.inv.map((i) => i.id));
    console.log(`server: ${server.stats.ticks} ticks, last tick ${server.stats.tickMs.toFixed(2)} ms, ${server.stats.snaps} snapshots sent`);
    a2.close();
    await server.stop();
  });

  it('server-authoritative combat, loot and trade between two clients', async () => {
    const server = new WorldServer({ port: 0, dataFile: null });
    const port = await server.listen(), url = `ws://127.0.0.1:${port}`;
    const a = await join(url, 'Ada'), b = await join(url, 'Bram');
    const A = server.sim.players.get(a.id)!, B = server.sim.players.get(b.id)!;
    // A wolf goes for Ada; she fights it with commands; Bram, standing by, sees the fight.
    B.x = A.x + 3; B.y = A.y;
    server.sim.wildlife.raiseGuardian('mp-wolf', 'wolf', A.x + 3, A.y, A, server.sim.clock);
    const wolf = server.sim.wildlife.creatures.get('mp-wolf')!;
    A.hero.equip.weapon = { uid: 'w', id: 'knight-sword', n: 1, r: 3 };
    for (let k = 0; k < 60 && wolf.alive; k++) {
      A.x = wolf.x - 1.2; A.y = wolf.y; A.hero.hp = Math.max(A.hero.hp, 40);
      a.send({ type: 'cmd', cmd: { t: 'attack', h: 0 } });
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(wolf.alive).toBe(false);
    const hits = await b.waitFor('ev', (m) => m.evs.some((e) => e.e === 'hit' && e.who === a.id));
    expect(hits).toBeTruthy();
    const kill = await a.waitFor('ev', (m) => m.evs.some((e) => e.e === 'kill'));
    expect(kill).toBeTruthy();
    // Both see the loot on the ground and its creature health in snapshots; only Ada may take it for now.
    const snapB = await b.waitFor('snap', (m) => m.loot.length > 0);
    const bag = snapB.loot[0];
    B.x = bag[1]; B.y = bag[2];
    b.send({ type: 'cmd', cmd: { t: 'pickup', id: bag[0] } });
    expect(JSON.stringify((await b.waitFor('ev', (m) => m.evs.some((e) => e.e === 'msg' && /belongs|Nothing/.test(e.text)))).evs)).toMatch(/belongs/);
    A.x = bag[1]; A.y = bag[2];
    a.send({ type: 'cmd', cmd: { t: 'pickup', id: bag[0] } });
    await a.waitFor('ev', (m) => m.evs.some((e) => e.e === 'msg' && /Picked up/.test(e.text)));
    const pelt = A.hero.inv.find((i) => i.id === 'wolf-pelt' || i.id === 'fang')!;
    expect(pelt).toBeDefined();
    const heroA = await a.waitFor('hero', (m) => (m.hero.inv as Array<{ id: string }>).some((i) => i.id === pelt.id));
    expect(heroA.hero.stats).toBeDefined();
    // Ada sells the pelt to Bram for 5 coins; he accepts; both characters update.
    B.x = A.x + 2; B.y = A.y;
    a.send({ type: 'cmd', cmd: { t: 'offer', to: b.id, uids: [pelt.uid], coins: 0, price: 5 } });
    const offer = await b.waitFor('hero', (m) => m.view.offers.some((o) => o.to === b.id));
    const oid = offer.view.offers.find((o) => o.to === b.id)!.id;
    const coinsA = A.hero.coins, coinsB = B.hero.coins;
    b.send({ type: 'cmd', cmd: { t: 'trade', id: oid, accept: true } });
    await b.waitFor('hero', (m) => (m.hero.inv as Array<{ id: string }>).some((i) => i.id === pelt.id));
    expect(A.hero.coins).toBe(coinsA + 5); expect(B.hero.coins).toBe(coinsB - 5);
    expect(A.hero.inv.some((i) => i.uid === pelt.uid)).toBe(false);
    // A player who falls is moved home by the server (the client is told where).
    A.hero.hp = 1;
    server.sim.wildlife.raiseGuardian('mp-bear', 'bear', A.x + 1.5, A.y, A, server.sim.clock);
    await a.waitFor('ev', (m) => m.evs.some((e) => e.e === 'died' && e.who === a.id), 15_000);
    const corr = await a.waitFor('correct', () => true, 12_000);
    expect(Math.hypot(corr.x - A.hero.home[0], corr.y - A.hero.home[1])).toBeLessThan(3);
    console.log(`combat sync: ${server.stats.events} events, ${server.stats.commands} commands; Ada level ${A.hero.level}, kills ${JSON.stringify(A.hero.stats.kills)}`);
    a.close(); b.close();
    await server.stop();
  });
});
