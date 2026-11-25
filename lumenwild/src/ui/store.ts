import { create } from 'zustand';
import type { EngineStats, HoverInfo } from '../engine/Engine';
import { DEFAULT_OPTIONS, type EditTool, type ToolOptions } from '../engine/edit/Editor';
import type { WorldObject } from '../engine/objects/defs';
import type { SlotMeta } from '../persist/storage';

export type ToolId = EditTool;
export interface HistoryState { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null }

export interface Settings {
  resolutionScale: number;
  heightScale: number;
  simQuality: 'low' | 'medium' | 'high';
  lowPerf: boolean;
  /** Requested presenter; the one actually used is in stats.presenter (WebGL2 falls back to Canvas 2D). */
  presenter: 'canvas2d' | 'webgl2';
}

interface UIState {
  worldName: string;
  seed: number;
  tool: ToolId;
  opts: ToolOptions;
  selected: WorldObject | null;
  history: HistoryState;
  toast: { text: string; id: number } | null;
  dialog: 'worlds' | 'continent' | null;
  dragonOpen: boolean;
  slots: SlotMeta[];
  currentSlot: string | null;
  storageKind: 'indexeddb' | 'localstorage' | 'memory' | null;
  panelsHidden: boolean;
  /** Narrow screens: the inspector opens as a drawer. */
  inspectorOpen: boolean;
  paused: boolean;
  speed: number;
  settings: Settings;
  stats: EngineStats | null;
  hover: HoverInfo | null;
  saveState: 'saved' | 'unsaved' | 'saving';
  setTool: (t: ToolId) => void;
  setOpts: (o: Partial<ToolOptions>) => void;
  setSelected: (o: WorldObject | null) => void;
  setHistory: (h: HistoryState) => void;
  showToast: (text: string) => void;
  setDialog: (d: UIState['dialog']) => void;
  setDragonOpen: (open: boolean) => void;
  togglePanels: () => void;
  toggleInspector: () => void;
  setPaused: (p: boolean) => void;
  setSpeed: (s: number) => void;
  setSettings: (s: Partial<Settings>) => void;
  setStats: (s: EngineStats) => void;
  setHover: (h: HoverInfo | null) => void;
  setWorldMeta: (name: string, seed: number) => void;
  setSaveState: (s: UIState['saveState']) => void;
  markUnsaved: () => void;
}

/** `?presenter=webgl` (or `webgl2`) requests the GPU presenter at start-up. */
function initialPresenter(): Settings['presenter'] {
  if (typeof location === 'undefined') return 'canvas2d';
  const p = new URLSearchParams(location.search).get('presenter');
  return p === 'webgl' || p === 'webgl2' ? 'webgl2' : 'canvas2d';
}

export const useUI = create<UIState>()((set) => ({
  worldName: 'Lumenwild',
  seed: 7,
  tool: 'select',
  opts: { ...DEFAULT_OPTIONS, variants: { ...DEFAULT_OPTIONS.variants } },
  selected: null,
  history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
  toast: null,
  dialog: null,
  dragonOpen: false,
  slots: [],
  currentSlot: null,
  storageKind: null,
  panelsHidden: false,
  inspectorOpen: false,
  paused: false,
  speed: 1,
  settings: { resolutionScale: 1, heightScale: 0.75, simQuality: 'high', lowPerf: false, presenter: initialPresenter() },
  stats: null,
  hover: null,
  saveState: 'unsaved',
  setTool: (tool) => set({ tool }),
  setOpts: (o) => set((st) => {
    const next = { ...st.opts, ...o, variants: { ...st.opts.variants, ...(o.variants ?? {}) } };
    next.radius = Math.max(1, Math.min(16, Math.round(next.radius)));
    return { opts: next };
  }),
  setSelected: (selected) => set({ selected }),
  setHistory: (history) => set({ history }),
  showToast: (text) => set((st) => ({ toast: { text, id: (st.toast?.id ?? 0) + 1 } })),
  setDialog: (dialog) => set({ dialog }),
  setDragonOpen: (dragonOpen) => set((s) => ({ dragonOpen, inspectorOpen: dragonOpen ? true : s.inspectorOpen })),
  togglePanels: () => set((s) => ({ panelsHidden: !s.panelsHidden })),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  setPaused: (paused) => set({ paused }),
  setSpeed: (speed) => set({ speed }),
  setSettings: (s) => set((st) => ({ settings: { ...st.settings, ...s } })),
  setStats: (stats) => set({ stats }),
  setHover: (hover) => set({ hover }),
  setWorldMeta: (worldName, seed) => set({ worldName, seed }),
  setSaveState: (saveState) => set({ saveState }),
  markUnsaved: () => set((st) => (st.saveState === 'unsaved' ? st : { saveState: 'unsaved' })),
}));
