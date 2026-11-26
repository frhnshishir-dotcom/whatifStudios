# Living world and multiplayer foundation (Phase 4)

Continent mode only (`?scene=continent`). The Valley is unchanged (its golden images still match).

## Play

| Key | Action |
|---|---|
| W A S D | walk (4 m/s) |
| Shift | run (8 m/s, uses stamina) |
| E | interact: talk to a villager, take a find, climb a tower, search a ruin or cave, read a stone |
| F | watch the nearest dragon (the view goes to it); press F or move to come back |

The continent panel shows stamina, the pack, who is nearby, the E prompt, the five dragons (with Watch buttons) and a
journal of what happened near you.

## What is alive

| System | Behaviour | Code |
|---|---|---|
| Wildlife: deer, wolves, bears, foxes, birds | Spawned deterministically per 512 m cell in their habitats. Needs (hunger, thirst, energy, stamina), grazing, drinking at real water, sleeping in their own hours, herds and packs following leaders, predators hunting prey, fleeing from predators, villagers, players and low dragons (sleeping animals notice threats at half the distance), bears and wolves charging intruders near their den. Each creature keeps its identity in saves. | `src/world/life/wildlife.ts` |
| Villagers in all six villages | People generated from each village's buildings (homes, workplaces, jobs by culture). Daily schedule: home at night, work (farming, fishing, trading, forging, milling, crafting and more) along the village lanes, midday and evening gatherings with chats, shelter from rain, flight from close dragons and predators. They greet the player. | `src/world/life/villagers.ts` |
| Five dragons | Autonomous 3D flight with steering. They take off, patrol, land and rest at their nests, sleep at night, drink, hunt (dive on real wildlife), defend their nest, circle travellers in their territory, and migrate along the blueprint routes. They keep terrain clearance and fly at least 450 m above ground within 2.5 km of villages. Drawn by the existing dragon renderer. | `src/world/life/dragons.ts` |
| Exploration | Watchtowers (climbing reveals 3 km of the map), ruins, caves, standing stones and finds (chests, herbs, ore, relics) generated at landmarks and in regions. The explored map and the pack are saved with the continent save. | `src/world/terrain.ts` (`places`), `src/world/life/client.ts` |

**Simulation by distance** from the nearest player: full behaviour in the loaded 768 m window (10 Hz), a cheap 1 Hz
update staggered across ticks within 2.6 km, and dormant beyond that. Creatures are found through a spatial hash. The
whole world simulation runs in Node too (it uses a `TerrainQuery` interface: `WindowQuery` in the browser, generated
regions on the server).

## Multiplayer (local, foundation)

```
npm run server                        # world server on ws://localhost:8787, state in server-data/world.json
npm run dev                           # then, in two browsers or profiles:
http://localhost:5180/?scene=continent&server=ws://localhost:8787&name=Ada
http://localhost:5180/?scene=continent&server=ws://localhost:8787&name=Bram
```

- **Authoritative server** (`server/`): one Node process with its own WebSocket implementation and no new
  dependencies. It runs the same `LifeSim`: wildlife, villagers and dragons at 10 Hz. It sends each client a 5 Hz
  snapshot of what is near that client, holds the shared region edits, and decides who gets each find (first request
  wins). It saves to a JSON file every 30 s and on Ctrl+C.
- **Sessions:** a token stored in the browser resumes the same player after a reload or a dropped connection. The
  client reconnects by itself.
- **Validation:** moves faster than running are rejected and the player is snapped back. Finds are decided on the
  server.
- **Edits:** a client sends changed region diffs every 3 s. Other clients merge them and rebuild their window if that
  region is loaded.
- **Protocol:** `src/world/net/protocol.ts` (JSON messages: hello, move, edit, take, ping / welcome, snap, edit,
  took, denied, joined, left).
- **Cost:** none. It runs locally. Nothing is deployed.

**Tested with independent clients against one shared server:**
- `tests/multiplayer.test.ts`: three Node clients. It checks that:
  - they see each other move;
  - a too-fast move is refused;
  - they get the same dragons and creatures;
  - edits are relayed;
  - a contested find goes to the first player;
  - a token reconnect resumes the same player;
  - after a server restart, the pack, the edit and the taken find survive.
- `e2e/m17-multiplayer.spec.ts`: two separate browser contexts. Each sees the other walk; both see the same dragons
  and Lumenfall's villagers placed by the server; one player's terrain edit reaches the other; a reload resumes the
  same player.

## Measurements

These were measured in the cloud container: headless Chromium with SwiftShader (software GL) at 1280×800. They are
**not** laptop numbers; the target laptop has not been measured yet.

| Where | fps | compose | life layer | wildlife tick | villager tick | JS heap |
|---|---|---|---|---|---|---|
| Lumenfall at 09:30 (30 villagers on screen) | 60 | 1.4–2.3 ms | 0.1–1.2 ms | 0.7 ms | 0.3 ms | 69–73 MB |
| Fields, two foxes nearby | 60 | 1.0–1.3 ms | 0.1–1.1 ms | 0.35–0.5 ms | 0.25–0.4 ms | 69–73 MB |
| Watching Emberfang (dragon drawn) | 50–60 | 4–11 ms | 0.1–1.3 ms (one 3.7 ms spike) | 0.3–0.5 ms | 0.6 ms | 69–73 MB |

- Around Lumenfall there are 61 villagers and about 400 creatures within 2.6 km: 12–23 detailed and the rest coarse.
- Node server: a 10 Hz tick takes about 1.4 ms with three clients.

## Screenshots

These are the five `docs/world/living-*.jpg` files.

| File | What it shows |
|---|---|
| `living-village.jpg` | Lumenfall at mid-morning. Villagers (▲ with heads) at work: traders (◆), smiths (✶). The traveller is `@`. |
| `living-foxes-asleep.jpg` | Two foxes asleep at noon (they are active at night), seen from 30 m. |
| `living-foxes-alert.jpg` | Foxes noticing the traveller (`!`). |
| `living-dragon.jpg` | Watching Emberfang migrate across the Heartlands (F). |
| `living-multiplayer.jpg` | Ada's screen (blue): Bram (orange), another browser on the same server, among the villagers. |

## Known limitations

- **Not yet measured on the target laptop** (Intel integrated graphics, 8 GB). An Inspector → Benchmark export from
  it is needed.
- **Villager movement:** villagers follow lane routes without collision against buildings, so they can clip building
  corners.
- **Server terrain:** the server's terrain query treats only water as blocked (no buildings or trees). Server-side
  animals and villagers can pass through structures, and server move validation checks speed only.
- **Dragon drawing:** dragons are drawn at no more than 36 m above the ground (true altitude is up to about 450 m
  near villages), and all dragon puppets share one palette.
- **Creature sprites:** creatures are small glyph sprites (2–4 cells; birds 1 cell), readable at zoom levels 4–8.
- **Online mode is basic:**
  - Other players are not interpolated between 5 Hz snapshots.
  - There is plain `ws://` with no TLS and no accounts beyond tokens, in a single process.
  - The explored map is not synced: towers reveal only for the player who climbs them.
  - An edit received for a loaded region rebuilds the whole window (a short hitch).
- **Not implemented:** player progression (skills and levels), combat, crafting, a trade economy and quests. Villager
  trading and crafting are scheduled activities, not an economy. **This is not an MMORPG yet.**

## Next milestone (proposed)

1. **Player progression and interaction depth:**
   - skills that grow with use (foraging, mining, tracking, climbing);
   - trading finds with villagers for coins and tools;
   - simple crafting;
   - a per-player explored map, synced online.
2. **Multiplayer hardening:**
   - server collision from the generated regions' solids;
   - interpolation of other players;
   - per-cell edit operations instead of whole-region diffs;
   - a protocol version check;
   - a load test with 10–20 bot clients.
3. **Laptop verification:** a benchmark export from the target machine, then budgets tuned to it.
