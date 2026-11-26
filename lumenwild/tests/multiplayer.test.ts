import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { WorldServer } from '../server/WorldServer';
import type { ServerMsg } from '../src/world/net/protocol';

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
  c.send({ type: 'hello', name, token });
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
    // Ada walks east; Bram's snapshots show her there.
    const w = (await a.waitFor('snap')).players.find((p) => p[0] === a.id)!;
    let x = w[2];
    for (let k = 0; k < 10; k++) { x += 3; a.send({ type: 'move', x, y: w[3], h: 0, run: false }); await new Promise((r) => setTimeout(r, 120)); }
    const seen = await b.waitFor('snap', (m) => m.players.some((p) => p[0] === a.id && Math.abs(p[2] - x) < 0.5));
    expect(seen.players.length).toBe(3);
    // A move faster than running is refused (the player stays where the server last accepted).
    a.send({ type: 'move', x: x + 500, y: w[3], h: 0, run: true });
    const after = await c.waitFor('snap', (m) => m.t > seen.t + 0.5);
    expect(after.players.find((p) => p[0] === a.id)![2]).toBeCloseTo(x, 0);
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
    // A contested find: the first to take it gets it.
    const fx = Math.round(x), fy = Math.round(w[3]), find = `chest:${fx},${fy}`;
    a.send({ type: 'take', id: find });
    const took = await a.waitFor('took');
    expect(took.inv.coins).toBe(25);
    b.send({ type: 'move', x: fx - 3, y: fy, h: 0, run: false });
    await new Promise((r) => setTimeout(r, 2500));
    b.send({ type: 'take', id: find });
    expect((await b.waitFor('denied')).reason).toMatch(/taken|far/);
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
    expect(server.sim.players.get(a.id)!.inv.coins).toBe(25);
    console.log(`server: ${server.stats.ticks} ticks, last tick ${server.stats.tickMs.toFixed(2)} ms, ${server.stats.snaps} snapshots sent`);
    a2.close();
    await server.stop();
  });
});
