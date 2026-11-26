# RPG systems (Phase 5): character, combat, items, crafting, economy, quests, multiplayer

These run in continent mode (`?scene=continent`) in single player, or online against the local world server. The
Valley is unchanged: its golden images, including the dragon, still match.

## Play

| Key | Action |
|---|---|
| WASD, Shift | walk; run (uses stamina) |
| Space (hold) | attack; turns toward the nearest creature in reach |
| Q | dodge roll: a dash with a moment of invulnerability (uses stamina) |
| H | eat or drink the best healing item for the damage taken |
| E | the action shown in the on-screen prompt (see below) |
| F | watch the nearest dragon |
| I / C / J / K | open the Pack, Hero, Quests or Craft tab |

The E prompt picks, in this order:
1. loot you stand on;
2. a villager: the one waiting for your quest, then one with work, then a shop;
3. loot nearby;
4. a find (chest, herbs, ore, relic);
5. an old place (climb a tower, search a ruin or cave, read a stone);
6. gathering: cut wood, break rock, pick mushrooms.

Villagers show a yellow `!` when they have work, `?` when your quest is done, and a blue `◆` for a shop.

## Systems

**Character** (`src/world/rpg/hero.ts`)
- Levels 1–30 from experience, with 2 attribute points per level to spend on Strength (damage), Agility (attack
  speed, criticals) and Vitality (health, regeneration).
- Health regenerates out of combat; stamina is used by running, attacks and dodges.
- 12 skills improve with use: melee, defence, hunting, foraging, woodcutting, mining, smithing, crafting, cooking,
  trading, exploration and athletics. Each changes its numbers: more damage, cheaper dodges, more loot, better ore
  chances, better crafted rarity, better prices.
- Statistics: kills by species, falls, items crafted, gathered, bought and sold, quests completed, places found,
  damage dealt and taken.

**Combat** (`Rpg.ts`, with the existing creature AI in `wildlife.ts`)
- Creatures have health. A new `fight` state makes them close in and bite on a cooldown.
- Wolves and bears fight back when hurt, and the pack joins in. Wolves hunt a lone traveller at night, or when
  hungry. A bear fights a player who enters its territory; villagers it only charges, to scare them off.
- Deer, foxes and birds run. Wounded animals slow down, so a hunter can run them down.
- Damage depends on the weapon, its rarity, Strength, melee skill and bonus properties. Criticals depend on Agility.
  Armour and defence skill reduce damage taken.
- A dodge makes bites miss.
- A fallen traveller drops 10% of their coins, wakes in their home village (the last village visited) with full
  health, and can go back for the purse.
- Creatures come back after 10 minutes when nobody is near. Caves and ruins raise guardians: wolves, or a bear in
  the Elderwood and the Dragon Peaks.

**Items** (`items.ts`)
- 46 items: weapons, armour for six slots (weapon, head, body, hands, feet, trinket), trinkets, resources, food and
  potions.
- Rarity runs Common, Uncommon, Rare, Epic, Legendary. From Rare up, items roll bonus properties: health, critical
  chance, regeneration, damage, armour, stamina use.
- The pack has 24 slots, and stacks hold up to 50.
- Loot drops in bags. A bag belongs to whoever made the kill for 30 s, then to anyone, and disappears after 5 min.
- Items can be used, equipped, dropped, sold or traded.

**Gathering and crafting**
- Trees give wood, more with an axe.
- Rocks give stone, and ore only with a pickaxe.
- Mushrooms and finds can be taken. Nodes are used up and grow back after 10 minutes.
- There are 23 recipes at four village stations: the smithy's forge, a workbench (workshop, woodcarver), a hearth
  (inn, tavern, longhouse, fire pit) and the herbalist's table. Two recipes can be made anywhere.
- Crafting skill raises the chance of a better rarity.

**Economy**
- Eleven trades keep shops: blacksmiths, merchants, traders, herbalists, innkeepers, cooks, carpenters,
  woodcarvers, hunters, trappers and brewers. Their stock is deterministic and restocks every 10 minutes.
- Item value scales with rarity and bonus properties. A shop buys at 25%, or 50% for what it wants, and sells at
  130%; trading skill improves both prices.
- Players can trade with each other: one player offers items and coins and asks a price; the other accepts or
  declines. The swap is checked and happens all at once or not at all.

**Quests**
- Villagers whose job gives work offer one quest at a time, generated deterministically per giver and per player.
- Six kinds:
  - bounties (wolves, foxes, a bear);
  - gathering;
  - craft and bring;
  - explore a named ruin, cave, tower or stone;
  - sight a dragon (get within 500 m);
  - carry a parcel to another village.
- Discovering places and villages gives experience. Quest progress, completions, the places found and the home
  village are saved.

**Dragons**
- The continent's five dragons each have their own palette and size:
  - Aurath: storm blue, the largest;
  - Emberfang: obsidian and crimson;
  - Rimeclaw: frost white;
  - Mossheart: forest green, smaller;
  - Ashmaw: ash and violet, with a green glow.
- All five have a longer, more articulated wing (a third finger bone), a lit leading edge, and roll into turns.
- The Valley dragon keeps the classic look.

**Saves**
- The continent save holds the character and the world's RPG state (taken finds, used-up nodes, loot, guardians).
- Old saves load: their pack counts become items.
- The world server keeps every player's character in its session, including while they are away, and writes it to
  its file.

## Multiplayer

The server is authoritative (`server/WorldServer.ts`), running the same rules engine.
- **Players and moves:**
  - Each player is kept in its session; tokens resume a session.
  - Moves are checked against speed, walls, rocks and water, and corrected when wrong.
  - Players dropped from the world after a minute away come back in place when they reconnect.
- **Commands and events:**
  - Every RPG action is a command decided by the server, with a flood limit.
  - Events go to the player who acted and to everyone within 120 m: hits, kills, swings, dodges, falls, respawns.
- **Sync:**
  - A player's character is sent whenever it changes.
  - Snapshots carry the health of creatures and players, and the loot on the ground.
  - Clients smooth everything the server moves between snapshots.
- **Protocol:** version 2; a client with the wrong version is told to reload.

Run `npm run server`, then open `?scene=continent&server=ws://localhost:8787&name=Ada`.

Tested:
- `tests/multiplayer.test.ts` (Node clients):
  - shared world, edits, a contested find;
  - wall and speed corrections;
  - restart persistence of characters;
  - networked combat, loot ownership, a trade, and a server-side respawn.
- `e2e/m17-multiplayer.spec.ts` (two browsers): each sees the other walk and swing, names over heads, characters
  from the server, an edit, reconnection.
- `tests/load.test.ts` (`npm run loadtest`): 16 bot clients for 20 s.

## Measurements

These were measured in the cloud container: SwiftShader software rendering, 1280×800. They are not laptop numbers.

| What | Result |
|---|---|
| Single player, RPG tour (fights, village, dragon) | 60 fps; compose 1.2–2.0 ms; living world and RPG 0.5–1.6 ms per frame; JS heap 73–104 MB |
| Two browsers and the server in one container, recording both | 34–60 fps per browser; server tick 1.1–1.7 ms |
| 16 bots for 20 s | server tick 2.0 ms average, 3.0 ms p95, 18.6 ms maximum; 31.8 KB/s per client; 100 snapshots per bot |

## Screenshots

These are the seven `docs/world/rpg-*.jpg` files.

| File | What it shows |
|---|---|
| `rpg-quest.jpg` | A quest offer |
| `rpg-fight.jpg` | A wolf fight: HUD, damage numbers, swing marks |
| `rpg-pack.jpg` | The Pack tab after looting |
| `rpg-shop.jpg` | The blacksmith's shop |
| `rpg-hero.jpg` | The Hero tab: attributes and skills |
| `rpg-dragons.jpg` | The five dragons side by side |
| `rpg-trade.jpg` | A trade offer between two browsers |

## Known limitations

- **Not measured on the target laptop.** An Inspector → Benchmark export from it is needed.
- **Combat:**
  - melee only: no ranged weapons and no block;
  - no player-versus-player;
  - dragons neither fight nor can be fought;
  - creature tactics are simple (close in and bite).
- **Quests** are generated from six templates, with no dialogue trees or story arcs.
- **Economy:**
  - fixed shop prices, adjusted only by skill;
  - player trade is one offer with a price, with no counter-offers and no market.
- **Online:**
  - JSON snapshots (about 32 KB/s per client; no delta compression);
  - no client-side prediction for hits: your own swing shows at once, its result after a round trip;
  - the server's collision ignores player edits;
  - no accounts beyond tokens, no TLS, a single process.
- **Dragons** are drawn no more than 36 m above the ground.

**This is a playable RPG prototype with a working multiplayer foundation. It is not a finished MMORPG.**

## Next milestone (proposed)

1. **Combat depth:** ranged weapons (bow and thrown spear), blocking, and creature special attacks. Dragon
   encounters near nests: territorial attacks, not a stationary boss.
2. **Story:** dialogue with choices, quest chains per village, named rare creatures.
3. **Online scale:**
   - binary, delta-compressed snapshots;
   - client prediction for combat;
   - player edits applied on the server;
   - a cloud hosting plan for approval.
4. **Laptop benchmark,** then performance budgets tuned to it.
