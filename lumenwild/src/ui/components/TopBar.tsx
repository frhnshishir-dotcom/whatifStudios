import { Icon } from './Icon';
import { useUI } from '../store';
import { getEngine } from '../engineRef';

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
      <div className="world-title" title="World name">{worldName}</div>
      <div className={`save-state ${saveState}`} data-testid="save-state">{saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved changes'}</div>
      <div className="spacer" />
      <button className="icon-btn" onClick={onUndo} disabled={!history.canUndo} title={`Undo${history.undoLabel ? `: ${history.undoLabel}` : ''} (Ctrl+Z)`} aria-label="Undo" data-testid="undo"><Icon name="undo" /></button>
      <button className="icon-btn" onClick={onRedo} disabled={!history.canRedo} title={`Redo${history.redoLabel ? `: ${history.redoLabel}` : ''} (Ctrl+Y)`} aria-label="Redo" data-testid="redo"><Icon name="redo" /></button>
      <button className="icon-btn" onClick={togglePanels} title="Hide panels (H)" aria-label="Hide panels"><Icon name="expand" /></button>
    </header>
  );
}
