import { useEffect, useState, useSyncExternalStore } from 'react';
import { getEngine } from '../engineRef';
import type { ContinentSession } from '../../world/session';
import type { LivingWorld } from '../../world/life/client';

/**
 * The RPG interface's link to the game. Components read the character, the rules' view and the world straight from
 * the `LivingWorld` (no copies), send commands with `lw.command()` (applied here in single player, decided by the
 * server online), and re-render when `lw.changed()` says something may have changed.
 */

/** The living world of the running continent, or null (the Valley, or before the engine exists). */
export function getLife(): LivingWorld | null {
  const s = getEngine()?.streamer as ContinentSession | undefined;
  return (s?.life as unknown as LivingWorld | null) ?? null;
}

const noSubscribe = () => () => {};

/**
 * The living world, re-rendering the component when it changes. `liveHz` (optional) also re-renders on a timer, for
 * values that move every frame (health, stamina, positions, the interaction prompt).
 */
export function useLife(liveHz = 0): LivingWorld | null {
  const lw = getLife();
  useSyncExternalStore(lw ? lw.subscribe : noSubscribe, () => lw?.revision ?? 0, () => 0);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lw || liveHz <= 0) return;
    const t = setInterval(() => setTick((n) => (n + 1) & 0xffff), 1000 / liveHz);
    return () => clearInterval(t);
  }, [lw, liveHz]);
  return lw;
}
