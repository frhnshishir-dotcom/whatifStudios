# Networking

The browser talks to one authoritative world server over WebSocket (JSON, protocol 2). The server runs the same
rules engine as single player. Clients send their position and commands; the server decides everything else.

## Transport (`server/ws.ts`)

The WebSocket implementation is written in the project (RFC 6455), with no dependency. Its limits:

| Limit | Default | On violation |
|---|---|---|
| Message size (after reassembling fragments) | 1 MiB | close 1009; nothing is buffered past the limit, including oversized length headers |
| Client frames must be masked (RFC 6455 §5.1) | — | close 1002 |
| Backpressure, soft (bytes waiting to go out) | 256 KiB | snapshots to that client are skipped; the next one supersedes them |
| Backpressure, hard | 4 MiB | close 1008 (too slow) |
| Idle | 45 s | the server pings after 15 s of silence and closes after 45 s |
| Origin (browsers) | localhost, 127.0.0.1, [::1] on any port, plus `--origins a,b` | HTTP 403 before the upgrade |

Non-browser clients (no Origin header) are accepted, which bots and tests rely on. A hosted server must set
`--origins` (or `LUMENWILD_ORIGINS`) to the pages that serve the game.

## Rate limits (per connection, token buckets)

| Message | Rate / burst | Note |
|---|---|---|
| `move` | 30/s, 40 | clients send 10 a second |
| `cmd` | 30/s, 30 | attack, gather, trade… |
| `edit` | 2/s, 4 | region edits |
| `hello` | 0.5/s, 3 | |
| `ping` | 5/s, 10 | |

Excess messages are dropped and counted. More than 200 violations within 10 s closes the connection (1008).
Unreadable and unknown messages count as violations.

## Validation

- **Moves:**
  - finite numbers only;
  - no faster than running (a dodge roll a little faster);
  - not while down;
  - not into walls, rocks or water (server collision masks built from the generated regions).
  - A rejected move gets a `correct` with the server's position.
- **Commands:** applied by the rules engine (`Rpg.command`), which checks distance, ownership, cooldowns, stock,
  coins and pack space. The client never sets coins, items, damage or progression.
- **Region edits** (`server/permissions.ts`). An edit must:
  1. parse, with every index, height, object and water entry in range, and lists bounded;
  2. be within reach (the player's region or the eight around it);
  3. touch no protected ground: village footprints with a margin, landmarks and old places, road bridges;
  4. respect the region's owner, if it has one (ownership is saved, ready for housing).

  A refused edit gets `rejected {what, key, reason}`; the client shows the reason and stops re-sending until that
  region changes again. The author and time of each accepted edit are recorded and saved. A development server can
  allow edits on protected ground (`--allow-village-edits`; the two-browser test uses it to edit beside the spawn).

## Messages

These are listed in `src/world/net/protocol.ts`. Additions in M1:
- `rejected {what, key, reason}`: an unknown type to older clients, which ignore it.
- Snapshots are sent as droppable.

## Tests

- `tests/transport.test.ts`:
  - origin refused and accepted, oversized and unmasked frames, flood closing;
  - backpressure dropping and closing, idle timeout;
  - every edit rule, and a development server's village edits.
- `tests/multiplayer.test.ts` and `e2e/m17-multiplayer.spec.ts`: sessions, reconnection, combat and trade sync,
  two browsers.
- `tests/load.test.ts` and `npm run bench:server`: bots.
- `tests/acceptance/m2-seamless.test.ts` (`npm run test:accept`): 18 players across the six villages.

## Since M2

- Creatures in a snapshot come from the wildlife region index (within 600 m), not a scan of every creature.
- Rules events go to players within 120 m through a player grid ([WORLD_SIMULATION.md](WORLD_SIMULATION.md)).
- The terrain behind move checks is made on worker threads. Until a region arrives, moves there are checked against
  the coarse model.

## Next (M3)

1. Interest management by region, then delta snapshots with sequence numbers (M3).
2. Adaptive rates by distance.
3. Prediction and reconciliation for the player's own movement.
4. Shared weather.
