import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContinentTerrain, RegionData } from '../src/world/terrain';
import { masksOf } from './regionMasks';

/**
 * The server's generated regions (exact 1 m terrain, objects and collision masks), made off the main thread.
 *
 * - **Generation never runs on the server loop.** `pin()`/`request()` queue the regions players need, and worker threads
 *   generate them; until a region arrives, queries there answer from the coarse continent model (as the browser
 *   does outside its window).
 * - **Demand-sized cache.** The regions players are in, and the eight around each, are pinned. They are never
 *   evicted while needed. The cache holds the pinned ones plus a margin of recently used ones, between `minRegions`
 *   and `maxRegions` (about 1.2 MB per region), and never fewer than the pinned ones. Past that, the least recently
 *   used unpinned regions go.
 * - **Priority:** regions nearest a player are generated first, and a region is never requested twice.
 * - **Workers on demand:** up to two threads (70-90 MB each), started when regions are wanted and stopped after
 *   `idleMs` without work. A failed worker's region is asked for again.
 * Without a worker bundle (a test without the build step), generation falls back to the calling thread and
 * says so in `stats.syncFallback`.
 */

export interface RegionEntry { r: RegionData; solid: Uint8Array; deck: Uint8Array; used: number }
export interface RegionStoreOptions {
  /** Worker threads at most (default: 2, or 1 on a two-core machine). */
  workers?: number;
  /** Cache capacity at most (regions; about 1.2 MB each). */
  maxRegions?: number;
  /** Recently used regions kept beyond the pinned ones, and the capacity with few players (default 64). */
  margin?: number;
  minRegions?: number;
  /** A worker idle this long is stopped (it costs 70-90 MB); one is started again when regions are needed. */
  idleMs?: number;
  workerPath?: string | null;
  log?: (s: string) => void;
}

/** A region as one number (no string built per terrain query). */
export const regionKey = (rx: number, ry: number): number => (rx + 32768) * 65536 + (ry + 32768);
const key = regionKey;

/** Where the worker bundle is: next to this module once built (dist-server), or dist-worker/ for tests. */
function findWorker(explicit?: string | null): string | null {
  if (explicit !== undefined) return explicit && existsSync(explicit) ? explicit : null;
  const env = process.env.LUMENWILD_REGION_WORKER;
  if (env && existsSync(env)) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, 'regionWorker.js'), join(here, '..', 'dist-worker', 'regionWorker.js')]) if (existsSync(p)) return p;
  return null;
}

export class RegionStore {
  readonly cache = new Map<number, RegionEntry>();
  private pinned = new Set<number>();
  private queue: Array<[number, number, number]> = []; // rx, ry, priority (distance to the nearest player, regions)
  private pending = new Set<number>();
  private workers: Array<{ w: Worker; busy: number | null; idleSince: number }> = [];
  private workerPath: string | null;
  readonly stats = { generated: 0, genMsTotal: 0, genMsMax: 0, evicted: 0, syncFallback: 0, queued: 0, capacity: 0, workers: 0, workerStarts: 0, workersStopped: 0 };
  private readonly maxRegions: number;
  private readonly margin: number;
  private readonly minRegions: number;
  private readonly nWorkers: number;
  private readonly idleMs: number;
  private log: (s: string) => void;
  private closed = false;

  constructor(private terrain: ContinentTerrain, opts: RegionStoreOptions = {}) {
    this.maxRegions = opts.maxRegions ?? 192;
    this.margin = opts.margin ?? 27;
    this.minRegions = Math.min(opts.minRegions ?? 64, this.maxRegions);
    this.stats.capacity = this.minRegions;
    this.nWorkers = Math.max(1, opts.workers ?? Math.min(2, Math.max(1, cpus().length - 1)));
    this.idleMs = opts.idleMs ?? 30_000;
    this.workerPath = findWorker(opts.workerPath);
    this.log = opts.log ?? (() => {});
    if (!this.workerPath) this.log('Region worker bundle not found: regions will be generated on the main thread (development only).');
  }

  /** A cached region (no bookkeeping: this is called for every terrain query). */
  get(rx: number, ry: number): RegionEntry | undefined { return this.cache.get(key(rx, ry)); }

  /** Queue the 3 x 3 regions around each point that are not here yet (nearest first). Does not change the pins. */
  request(points: Array<{ x: number; y: number }>): void {
    if (this.closed) return;
    for (const p of points) {
      const prx = Math.floor(p.x / 256), pry = Math.floor(p.y / 256);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const rx = prx + dx, ry = pry + dy, k = key(rx, ry);
        if (this.cache.has(k) || this.pending.has(k)) continue;
        this.pending.add(k);
        this.queue.push([rx, ry, Math.max(Math.abs(dx), Math.abs(dy))]);
      }
    }
    this.queue.sort((a, b) => a[2] - b[2]);
    this.pump();
  }

  /** The regions needed now: the 3 x 3 around each player, pinned (never evicted while needed); missing ones queued. */
  pin(points: Array<{ x: number; y: number }>): void {
    const pin = new Set<number>(), now = performance.now();
    for (const p of points) {
      const prx = Math.floor(p.x / 256), pry = Math.floor(p.y / 256);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const k = key(prx + dx, pry + dy); pin.add(k); const e = this.cache.get(k); if (e) e.used = now; }
    }
    this.pinned = pin;
    // Demand: the pinned regions plus a margin, within [minRegions, maxRegions]; never fewer than the pinned ones
    // (each player pins nine, so memory is bounded by max(maxRegions, 9 x players) regions).
    this.stats.capacity = Math.max(pin.size, Math.min(this.maxRegions, Math.max(this.minRegions, pin.size + this.margin)));
    this.request(points);
    this.evict();
    this.reap();
  }

  /** Stop workers that have had nothing to do for `idleMs` (memory back; they start again on demand). */
  private reap(): void {
    if (this.queue.length) return;
    const now = performance.now();
    for (const slot of [...this.workers]) {
      if (slot.busy !== null || now - slot.idleSince < this.idleMs) continue;
      this.workers.splice(this.workers.indexOf(slot), 1);
      void slot.w.terminate();
      this.stats.workersStopped++;
    }
    this.stats.workers = this.workers.length;
  }

  /** Hand queued regions to idle workers (or, without a worker bundle, generate one per call here). */
  private pump(): void {
    if (!this.workerPath) {
      for (let q = this.queue.shift(); q; q = this.queue.shift()) this.accept(q[0], q[1], this.terrain.generateRegion(q[0], q[1]), null, true);
      this.stats.queued = 0;
      return;
    }
    while (this.workers.length < this.nWorkers && this.queue.length > this.workers.filter((w) => w.busy === null).length) this.spawn();
    for (const slot of this.workers) {
      if (slot.busy !== null) continue;
      const q = this.queue.shift();
      if (!q) break;
      slot.busy = key(q[0], q[1]);
      slot.w.postMessage({ rx: q[0], ry: q[1] });
    }
    this.stats.queued = this.queue.length;
  }

  private spawn(): void {
    const w = new Worker(this.workerPath!);
    w.unref(); // never keeps the process alive
    const slot = { w, busy: null as number | null, idleSince: performance.now() };
    this.stats.workerStarts++;
    w.on('message', (m: { rx: number; ry: number; region: RegionData; masks: { solid: Uint8Array; deck: Uint8Array }; ms: number }) => {
      slot.busy = null; slot.idleSince = performance.now();
      if (this.closed) return;
      this.stats.genMsTotal += m.ms; this.stats.genMsMax = Math.max(this.stats.genMsMax, m.ms);
      this.accept(m.rx, m.ry, m.region, m.masks, false);
      this.pump();
    });
    w.on('error', (e) => {
      // The region it was making is asked for again (by the next request); a new worker is started when needed.
      this.log(`Region worker failed: ${e.message}`);
      if (slot.busy !== null) this.pending.delete(slot.busy);
      slot.busy = null;
      this.workers.splice(this.workers.indexOf(slot), 1);
    });
    this.workers.push(slot);
    this.stats.workers = this.workers.length;
  }

  private accept(rx: number, ry: number, r: RegionData, masks: { solid: Uint8Array; deck: Uint8Array } | null, sync: boolean): void {
    const k = key(rx, ry);
    this.pending.delete(k);
    const m = masks ?? masksOf(r);
    this.cache.set(k, { r, solid: m.solid, deck: m.deck, used: performance.now() });
    this.stats.generated++;
    if (sync) this.stats.syncFallback++;
    this.evict();
  }

  /** Over capacity: drop the least recently used regions nobody needs now. */
  private evict(): void {
    const cap = this.stats.capacity;
    if (this.cache.size <= cap) return;
    const free = [...this.cache.entries()].filter(([k]) => !this.pinned.has(k)).sort((a, b) => a[1].used - b[1].used);
    for (const [k] of free) { if (this.cache.size <= cap) break; this.cache.delete(k); this.stats.evicted++; }
  }

  /** Wait until every wanted region is here (tests and tools; the server never waits). */
  async settle(timeoutMs = 30_000): Promise<void> {
    const t0 = Date.now();
    while ((this.queue.length || this.pending.size) && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 10));
  }

  /** Generate a region right now on this thread (tools that need it at once, e.g. tests placing things). */
  now(rx: number, ry: number): RegionEntry {
    const k = key(rx, ry);
    let e = this.cache.get(k);
    if (!e) { this.accept(rx, ry, this.terrain.generateRegion(rx, ry), null, true); this.queue = this.queue.filter((q) => key(q[0], q[1]) !== k); e = this.cache.get(k)!; }
    return e;
  }

  isPinned(rx: number, ry: number): boolean { return this.pinned.has(key(rx, ry)); }

  async close(): Promise<void> { this.closed = true; await Promise.all(this.workers.map((s) => s.w.terminate())); this.workers = []; }
}
