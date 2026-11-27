import { WorldServer } from './WorldServer';
import { SaveLoadError } from './saveFile';

/**
 * Local world server: `npm run server` (port 8787, state in server-data/world.json, backups in server-data/backups/).
 * Options: --port N, --data FILE (or "none"), --restore-latest | --restore BACKUP_FILE, --origins a,b (allowed web
 * page origins; default: localhost and 127.0.0.1 on any port), --allow-village-edits (development: let players
 * change villages and landmarks). Ctrl+C saves and stops.
 */
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (k: string) => process.argv.includes(k);
const port = Number(arg('--port') ?? process.env.PORT ?? 8787);
const data = arg('--data') ?? process.env.LUMENWILD_DATA ?? 'server-data/world.json';
const restore = has('--restore-latest') ? 'latest' : arg('--restore');
const origins = (arg('--origins') ?? process.env.LUMENWILD_ORIGINS)?.split(',').map((s) => s.trim()).filter(Boolean);
let server: WorldServer;
try {
  server = new WorldServer({ port, dataFile: data === 'none' ? null : data, restore, origins, allowVillageEdits: has('--allow-village-edits'), log: (s) => console.log(`[world] ${s}`) });
} catch (e) {
  if (e instanceof SaveLoadError) {
    console.error(`[world] ${e.message}`);
    if (e.backups.length) console.error(`[world] Backups (newest first):\n${e.backups.slice(0, 10).map((b) => `  ${b}`).join('\n')}`);
    process.exit(2);
  }
  throw e;
}
server.listen().then((p) => console.log(`[world] Lumenwild world server on ws://localhost:${p} (state: ${data})`));
const stop = () => { console.log('[world] saving and stopping'); void server.stop().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
