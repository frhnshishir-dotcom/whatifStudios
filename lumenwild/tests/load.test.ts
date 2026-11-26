import { describe, it, expect } from 'vitest';
import { WorldServer } from '../server/WorldServer';
import { PROTOCOL, type ServerMsg } from '../src/world/net/protocol';

/**
 * Load: 16 bot clients on one local server for 20 seconds. Each walks around Lumenfall (the server checks every
 * move), swings at things, and some are set upon by wolves. Measured: server tick time, bytes sent per client,
 * snapshots received, events, corrections. `npm run loadtest` runs this alone and prints the numbers.
 */
const BOTS = 16, SECONDS = 20;

class Bot {
  ws: WebSocket; id = ''; snaps = 0; evs = 0; corrections = 0; heroes = 0; lastPlayers = 0; errors = 0; bytes = 0;
  x = 0; y = 0; h = Math.random() * 6.28;
  constructor(url: string, readonly name: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      const text = String(e.data); this.bytes += text.length;
      const m = JSON.parse(text) as ServerMsg;
      if (m.type === 'welcome') { this.id = m.id; this.x = m.x; this.y = m.y; }
      else if (m.type === 'snap') { this.snaps++; this.lastPlayers = m.players.length; }
      else if (m.type === 'ev') this.evs += m.evs.length;
      else if (m.type === 'correct') { this.corrections++; this.x = m.x; this.y = m.y; }
      else if (m.type === 'hero') this.heroes++;
    };
    this.ws.onerror = () => { this.errors++; };
  }
  opened(): Promise<void> { return new Promise((res) => { this.ws.onopen = () => { this.ws.send(JSON.stringify({ type: 'hello', name: this.name, v: PROTOCOL })); res(); }; }); }
  send(m: object): void { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
}

describe('load', { timeout: 120_000 }, () => {
  it(`${BOTS} bot clients for ${SECONDS} s: the server keeps up`, async () => {
    const server = new WorldServer({ port: 0, dataFile: null });
    const port = await server.listen();
    const bots = Array.from({ length: BOTS }, (_, k) => new Bot(`ws://127.0.0.1:${port}`, `Bot${k}`));
    await Promise.all(bots.map((b) => b.opened()));
    for (let k = 0; k < 100 && bots.some((b) => !b.id); k++) await new Promise((r) => setTimeout(r, 50));
    // A few of them are set upon by wolves.
    for (const b of bots.slice(0, 4)) { const p = server.sim.players.get(b.id)!; server.sim.wildlife.raiseGuardian(`load-wolf-${b.name}`, 'wolf', p.x + 6, p.y, p, server.sim.clock); }
    const ticks: number[] = [];
    const sample = setInterval(() => ticks.push(server.stats.tickMs), 100);
    const bytes0 = server.stats.bytesOut, t0 = Date.now();
    const walk = setInterval(() => {
      for (const b of bots) {
        // Wander at walking pace, turning away from anything the server says is blocked.
        for (let tries = 0; tries < 6; tries++) {
          const nx = b.x + Math.cos(b.h) * 0.4, ny = b.y + Math.sin(b.h) * 0.4;
          if (server.q.walkable(nx, ny)) { b.x = nx; b.y = ny; break; }
          b.h += 1 + Math.random();
        }
        if (Math.random() < 0.05) b.h += (Math.random() - 0.5) * 2;
        b.send({ type: 'move', x: b.x, y: b.y, h: b.h, run: false });
        if (Math.random() < 0.15) b.send({ type: 'cmd', cmd: { t: 'attack', h: b.h } });
        if (Math.random() < 0.02) b.send({ type: 'cmd', cmd: { t: 'use' } });
      }
    }, 100);
    await new Promise((r) => setTimeout(r, SECONDS * 1000));
    clearInterval(walk); clearInterval(sample);
    const secs = (Date.now() - t0) / 1000, sorted = [...ticks].sort((a, b) => a - b);
    const avg = ticks.reduce((a, b) => a + b, 0) / ticks.length, p95 = sorted[Math.floor(sorted.length * 0.95)];
    const perClient = (server.stats.bytesOut - bytes0) / secs / BOTS;
    const heap = process.memoryUsage().heapUsed / 1048576;
    console.log(`load: ${BOTS} bots, ${secs.toFixed(1)} s · server tick avg ${avg.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${server.stats.maxTickMs.toFixed(1)} ms · ${(perClient / 1024).toFixed(1)} KB/s per client · snapshots/bot ${Math.min(...bots.map((b) => b.snaps))}-${Math.max(...bots.map((b) => b.snaps))} · events ${server.stats.events} · commands ${server.stats.commands} · rejected moves ${server.stats.rejectedMoves} · creatures ${server.sim.wildlife.creatures.size} · heap ${heap.toFixed(0)} MB`);
    for (const b of bots) {
      expect(b.errors).toBe(0);
      expect(b.snaps).toBeGreaterThan(SECONDS * 4 * 0.8); // ~5 per second
      expect(b.lastPlayers).toBe(BOTS); // everyone sees everyone (they are all around Lumenfall)
      expect(b.heroes).toBeGreaterThan(0);
    }
    expect(server.stats.commands).toBeGreaterThan(BOTS * SECONDS);
    expect(avg).toBeLessThan(25);
    expect(p95).toBeLessThan(60);
    for (const b of bots) b.ws.close();
    await server.stop();
  });
});
