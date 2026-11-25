import { Icon } from './Icon';
import { useUI } from '../store';
import { getEngine } from '../engineRef';
import { getWorldIO } from '../persistence';

export function TopBar() {
  const history = useUI((s) => s.history);
  const showToast = useUI((s) => s.showToast);
  const onUndo = () => { const l = getEngine()?.editor.undo(); if (l) showToast(`Undo: ${l}`); };
  const onRedo = () => { const l = getEngine()?.editor.redo(); if (l) showToast(`Redo: ${l}`); };
  const worldName = useUI((s) => s.worldName);
  const saveState = useUI((s) => s.saveState);
  const togglePanels = useUI((s) => s.togglePanels);
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Icon name="logo" size={18} /></span><span className="brand-name">Lumenwild</span></div>
      <button className="world-title" title="Worlds: save, load, new, import, export" onClick={() => useUI.getState().setDialog('worlds')} data-testid="open-worlds">{worldName}</button>
      <div className={`save-state ${saveState}`} data-testid="save-state">{saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved changes'}</div>
      <div className="spacer" />
      <button className="icon-btn" onClick={onUndo} disabled={!history.canUndo} title={`Undo${history.undoLabel ? `: ${history.undoLabel}` : ''} (Ctrl+Z)`} aria-label="Undo" data-testid="undo"><Icon name="undo" /></button>
      <button className="icon-btn" onClick={onRedo} disabled={!history.canRedo} title={`Redo${history.redoLabel ? `: ${history.redoLabel}` : ''} (Ctrl+Y)`} aria-label="Redo" data-testid="redo"><Icon name="redo" /></button>
      <button className="icon-btn" onClick={() => { const o = !useUI.getState().dragonOpen; useUI.getState().setDragonOpen(o); }} title="Dragon" aria-label="Dragon" data-testid="open-dragon"><Icon name="dragon" /></button>
      <button className="icon-btn" onClick={() => { void getWorldIO()?.quickSave(); }} title="Save (Ctrl+S)" aria-label="Save" data-testid="quick-save"><Icon name="save" /></button>
      <button className="icon-btn" onClick={() => useUI.getState().setDialog('worlds')} title="Worlds: save slots, new world, import / export" aria-label="Worlds"><Icon name="folder" /></button>
      <button className="icon-btn narrow-only" onClick={() => useUI.getState().toggleInspector()} title="Tool, weather and view settings" aria-label="Settings panel" data-testid="toggle-inspector"><Icon name="settings" /></button>
      <button className="icon-btn wide-only" onClick={togglePanels} title="Hide panels (H)" aria-label="Hide panels"><Icon name="expand" /></button>
    </header>
  );
}
