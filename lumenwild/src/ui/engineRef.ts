import type { Engine } from '../engine/Engine';

// The engine lives outside React (it owns typed arrays and a frame loop); components reach it through this ref.
let current: Engine | null = null;
export const setEngine = (e: Engine | null) => { current = e; };
export const getEngine = (): Engine | null => current;
