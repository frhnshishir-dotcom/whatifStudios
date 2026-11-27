# Persistence

What is saved, where, in which format, and how it is kept safe. The current storage is JSON. The database plan is
at the end; no database is used yet.

## Stores

| Store | Where | Format | Written |
|---|---|---|---|
| Valley saves | browser IndexedDB (`lumenwild` database; falls back to localStorage, then memory) | `lumenwild-world` v1 | on demand, autosave, export |
| Continent saves | browser IndexedDB (`lumenwild-continent` database, a separate namespace) | `lumenwild-continent` v1 | on demand, autosave every 90 s |
| World server | `server-data/world.json`; backups in `server-data/backups/` | `lumenwild-server` v3 (envelope) | every 30 s (in the background) and on shutdown |

## Payload versions (independent of the files that hold them)

| Payload | Version | Inside | Migrations |
|---|---|---|---|
| Character (`hero`) | 1 (`v`) | continent saves (`life.players[].hero`) and the server file (`players[].hero`) | 0 → 1 (unversioned characters already have the v1 shape) |
| Living world (`life`) | 1 (`v`) | continent saves and the server file | 0 → 1. Players' packs of counts (`inv`, from before characters) become items when loaded |
| Region edits | — (validated structurally) | both | — |

`src/world/migrations.ts` holds the registry. A payload from a **newer** build than the running one is refused:
- in the browser, the save does not load and says why;
- on the server, it refuses to start.

Nothing is loaded partially, so nothing is overwritten with less than was saved.

## The server file (version 3)

```
{ "format": "lumenwild-server", "version": 3, "savedAt": "...", "checksum": "<sha256 of data>", "data": { ... } }
data: { version: 2, hour, n, sessions: [{id, token, name}], players: [{id, x, y, walked, hero}], edits: {"rx,ry": RegionEditJSON},
        permissions: {owners, meta}, life: {v, t, players, discovery, wildlife, dragons, rpg, log} }
```

Version 1 and 2 files (no envelope) are still read. Fixtures written by the original commits are in
`tests/fixtures/saves/`, tested by `tests/save-compat.test.ts`.

**Writing** (`server/saveFile.ts`):
1. Serialise.
2. Write `world.json.tmp`, flush it to disk, and close it.
3. Read it back and verify the checksum and shape.
4. Back up the current `world.json` if it is time.
5. Rename the temporary file over `world.json`.

A crash at any step leaves either the old file or the new one. The periodic save runs in the background, without
blocking the server loop. Shutdown waits for it, then writes the final save.

**Backups** (`server-data/backups/`):
- `world.json.rolling-<time>.json`: at most one every 5 minutes; the newest 10 are kept.
- `world.json.daily-<date>.json`: the first save of each day; the newest 7 are kept.

These can be configured (`backups: { backupEverySec, keepRolling, keepDaily }`).

**When the save cannot be used** (unreadable, checksum mismatch, wrong shape, or newer versions inside):
- The server **does not start**. It never starts a new world over the file.
- The file is left exactly as it is, and a copy is written beside it as `world.json.corrupt-<time>`.
- The message lists the backups and how to restore:
  ```
  npm run server -- --restore-latest          # newest backup
  npm run server -- --restore <backup file>   # a specific one
  ```
- Restoring keeps the damaged file as `world.json.replaced-<time>`.

Tests: `tests/save-safety.test.ts` covers truncated, hand-edited, empty and foreign files, backups and pruning,
restoring, a leftover temporary file, overlapping saves, and characters from a newer build.

## Migration procedure (for every future format change)

1. Before changing anything, add a fixture of the current format written by the current code
   (`tests/fixtures/saves/README.md`).
2. Bump the payload version and add the migration `vN → vN+1` to the registry.
3. Test it: the fixture loads with nothing lost, and the new format round-trips.
4. Rollback: the previous build cannot read the new version (it refuses), so keep the backup made before the
   upgrade. The server's rolling and daily backups hold the old format; restore one with the previous build.

## Database plan (no dependency added yet)

The server will use a storage interface so that the file can later be swapped for a database without touching the
rules:

```
interface WorldStore {
  load(): Promise<WorldSnapshot | null>;          // throws on an unreadable store; never silently empty
  save(s: WorldSnapshot): Promise<void>;          // atomic
  transaction<T>(f: (tx: Tx) => Promise<T>): Promise<T>;  // trades, purchases: all at once or nothing
}
JsonFileStore   (today's file, as above)
SqliteStore     (local development, M6, after approval of the dependency)
PostgresStore   (production, M6/M7, after approval)
```

The tables mirror the JSON:
- accounts and characters (the hero JSON with version);
- inventory items (rows keyed by item uid);
- regions (edits, owners, edit authors);
- creatures and dragons;
- trades (a ledger with idempotency keys).

The future account model separates:
- **account identity** (login);
- **characters** (an account owns several);
- **sessions** (tokens, hashed, expiring);
- **character progression** (hero);
- **shared world data** (regions, creatures, dragons).

Today's browser token is **not** authentication. It identifies a session on a local server and nothing more.
