import { describe, it, expect } from 'vitest';
import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { WorldServer } from '../server/WorldServer';
import { WSConn, DEFAULT_LIMITS } from '../server/ws';
import { PROTOCOL, type ServerMsg } from '../src/world/net/protocol';
import { editToJSON, type RegionEdit } from '../src/world/edits';

/**
 * The transport and the world refuse what an untrusted client must not do: oversized or unmasked frames, pages
 * from other origins, floods of messages, and edits that are unreadable, out of reach, on protected ground or in
 * someone else's region. Slow clients get fewer snapshots (and are dropped if hopeless); silent ones time out.
 */
class Client {
  ws: WebSocket; msgs: ServerMsg[] = []; id = ''; closed: { code: number } | null = null;
  constructor(url: string) { this.ws = new WebSocket(url); this.ws.onmessage = (e) => { const m = JSON.parse(String(e.data)) as ServerMsg; this.msgs.push(m); if (m.type === 'welcome') this.id = m.id; }; this.ws.onclose = (e) => { this.closed = { code: e.code }; }; }
  async ready(name: string) { await new Promise<void>((r) => { this.ws.onopen = () => r(); }); this.ws.send(JSON.stringify({ type: 'hello', name, v: PROTOCOL })); for (let k = 0; k < 200 && !this.id; k++) await sleep(20); return this; }
  async waitFor<T extends ServerMsg['type']>(type: T, ms = 5000): Promise<Extract<ServerMsg, { type: T }>> { for (let t = 0; t < ms; t += 20) { const i = this.msgs.findIndex((m) => m.type === type); if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMsg, { type: T }>; await sleep(20); } throw new Error(`no ${type}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A raw TCP upgrade, to send what a browser never would. */
function rawUpgrade(port: number, origin?: string): Promise<{ status: string; sock: import('node:net').Socket }> {
  return new Promise((res) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(['GET / HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', ...(origin ? [`Origin: ${origin}`] : []), '', ''].join('\r\n'));
    });
    sock.once('data', (d) => res({ status: String(d).split('\r\n')[0], sock }));
  });
}

describe('transport limits', { timeout: 120_000 }, () => {
  it('refuses pages from other origins, accepts local ones and non-browser clients', async () => {
    const server = new WorldServer({ port: 0, dataFile: null });
    const port = await server.listen();
    expect((await rawUpgrade(port, 'https://evil.example')).status).toMatch(/403/);
    const ok = await rawUpgrade(port, 'http://localhost:5180'); expect(ok.status).toMatch(/101/); ok.sock.destroy();
    const none = await rawUpgrade(port); expect(none.status).toMatch(/101/); none.sock.destroy();
    const s2 = new WorldServer({ port: 0, dataFile: null, origins: ['https://lumenwild.example'] });
    const p2 = await s2.listen();
    const allowed = await rawUpgrade(p2, 'https://lumenwild.example'); expect(allowed.status).toMatch(/101/); allowed.sock.destroy();
    await server.stop(); await s2.stop();
  });

  it('closes on an oversized message or an unmasked frame; others are unaffected', async () => {
    const server = new WorldServer({ port: 0, dataFile: null });
    const port = await server.listen(), url = `ws://127.0.0.1:${port}`;
    const good = await new Client(url).ready('Good');
    const big = await new Client(url).ready('Big');
    big.ws.send('x'.repeat(DEFAULT_LIMITS.maxMessage + 1000));
    for (let k = 0; k < 100 && !big.closed; k++) await sleep(20);
    expect(big.closed?.code).toBe(1009);
    // Unmasked frame on a raw socket.
    const raw = await rawUpgrade(port);
    const closed = new Promise<boolean>((r) => { raw.sock.on('close', () => r(true)); setTimeout(() => r(false), 3000); });
    raw.sock.write(Buffer.from([0x81, 0x05, ...Buffer.from('hello')]));
    expect(await closed).toBe(true);
    // The well-behaved client still gets snapshots.
    good.msgs = [];
    expect((await good.waitFor('snap')).type).toBe('snap');
    good.ws.close();
    await server.stop();
  });

  it('throttles floods: excess messages are dropped and a persistent flooder is disconnected', async () => {
    const server = new WorldServer({ port: 0, dataFile: null });
    const port = await server.listen(), url = `ws://127.0.0.1:${port}`;
    const c = await new Client(url).ready('Flood');
    for (let k = 0; k < 600; k++) c.ws.send(JSON.stringify({ type: 'cmd', cmd: { t: 'use' } }));
    for (let k = 0; k < 100 && !c.closed; k++) await sleep(20);
    expect(server.stats.violations).toBeGreaterThan(200);
    expect(server.stats.commands).toBeLessThan(100); // the bucket let only a burst through
    expect(c.closed?.code).toBe(1008);
    await server.stop();
  });

  it('drops snapshots for a client that falls behind, disconnects a hopeless one, times out a silent one', () => {
    const sock = Object.assign(new EventEmitter(), { writableLength: 0, written: 0, ended: false, write() { this.written++; return true; }, end() { this.ended = true; }, destroy() {} });
    const c = new WSConn(sock as never, { ...DEFAULT_LIMITS, softBuffer: 1000, hardBuffer: 5000, idleMs: 1000 });
    expect(c.send('{"type":"snap"}', true)).toBe(true);
    sock.writableLength = 2000;
    expect(c.send('{"type":"snap"}', true)).toBe(false); // behind: snapshot skipped
    expect(c.send('{"type":"hero"}', false)).toBe(true); // important messages still go
    expect(c.stats.dropped).toBe(1);
    sock.writableLength = 9000;
    c.send('{"type":"snap"}', true);
    expect(c.open).toBe(false);
    expect(c.closeReason).toBe('too-slow');
    const quiet = new WSConn(Object.assign(new EventEmitter(), { writableLength: 0, write() { return true; }, end() {}, destroy() {} }) as never, { ...DEFAULT_LIMITS, idleMs: 1000 });
    quiet.heartbeat(Date.now() + 2000);
    expect(quiet.open).toBe(false);
    expect(quiet.closeReason).toBe('idle');
  });
});

describe('world edits: validated and permitted per region', { timeout: 120_000 }, () => {
  /** An edit painting `cells` of a region (local indices). */
  const paint = (cells: number[]): ReturnType<typeof editToJSON> => {
    const n = cells.length, e: RegionEdit = { idx: Uint32Array.from(cells), elev: new Float32Array(n).fill(130), mat: new Uint8Array(n).fill(15), cover: new Uint8Array(n), coverVar: new Uint8Array(n), moisture: new Uint8Array(n), magic: new Uint8Array(n), removed: [], added: [], waterIdx: new Uint32Array(0), waterDepth: new Float32Array(0), sources: [], drains: [] };
    return editToJSON(e);
  };

  it('accepts an edit in reach on open ground; refuses protected ground, out of reach, unreadable and other owners', async () => {
    const server = new WorldServer({ port: 0, dataFile: null });
    const port = await server.listen(), url = `ws://127.0.0.1:${port}`;
    const a = await new Client(url).ready('Ada'), b = await new Client(url).ready('Bram');
    const A = server.sim.players.get(a.id)!, prx = Math.floor(A.x / 256), pry = Math.floor(A.y / 256);
    const vmask = server.guard.protectedMask(prx, pry)!;
    expect(vmask).not.toBeNull(); // Lumenfall is in the player's region
    const village = [...Array(256 * 256).keys()].filter((i) => vmask[i]).slice(0, 5);
    // Open ground: a neighbouring region in reach with unprotected cells.
    let rx = prx, ry = pry, open: number[] = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const m = server.guard.protectedMask(prx + dx, pry + dy);
      const free = [...Array(256 * 256).keys()].filter((i) => !m || !m[i]).slice(0, 5);
      if (free.length === 5) { rx = prx + dx; ry = pry + dy; open = free; break; }
    }
    const key = `${rx},${ry}`;
    expect(open.length).toBe(5);
    // Edits are rate-limited (2 a second): space them out like a real client.
    const send = async (k: string, edit: unknown) => { await sleep(550); a.ws.send(JSON.stringify({ type: 'edit', key: k, edit })); };
    const rejected = async () => (await a.waitFor('rejected')).reason;
    // Accepted: open ground in the player's region; Bram receives it, the author is recorded.
    await send(key, paint(open));
    expect((await b.waitFor('edit')).key).toBe(key);
    expect(server.guard.meta.get(key)?.by).toBe(a.id);
    // Protected: the village.
    await send(`${prx},${pry}`, paint(village)); expect(await rejected()).toMatch(/protected/);
    // Out of reach: three regions away.
    await send(`${prx + 3},${pry}`, paint(open)); expect(await rejected()).toMatch(/reach/);
    // Unreadable: a cell index outside the region, a broken payload.
    await send(key, { ...paint([1]), idx: Buffer.from(Uint32Array.of(70000).buffer).toString('base64') }); expect(await rejected()).toMatch(/unreadable/);
    await send(key, { nonsense: true }); expect(await rejected()).toMatch(/unreadable/);
    // Owned by someone else.
    server.guard.claim(key, b.id);
    await send(key, paint(open)); expect(await rejected()).toMatch(/belongs/);
    expect(server.edits.size).toBe(1);
    expect(server.stats.rejectedEdits).toBe(5);
    a.ws.close(); b.ws.close();
    await server.stop();
  });

  it('a development server can allow village edits', async () => {
    const server = new WorldServer({ port: 0, dataFile: null, allowVillageEdits: true });
    const port = await server.listen();
    const a = await new Client(`ws://127.0.0.1:${port}`).ready('Ada');
    const A = server.sim.players.get(a.id)!, rx = Math.floor(A.x / 256), ry = Math.floor(A.y / 256);
    const mask = server.guard.protectedMask(rx, ry)!, village = [...Array(256 * 256).keys()].filter((i) => mask[i]).slice(0, 3);
    a.ws.send(JSON.stringify({ type: 'edit', key: `${rx},${ry}`, edit: paint(village) }));
    for (let k = 0; k < 100 && !server.edits.size; k++) await sleep(20);
    expect(server.edits.size).toBe(1);
    a.ws.close();
    await server.stop();
  });
});
