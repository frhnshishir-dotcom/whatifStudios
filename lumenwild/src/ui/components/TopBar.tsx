import { Icon } from './Icon';
import { useUI } from '../store';

export function TopBar({ onUndo, onRedo, canUndo, canRedo, onSave, onSettings }: {
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean; onSave: () => void; onSettings: () => void;
}) {
  const worldName = useUI((s) => s.worldName);
  const saveState = useUI((s) => s.saveState);
  const togglePanels = useUI((s) => s.togglePanels);
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Icon name="logo" size={18} /></span><span className="brand-name">Lumenwild</span></div>
      <div className="world-title" title="World name">{worldName}</div>
      <div className={`save-state ${saveState}`} data-testid="save-state">{saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved changes'}</div>
      <div className="spacer" />
      <button className="icon-btn" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
      <button className="icon-btn" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><Icon name="redo" /></button>
      <button className="icon-btn" onClick={onSave} title="Save (Ctrl+S)" aria-label="Save"><Icon name="save" /></button>
      <button className="icon-btn" onClick={onSettings} title="Settings" aria-label="Settings"><Icon name="settings" /></button>
      <button className="icon-btn" onClick={togglePanels} title="Hide panels (H)" aria-label="Hide panels"><Icon name="expand" /></button>
    </header>
  );
}
