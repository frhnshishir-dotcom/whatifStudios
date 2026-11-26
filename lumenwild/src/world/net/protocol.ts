import type { RegionEditJSON } from '../edits';

/**
 * Messages between game clients and the authoritative world server (JSON over WebSocket).
 *
 * Client -> server
 *   hello   {name, token?}            join, or resume a session with its token
 *   move    {x, y, h, run}             the player's position (validated: a client cannot move faster than running)
 *   edit    {key, edit}                a region's changes (key "rx,ry"; null clears them)
 *   take    {id}                       take a find (chest, herbs, ore, relic) by its place id "kind:x,y"
 *   ping    {t}
 *
 * Server -> client
 *   welcome {id, token, x, y, inv, edits, taken, hour}
 *   snap    {t, hour, players, dragons, creatures, villagers}     ~5 per second, what is near this player
 *   edit    {key, edit, by}            another player's changes
 *   took    {id, item, n, inv} | denied {id, reason}
 *   joined / left {id, name}
 *   pong    {t}
 */

export type ClientMsg =
  | { type: 'hello'; name: string; token?: string }
  | { type: 'move'; x: number; y: number; h: number; run: boolean }
  | { type: 'edit'; key: string; edit: RegionEditJSON | null }
  | { type: 'take'; id: string }
  | { type: 'ping'; t: number };

/** [id, name, x, y, heading, running] */
export type SnapPlayer = [string, string, number, number, number, number];
/** [id, name, x, y, alt, heading, state] */
export type SnapDragon = [string, string, number, number, number, number, string];
/** [id, species, x, y, alt, heading, state, alive] */
export type SnapCreature = [string, string, number, number, number, number, string, number];
/** [id, x, y, heading, state, activity, outdoors] */
export type SnapVillager = [string, number, number, number, string, string, number];

export type ServerMsg =
  | { type: 'welcome'; id: string; token: string; x: number; y: number; inv: Record<string, number>; edits: Record<string, RegionEditJSON>; taken: string[]; hour: number }
  | { type: 'snap'; t: number; hour: number; players: SnapPlayer[]; dragons: SnapDragon[]; creatures: SnapCreature[]; villagers: SnapVillager[] }
  | { type: 'edit'; key: string; edit: RegionEditJSON | null; by: string }
  | { type: 'took'; id: string; item: string; n: number; inv: Record<string, number> }
  | { type: 'denied'; id: string; reason: string }
  | { type: 'joined'; id: string; name: string }
  | { type: 'left'; id: string; name: string }
  | { type: 'pong'; t: number };

/** The id of a find, the same on every client: its kind, variant and continent cell. */
export const findId = (variant: string, x: number, y: number) => `${variant}:${Math.round(x)},${Math.round(y)}`;
