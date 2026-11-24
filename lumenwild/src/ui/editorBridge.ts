import type { Engine } from '../engine/Engine';
import { useUI } from './store';

/**
 * Two-way link between the engine's editor and the UI store: tool and options flow down to the editor; selection,
 * history state, messages and "unsaved" flow up. Returns an unsubscribe function.
 */
export function connectEditor(engine: Engine): () => void {
  const ed = engine.editor;
  const ui = useUI.getState;
  const pushHistory = () => {
    const h = ed.history;
    ui().setHistory({ canUndo: h.canUndo, canRedo: h.canRedo, undoLabel: h.undoLabel, redoLabel: h.redoLabel });
  };
  ed.history.onChange = pushHistory;
  ed.onSelect = (o) => ui().setSelected(o);
  ed.onMessage = (m) => ui().showToast(m);
  ed.onEdit = () => { if (ui().saveState !== 'unsaved') ui().setSaveState('unsaved'); };
  pushHistory();
  const apply = (s: ReturnType<typeof ui>) => {
    if (engine.tool !== s.tool) {
      if (engine.editor.active) engine.editor.end();
      engine.tool = s.tool;
      if (s.tool !== 'select' && ed.selectedId) ed.select(0);
    }
    ed.options = s.opts;
  };
  apply(ui());
  return useUI.subscribe(apply);
}

/** Keyboard shortcuts for editing (registered once by the app). */
export function editorShortcut(ev: KeyboardEvent, engine: Engine): boolean {
  const ed = engine.editor, ui = useUI.getState();
  const mod = ev.ctrlKey || ev.metaKey;
  const k = ev.key.toLowerCase();
  if (mod && k === 'z' && !ev.shiftKey) { const l = ed.undo(); ui.showToast(l ? `Undo: ${l}` : 'Nothing to undo'); return true; }
  if (mod && (k === 'y' || (k === 'z' && ev.shiftKey))) { const l = ed.redo(); ui.showToast(l ? `Redo: ${l}` : 'Nothing to redo'); return true; }
  if (mod) return false;
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && ed.selectedId) { ed.deleteSelected(); ui.showToast('Deleted'); return true; }
  if (ev.key === 'Escape') { ed.select(0); return true; }
  if (ev.key === '[') { ui.setOpts({ radius: ui.opts.radius - 1 }); return true; }
  if (ev.key === ']') { ui.setOpts({ radius: ui.opts.radius + 1 }); return true; }
  return false;
}
