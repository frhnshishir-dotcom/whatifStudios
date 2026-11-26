import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * A small WebSocket server (RFC 6455) for the local game server: text frames, fragmentation, ping/pong and close.
 * No dependencies. Clients are browsers or Node's built-in WebSocket.
 */
export class WSConn {
  onmessage: ((text: string) => void) | null = null;
  onclose: (() => void) | null = null;
  open = true;
  private buf = Buffer.alloc(0);
  private frag: Buffer[] = [];

  constructor(private socket: Duplex) {
    socket.on('data', (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    socket.on('close', () => this.closed());
    socket.on('error', () => this.closed());
  }

  private closed(): void { if (!this.open) return; this.open = false; this.onclose?.(); }

  private parse(): void {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const mask = masked ? b.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + len);
      if (op === 0x8) { this.frame(0x8, Buffer.alloc(0)); this.socket.end(); this.closed(); return; }
      if (op === 0x9) { this.frame(0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.frag.push(payload);
        if (fin) { const text = Buffer.concat(this.frag).toString('utf8'); this.frag = []; this.onmessage?.(text); }
      }
    }
  }

  private frame(op: number, payload: Buffer): void {
    if (!this.open && op !== 0x8) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    try { this.socket.write(Buffer.concat([head, payload])); } catch { this.closed(); }
  }

  send(text: string): void { this.frame(0x1, Buffer.from(text, 'utf8')); }
  close(): void { if (!this.open) return; this.frame(0x8, Buffer.alloc(0)); this.socket.end(); this.closed(); }
}

/** Accept WebSocket upgrades on an HTTP server (any path). */
export function acceptWebSockets(server: Server, onconn: (c: WSConn, req: IncomingMessage) => void): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    onconn(new WSConn(socket), req);
  });
}
