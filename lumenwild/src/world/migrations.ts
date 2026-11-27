/**
 * Versions of the saved character and living-world payloads, and the migrations that bring older ones forward.
 *
 * Each payload carries its own version (`v`), independent of the file it sits in (continent save, server file):
 *   hero  v1: the character (level, attributes, skills, pack, equipment, quests, statistics). Version 0 = no `v`
 *             (written before versions existed; same shape as v1).
 *   life  v1: the living world (players, explored map, wildlife, dragons, journal, the rules' world state).
 *             Version 0 = no `v`. Its players may carry a pack of counts (`inv`) from before characters existed;
 *             LifeSim.load turns that into items.
 * A payload from a NEWER version than this code knows is never loaded partially: it is refused, so nothing is
 * overwritten with less than was saved.
 */

export const HERO_VERSION = 1;
export const LIFE_VERSION = 1;

type Json = Record<string, unknown>;
/** migrations[k] takes a payload at version k to version k + 1. */
const HERO_MIGRATIONS: Array<(j: Json) => Json> = [
  (j) => ({ ...j, v: 1 }), // 0 -> 1: unversioned characters already have the v1 shape
];
const LIFE_MIGRATIONS: Array<(j: Json) => Json> = [
  (j) => ({ ...j, v: 1 }), // 0 -> 1: unversioned life payloads (pack counts are converted when players load)
];

export interface Migrated { ok: true; data: Json; from: number; to: number }
export interface Refused { ok: false; error: string; from: number }

function migrate(kind: string, j: unknown, latest: number, steps: Array<(j: Json) => Json>): Migrated | Refused {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, error: `${kind}: not an object`, from: -1 };
  const raw = (j as Json).v;
  const from = raw === undefined ? 0 : typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : -1;
  if (from < 0) return { ok: false, error: `${kind}: unreadable version ${JSON.stringify(raw)}`, from };
  if (from > latest) return { ok: false, error: `${kind}: saved by a newer version (${from}); this build reads up to ${latest}`, from };
  let data = j as Json;
  for (let v = from; v < latest; v++) data = steps[v](data);
  return { ok: true, data, from, to: latest };
}

export const migrateHero = (j: unknown) => migrate('character', j, HERO_VERSION, HERO_MIGRATIONS);
export const migrateLife = (j: unknown) => migrate('living world', j, LIFE_VERSION, LIFE_MIGRATIONS);

/** Check a life payload and every character in it can be read by this build (without changing anything). */
export function checkLife(j: unknown): string[] {
  if (j === undefined || j === null) return [];
  const life = migrateLife(j);
  if (!life.ok) return [life.error];
  const out: string[] = [];
  const players = (life.data.players ?? []) as unknown[];
  if (!Array.isArray(players)) return ['living world: players unreadable'];
  for (const p of players) {
    const h = (p as Json)?.hero;
    if (h === undefined) continue;
    const m = migrateHero(h);
    if (!m.ok) out.push(m.error);
  }
  return out;
}
