import type { WaterParams } from './WaterSim';

/** Edits sent to the water simulation (applied between steps, in order). */
export type WaterCmd =
  | { op: 'addWater'; x: number; y: number; r: number; amount: number }
  | { op: 'disturb'; x: number; y: number; r: number; strength: number }
  | { op: 'source'; x: number; y: number; rate: number }
  | { op: 'drain'; x: number; y: number; rate: number }
  | { op: 'terrain'; x0: number; y0: number; x1: number; y1: number }
  | { op: 'warmup'; steps: number }
  | { op: 'clear' }
  | { op: 'reset'; depth: Float32Array | null }
  | { op: 'params'; params: Partial<WaterParams> }
  | { op: 'ports'; sources: Array<[number, number, number]>; drains: Array<[number, number, number]> };

export interface WaterStats { stepMs: number; steps: number; total: number; active: number; added: number; removed: number; warming: boolean }
