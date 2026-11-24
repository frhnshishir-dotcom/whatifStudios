import { create } from 'zustand';
import type { EngineStats, HoverInfo } from '../engine/Engine';

export type ToolId =
  | 'select' | 'terrain' | 'raise' | 'lower' | 'water' | 'source' | 'drain' | 'channel' | 'waterfall'
  | 'rock' | 'tree' | 'flowers' | 'mushroom' | 'bridge' | 'cottage' | 'mill' | 'ripple' | 'eraser';

export interface Settings {
  resolutionScale: number;
  heightScale: number;
  simQuality: 'low' | 'medium' | 'high';
  lowPerf: boolean;
}

interface UIState {
  worldName: string;
  seed: number;
  tool: ToolId;
  brushSize: number;
  panelsHidden: boolean;
  paused: boolean;
  speed: number;
  settings: Settings;
  stats: EngineStats | null;
  hover: HoverInfo | null;
  saveState: 'saved' | 'unsaved' | 'saving';
  setTool: (t: ToolId) => void;
  setBrushSize: (n: number) => void;
  togglePanels: () => void;
  setPaused: (p: boolean) => void;
  setSpeed: (s: number) => void;
  setSettings: (s: Partial<Settings>) => void;
  setStats: (s: EngineStats) => void;
  setHover: (h: HoverInfo | null) => void;
  setWorldMeta: (name: string, seed: number) => void;
  setSaveState: (s: UIState['saveState']) => void;
}

export const useUI = create<UIState>()((set) => ({
  worldName: 'Lumenwild',
  seed: 7,
  tool: 'select',
  brushSize: 3,
  panelsHidden: false,
  paused: false,
  speed: 1,
  settings: { resolutionScale: 1, heightScale: 0.75, simQuality: 'high', lowPerf: false },
  stats: null,
  hover: null,
  saveState: 'unsaved',
  setTool: (tool) => set({ tool }),
  setBrushSize: (brushSize) => set({ brushSize: Math.max(1, Math.min(16, brushSize)) }),
  togglePanels: () => set((s) => ({ panelsHidden: !s.panelsHidden })),
  setPaused: (paused) => set({ paused }),
  setSpeed: (speed) => set({ speed }),
  setSettings: (s) => set((st) => ({ settings: { ...st.settings, ...s } })),
  setStats: (stats) => set({ stats }),
  setHover: (hover) => set({ hover }),
  setWorldMeta: (worldName, seed) => set({ worldName, seed }),
  setSaveState: (saveState) => set({ saveState }),
}));
