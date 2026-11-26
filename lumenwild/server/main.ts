import { WorldServer } from './WorldServer';

/**
 * Local world server: `npm run server` (port 8787, state in server-data/world.json).
 * Options: --port N, --data FILE (or "none"). Ctrl+C saves and stops.
 */
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const port = Number(arg('--port') ?? process.env.PORT ?? 8787);
const data = arg('--data') ?? 'server-data/world.json';
const server = new WorldServer({ port, dataFile: data === 'none' ? null : data, log: (s) => console.log(`[world] ${s}`) });
server.listen().then((p) => console.log(`[world] Lumenwild world server on ws://localhost:${p} (state: ${data})`));
const stop = () => { console.log('[world] saving and stopping'); void server.stop().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
