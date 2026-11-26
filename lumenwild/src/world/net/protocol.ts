import type { RegionEditJSON } from '../edits';
import type { RpgCmd, RpgEvent, RpgView } from '../rpg/Rpg';

/**
 * Messages between game clients and the authoritative world server (JSON over WebSocket).
 *
 * Client -> server
 *   hello   {name, token?, v}          join, or resume a session with its token (v: protocol version)
 *   move    {x, y, h, run}             the player's position (checked: speed, walls, water; corrected if wrong)
 *   edit    {key, edit}                a region's changes (key "rx,ry"; null clears them)
 *   cmd     {cmd}                      an RPG command (attack, dodge, gather, craft, buy, talk, trade...)
 *   ping    {t}
 *
 * Server -> client
 *   welcome {id, token, x, y, hero, edits, taken, hour, t, v}
 *   snap    {t, hour, me, players, dragons, creatures, villagers, loot}   ~5 per second, what is near this player
 *   hero    {hero, view}               this player's character and panel state, when they change
 *   ev      {evs}                      rules events near this player (hits, kills, ...) and its own (xp, messages...)
 *   correct {x, y}                     the server did not accept a move (or moved the player: respawn)
 *   taken   {ids}                      finds taken since the last message
 *   edit    {key, edit, by}            another player's changes
 *   joined / left {id, name} · pong {t} · error {reason}
 */

export const PROTOCOL = 2;

export type ClientMsg =
  | { type: 'hello'; name: string; token?: string; v?: number }
  | { type: 'move'; x: number; y: number; h: number; run: boolean }
  | { type: 'edit'; key: string; edit: RegionEditJSON | null }
  | { type: 'cmd'; cmd: RpgCmd }
  | { type: 'ping'; t: number };

/** [id, name, x, y, heading, running, health share, down] */
export type SnapPlayer = [string, string, number, number, number, number, number, number];
/** [id, name, x, y, alt, heading, state] */
export type SnapDragon = [string, string, number, number, number, number, string];
/** [id, species, x, y, alt, heading, state, alive, health share, fighting] */
export type SnapCreature = [string, string, number, number, number, number, string, number, number, number];
/** [id, x, y, heading, state, activity, outdoors] */
export type SnapVillager = [string, number, number, number, string, string, number];
/** [id, x, y, label] */
export type SnapLoot = [string, number, number, string];
/** [health, stamina, down] */
export type SnapMe = [number, number, number];

export type ServerMsg =
  | { type: 'welcome'; id: string; token: string; x: number; y: number; hero: Record<string, unknown>; edits: Record<string, RegionEditJSON>; taken: string[]; hour: number; t: number; v: number }
  | { type: 'snap'; t: number; hour: number; me: SnapMe; players: SnapPlayer[]; dragons: SnapDragon[]; creatures: SnapCreature[]; villagers: SnapVillager[]; loot: SnapLoot[] }
  | { type: 'hero'; hero: Record<string, unknown>; view: RpgView }
  | { type: 'ev'; evs: RpgEvent[] }
  | { type: 'correct'; x: number; y: number }
  | { type: 'taken'; ids: string[] }
  | { type: 'edit'; key: string; edit: RegionEditJSON | null; by: string }
  | { type: 'joined'; id: string; name: string }
  | { type: 'left'; id: string; name: string }
  | { type: 'pong'; t: number }
  | { type: 'error'; reason: string };
