import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * A small WebSocket server (RFC 6455) for the local game server: text frames, fragmentation, ping/pong and close.
 * No dependencies. Clients are browsers or Node's built-in WebSocket.
 *
 * Hardened for untrusted clients:
 * - **Size:** a message (after reassembling fragments) larger than `maxMessage` closes the connection (1009), and
 *   so does a frame header announcing one. Nothing is buffered past the limit.
 * - **Masking:** client frames must be masked (RFC 6455 §5.1); an unmasked frame closes the connection (1002).
 * - **Backpressure:** `send(text, droppable)` skips droppable messages (snapshots: the next one supersedes them)
 *   while more than `softBuffer` bytes are waiting to go out, and closes the connection (1008) past `hardBuffer`.
 * - **Origin:** browsers send an Origin header. If `allowOrigin` rejects it, the upgrade is refused with 403.
 *   Requests without an Origin (non-browser clients) are accepted.
 * - **Heartbeat:** `heartbeat()` (called by the server every few seconds) pings idle connections and closes those
 *   silent for longer than `idleMs`.
 */
export interface WSLimits { maxMessage: number; softBuffer: number; hardBuffer: number; idleMs: number }
export const DEFAULT_LIMITS: WSLimits = { maxMessage: 1 << 20, softBuffer: 256 << 10, hardBuffer: 4 << 20, idleMs: 45_000 };

export class WSConn {
  onmessage: ((text: string) => void) | null = null;
  onclose: (() => void) | null = null;
  open = true;
  /** Why it closed (for logs and tests): 'client', 'too-big', 'unmasked', 'too-slow', 'idle', 'server'. */
  closeReason = '';
  readonly stats = { dropped: 0, received: 0, sent: 0 };
  lastHeard = Date.now();
  private chunks: Buffer[] = [];
  private buffered = 0;
  private frag: Buffer[] = [];
  private fragBytes = 0;

  constructor(private socket: Duplex, readonly limits: WSLimits = DEFAULT_LIMITS) {
    socket.on('data', (d: Buffer) => this.data(d));
    socket.on('close', () => this.closed('client'));
    // The client went away without a close frame: finish our side too, so nothing stays half-open.
    socket.on('end', () => { try { socket.end(); } catch { /* already closed */ } this.closed('client'); });
    socket.on('error', () => this.closed('client'));
  }

  private closed(why: string): void { if (!this.open) return; this.open = false; this.closeReason ||= why; this.onclose?.(); }

  private data(d: Buffer): void {
    if (!this.open) return;
    this.lastHeard = Date.now();
    this.chunks.push(d); this.buffered += d.length;
    // A frame header (at most 14 bytes) plus a message can never legitimately exceed this.
    if (this.buffered > this.limits.maxMessage + 14) return this.fail(1009, 'too-big');
    this.parse();
  }

  private take(): Buffer { if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)]; return this.chunks[0] ?? Buffer.alloc(0); }

  private parse(): void {
    for (;;) {
      const b = this.take();
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      if (!masked) return this.fail(1002, 'unmasked');
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(this.limits.maxMessage)) return this.fail(1009, 'too-big'); len = Number(big); off = 10; }
      if (len > this.limits.maxMessage || this.fragBytes + len > this.limits.maxMessage) return this.fail(1009, 'too-big');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.from(b.subarray(off, off + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      const rest = b.subarray(off + len);
      this.chunks = rest.length ? [rest] : []; this.buffered = rest.length;
      if (op === 0x8) { this.frame(0x8, Buffer.alloc(0)); this.socket.end(); this.closed('client'); return; }
      if (op === 0x9) { this.frame(0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.frag.push(payload); this.fragBytes += payload.length;
        if (fin) { const text = Buffer.concat(this.frag).toString('utf8'); this.frag = []; this.fragBytes = 0; this.stats.received++; this.onmessage?.(text); }
      }
      if (!this.open) return;
    }
  }

  private frame(op: number, payload: Buffer): boolean {
    if (!this.open && op !== 0x8) return false;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    try { this.socket.write(Buffer.concat([head, payload])); return true; } catch { this.closed('client'); return false; }
  }

  /** Bytes waiting to be written to this client. */
  get backlog(): number { return (this.socket as Duplex & { writableLength?: number }).writableLength ?? 0; }

  /** Send a text message. `droppable` messages are skipped while the client is behind (the next one supersedes). */
  send(text: string, droppable = false): boolean {
    if (!this.open) return false;
    const backlog = this.backlog;
    if (backlog > this.limits.hardBuffer) { this.fail(1008, 'too-slow'); return false; }
    if (droppable && backlog > this.limits.softBuffer) { this.stats.dropped++; return false; }
    this.stats.sent++;
    return this.frame(0x1, Buffer.from(text, 'utf8'));
  }

  /** Ping if quiet; close if silent for too long. */
  heartbeat(now = Date.now()): void {
    if (!this.open) return;
    if (now - this.lastHeard > this.limits.idleMs) { this.fail(1001, 'idle'); return; }
    if (now - this.lastHeard > this.limits.idleMs / 3) this.frame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, why = 'server'): void {
    if (!this.open) return;
    this.closeReason ||= why;
    this.frame(0x8, Buffer.from([code >> 8, code & 255]));
    this.socket.end();
    this.closed(why);
  }

  private fail(code: number, why: string): void { this.closeReason = why; this.close(code, why); setTimeout(() => this.socket.destroy(), 200).unref?.(); }
}

/** The default origin policy: browser pages served from this machine (localhost, 127.0.0.1, [::1]) on any port. */
export const localOrigins = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

/** Accept WebSocket upgrades on an HTTP server (any path). */
export function acceptWebSockets(server: Server, onconn: (c: WSConn, req: IncomingMessage) => void, opts: { allowOrigin?: (origin: string) => boolean; limits?: WSLimits } = {}): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'], origin = req.headers.origin;
    if (typeof key !== 'string' || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    if (typeof origin === 'string' && opts.allowOrigin && !opts.allowOrigin(origin)) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    onconn(new WSConn(socket, opts.limits ?? DEFAULT_LIMITS), req);
  });
}
