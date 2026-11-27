# RPG visibility and UI integration: audit and proposal

Date: 2026-11-27. Branch `claude/ascii-pointcloud-engine-fz3w62` at a9e0656. Phase 1 and Phase 2 only: no application
code was changed for this report.

![Continent mode today, 1366 × 768](rpg-ui-before-1366x768.jpg)

*Continent mode today (1366 × 768, the common laptop size). The sandbox editor's chrome surrounds the world: the
tool rail (Edit / Land / Water / Plants / Rock / Build), undo and redo, and render statistics. The RPG is a row of
11 px tabs in the right-hand inspector, under the travel controls. The character HUD is the small grey box at the
bottom left. The player is the `@` in the middle of the village.*

## Phase 1: findings

### 1. How RPG mode is entered

There is no RPG mode. The RPG is part of **continent mode**:
- The **Continent** button in the top bar reloads the page with `?scene=continent` (`src/ui/components/TopBar.tsx:27`).
- `src/main.tsx:16` builds the continent engine.
- `src/boot.ts:77` attaches the living world (`new LivingWorld(engine, session)`). That object holds the character,
  the rules engine (`Rpg`), the wildlife, the villagers and the dragons.
- The store only knows `mode: 'continent' | 'valley'` (`src/ui/store.ts:109`).

### 2. Separate game state, or only behaviour?

Only behaviour, inside the editor's layout:
- `App.tsx` renders the same chrome in both modes: `TopBar`, the editing `Toolbar`, the `Inspector` and the
  statistics `BottomBar`.
- The continent swaps the world and adds a `ContinentPanel` to the top of the inspector
  (`src/ui/components/Inspector.tsx:17`).
- The RPG panel lives inside that panel (`ContinentPanel.tsx:93`).
- No UI state says "playing" as opposed to "editing". The terrain tools stay active in the continent.

### 3–6. Systems: implemented, operational, visible?

**Implemented and operational.** These are tested:
- Rules: `src/world/rpg/Rpg.ts` (736 lines); character: `hero.ts`; items: `items.ts`; content: `content.ts`.
- Unit tests: `tests/rpg.test.ts` (10), `tests/life.test.ts`, `tests/regressions.test.ts` (a bear fight with loot),
  `tests/save-compat.test.ts` (a character restored exactly).
- Browser test: `e2e/m19-rpg.spec.ts` ("fight, loot, equip, quest, shop, level up; the character survives save and
  reload"). It passes locally and in CI run 7.

What each system has on screen:

| System | Data and rules | On screen today | Connected? |
|---|---|---|---|
| Health, stamina | `hero.hp`, `player.stamina` | HUD bars, bottom left (`src/world/rpg/hud.ts:41-50`), 8 px tall, 12 px monospace | Yes: updated every frame (`client.ts:424`) |
| Level, XP | `hero.level`, `hero.xp`, `xpToNext` | HUD XP bar and "Lv N"; Hero tab "N · x/y xp" (`RpgPanel.tsx:54`) | Yes |
| Level-up | `level` event | A rising "Level N!" and the toast line (`client.ts:353`) | Yes, but brief and small |
| Character name | `player.name` (saved in `life.players[]`, `LifeSim.ts:222`) | **Not shown anywhere.** Offline it is always "Traveller" (`client.ts:263`) | No |
| Combat feedback | `hit`, `hurt`, `evade`, `kill` events | Floating numbers, gold criticals, red hurt flash, "dodged" (`client.ts:348-351`) | Yes |
| Creature health | `creature.hp` (offline); snapshot health fraction (online) | 30 px bars over **wounded** creatures within 60 m only (`client.ts:383-395`). No name, no target frame | Partly |
| Inventory, equipment | `hero.inv`, `hero.equip`, `equip`/`use`/`drop` commands | Pack tab: a text list with Equip, Use, Sell and Drop buttons (`RpgPanel.tsx:85-110`) | Yes, but text only, no slots or icons |
| Attributes, skills | `hero.attrs`, `hero.points`, `hero.skills` | Hero tab: numbers, "+" buttons, 4 px skill bars (`RpgPanel.tsx:49-82`) | Yes |
| Quests | `hero.quests`, `view.offer`, `accept`/`abandon` | Quests tab (`RpgPanel.tsx:113-140`); "!" / "?" / "◆" over villagers in the world (`client.ts:363-374`, `202-203`) | Yes; **no on-screen tracker** |
| NPC interaction | `talk` command (`Rpg.ts:394-417`) | The E prompt (bottom centre), then **one line in the top toast**. A quest offer says "Accept in the Quests tab" | Weak: no dialogue window; acting on an offer means finding a tab |
| Shops | `view.shop`, `stock`, `buy`/`sell` | Shop tab, opened automatically on talking to a trader (`client.ts:544`) | Yes, but in the side panel |
| Player trading | `offer`/`trade`, `view.offers` | Trade tab, online only (`RpgPanel.tsx:20`) | Yes (online) |
| Crafting | `craft`, `RECIPES`, stations | Craft tab | Yes |
| Map, exploration | `sim.discovery` (saved), `hero.found`, `observe()` | Map dialog: blueprint, "Player view **at start**" (`ContinentDialog.tsx:155`, `BlueprintView.tsx:169`). It draws a fixed starting state, **not the character's real discovery or position**. "Discovered: …" toasts appear | **Disconnected** |
| Death | `hero.dead`, `respawn` | Full-screen red veil, "You have fallen…" (`hud.ts:96`) | Yes |
| Saving | `life.toJSON()` in continent saves (`src/ui/persistence.ts:93-94, 122-123`) | — | Yes: level, items, quests and skills survive a reload (m19, save-compat) |
| Multiplayer | Server-authoritative `Rpg` | The client shows server state: `welcome`/`hero` messages run `heroFromJSON` and replace `view` (`NetClient.ts:73, 86`). Every UI action is a command (`client.ts:310-315`) | Yes |

### 7. Hidden, disconnected, inaccessible or not implemented?

All four, depending on the feature:

1. **Hidden by layout.**
   - The RPG panel is the 4th–5th item down the editor's inspector.
   - Below 900 px wide the inspector is hidden entirely (`src/styles.css:77`; `inspectorOpen` defaults to false,
     `store.ts:83`). Measured at 820 × 1180: the RPG panel is not shown at all.
   - The I, C, J and K keys only change which tab is selected (`client.ts:286-287`). With the inspector hidden,
     pressing them does nothing visible. With it shown, the change is a highlighted 11 px button.
2. **Presented as developer tooling.**
   - The world is framed by terrain-editing tools and frame statistics.
   - The HUD uses the debug monospace font in a plain grey box.
   - Nothing on screen says "you are playing a character".
3. **Disconnected.** The map's player view does not use the character's discovery. Online, the client keeps no
   discovery state of its own (the server holds one discovery for the whole world).
4. **Not implemented.**
   - a dialogue window;
   - an on-screen quest tracker;
   - a target frame for the creature being fought;
   - the character's name on screen;
   - a level-up banner;
   - a way to name the character offline.

The data model and rules are complete and tested. What is missing is the **presentation layer** and a **play
layout**.

## Phase 2: proposed RPG interface

### Principles

- **Connect, don't duplicate.** Every number on screen is read from the existing objects:
  `LivingWorld.player.hero`, `lw.view()`, `lw.sim`, and the RPG events `lw.processEvents()` already handles. Every
  action is an existing `RpgCmd` sent through `lw.command()`: applied at once offline, sent to the server online.
  No new game state, rules or save fields.
- **The world stays the stage.** The HUD sits over the canvas and lets clicks through. Windows open over the world
  without pausing or replacing it. The character-cell renderer, the Valley and its golden images are untouched.
- **No placeholder features.** A button exists only where the action exists. For example, "Trade" appears in a
  dialogue only when that villager has a shop or a player is in range.

### Play layout (continent mode only)

- Continent mode opens in **Play**:
  - the editing tool rail, the statistics bar and the editor sections of the inspector are hidden;
  - a slim top bar keeps the world name, save, map and menu.
- A **Sandbox** toggle in the top bar restores today's editor layout, so terrain editing, travel controls, renderer
  settings and benchmarks stay available. **B** switches between the two.
- The Valley is unchanged.

### HUD (always on in Play)

| Element | Place | Content (source) |
|---|---|---|
| Character plate | bottom left | Name (`player.name`); level crest; health with numbers; stamina; XP bar with "x / y" (`hero`, `xpToNext`). A dot when attribute points are unspent |
| Target frame | top centre | The creature you fight or last hit: species, health bar, a hostile mark (creature `hp`/`foe` offline; snapshot health fraction online). It fades when the fight ends |
| Combat text | over the world | The existing floating numbers (`Hud.float`), restyled: white hits, gold criticals, red damage taken, blue "dodged", gold "+xp" |
| Level-up banner | upper centre | "Level 4" with a short gold flourish, and "2 attribute points — Character (C)" (`level` event) |
| Quest tracker | right edge | Active quests: title, objective, progress, "Return to Mira" when ready (`hero.quests`) |
| Notifications | upper left | Messages, discoveries and quest updates fade in and out (`msg`, `quest`, `skill` events; `sim.log`) |
| Interaction prompt | bottom centre | The existing E prompt, restyled (`lw.interaction()`) |
| Key hints | bottom right | Only when no window is open; can be dismissed |
| Fallen veil | full screen | Existing behaviour, restyled |

### Windows (open over the world; Esc closes)

| Window | Key | Content | Actions (existing commands) |
|---|---|---|---|
| Character | C | Attributes with point spending; derived attack, armour and critical chance; skills with progress; statistics; home | `spend` |
| Inventory | I | An equipment doll (weapon, armour slots), the pack's 24 slots with rarity colours and item tooltips, and coins | `equip`, `unequip`, `use`, `drop` |
| Journal | J | Active quests with objectives and rewards, the completed count, and the world journal (`sim.log`) | `abandon` |
| Crafting | K | Recipes, with what you have against what you need and the stations within reach | `craft` |
| Map | M | The blueprint with **live** fog from the character's discovery, the player's position and bearing, discovered places, and villages | Travel stays in Sandbox |

### NPC dialogue and trading

- Pressing **E** at a villager opens a **dialogue card**: name, role and their line, taken from the `talk` reply.
- The options come from the real state:
  - **Accept the work** when `view.offer` is set (`accept`); declining just closes the card;
  - **Hand in** is not a separate button: the rules complete a quest when you talk to its giver, so the card shows
    their thanks and the reward;
  - **See their wares** when `view.shop` is set: this opens the Trade window;
  - **Goodbye**.
- **Trade window:** the villager's stock with prices on one side and your pack with sell prices on the other
  (`buy`, `sell`). Online, offers from nearby players and a player-trade form appear (`offer`, `trade`).
- Online, the card fills in when the server's reply arrives. The client never decides the outcome.

### Visual direction

**Colours:**
- surfaces: charcoal `#111412` and deep forest `#13211a`, about 92 % opaque, with a soft inner shadow;
- borders: 1 px muted gold `#b8975a` at 35–60 %;
- text: parchment `#e9e2cf`, secondary `#a9a28f`;
- bars: health `#b8433a`, stamina `#4f8fa8`, XP muted gold.

**Type:**
- headings: a system serif (Iowan Old Style, Palatino, Georgia), so no new font dependency;
- body: the system UI sans at 13–14 px;
- numbers: tabular figures.

**Magic, kept small:**
- a faint gold rule under window titles;
- a slow shimmer on the XP bar when a level is near;
- a brief glow on level-up.

**Motion:** 120–200 ms fades and slides, turned off under `prefers-reduced-motion`.

**Accessibility:**
- contrast at least 4.5 : 1 for text;
- every window reachable by keyboard, with focus returned to the world on close;
- aria labels on bars ("Health 62 of 78");
- usable at 820 px wide: the HUD stacks, and windows become sheets.

## Proposed implementation sequence

| Step | What | Tests |
|---|---|---|
| 1 | **Live binding.** `LivingWorld` gets a revision counter, raised by `processEvents`, `command` and the network client's `hero`/`welcome` messages. A small React hook `useLife()` re-renders on it, plus 10 Hz for the bars. No rule or data changes | Unit: the revision rises on events offline and on server messages online |
| 2 | **Play / Sandbox layout** in continent mode (B and a top-bar toggle); the Valley unchanged | Browser: Play hides the editor tools, Sandbox restores them; existing continent tests run in Sandbox where they test sandbox features |
| 3 | **HUD:** character plate, target frame, quest tracker, notifications, level-up banner. The floating text and health tags in `Hud` restyled; its test ids kept (`hud`, `hud-hp`, `hud-level`, `hud-prompt`, `hud-toast`, `hud-veil`, `hud-float`) | Browser: values equal `lw.player.hero` before and after damage, XP gain and a level-up |
| 4 | **Windows:** Character, Inventory, Journal, Crafting. The inspector's `RpgPanel` stays in Sandbox, so nothing is lost | Browser: equipping changes the equipment and derived stats; using food heals; spending a point raises the attribute |
| 5 | **Dialogue card and Trade window** | Browser: talk → offer → accept → tracker shows the quest; trader → wares → buy and sell change coins and pack |
| 6 | **Live map** (offline: `sim.discovery`; online: discovery tracked on the client from the character's own position, for display only) | Browser: the map's revealed area grows after walking |
| 7 | **Acceptance test** for criteria 1–10 through the new UI. `m19-rpg` updated to drive the new windows with the same assertions | Plus online: the HUD follows server-sent health and XP; a command the server refuses changes nothing |
| 8 | **Verify:** typecheck, build, unit tests, all browser tests with the Valley goldens pixel-exact, multiplayer tests. Screenshots at 1366 × 768, 1920 × 1080 and 820 wide, reviewed by eye | — |

### Not changed by this work

- the rules (`Rpg.ts`, `hero.ts`, `items.ts`, `content.ts`);
- save formats and versions;
- the protocol and server authority;
- the renderer, the Valley and its golden images;
- dragons, wildlife, biomes, water and streaming.

### Decisions for approval

1. Continent mode **opens in Play** with the editor behind a Sandbox toggle. The alternative is opening in Sandbox
   with a Play toggle.
2. **Headings in a system serif**, which needs no dependency. The alternative is adding a free OFL webfont package,
   such as Cormorant Garamond.
3. **Naming the character offline:** a "Name your traveller" field on the Character window. The name is already
   saved in continent saves. Online, the name comes from joining, as now.
