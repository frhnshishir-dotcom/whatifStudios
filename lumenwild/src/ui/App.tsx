import { useEffect, useState } from 'react';
import { TopBar } from './components/TopBar';
import { Toolbar } from './components/Toolbar';
import { Inspector } from './components/Inspector';
import { BottomBar } from './components/BottomBar';
import { CanvasView } from './components/CanvasView';
import { useUI } from './store';
import { getEngine } from './engineRef';
import { editorShortcut } from './editorBridge';
import { TOOL_KEYS } from './components/Toolbar';

function Toast() {
  const toast = useUI((s) => s.toast);
  const [shown, setShown] = useState<number>(0);
  useEffect(() => {
    if (!toast) return;
    setShown(toast.id);
    const t = setTimeout(() => setShown(0), 2400);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || shown !== toast.id) return null;
  return <div className="toast" role="status" data-testid="toast">{toast.text}</div>;
}

export function App() {
  const panelsHidden = useUI((s) => s.panelsHidden);
  const togglePanels = useUI((s) => s.togglePanels);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      const engine = getEngine();
      if (engine && editorShortcut(ev, engine)) { ev.preventDefault(); return; }
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const tool = TOOL_KEYS[ev.key.toLowerCase()];
      if (tool) { useUI.getState().setTool(tool); return; }
      if (ev.key === 'h' || ev.key === 'H') togglePanels();
      if (ev.key === 'f' || ev.key === 'F') {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.().catch(() => {});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePanels]);

  return (
    <div className={`app${panelsHidden ? ' panels-hidden' : ''}`}>
      {!panelsHidden && <TopBar />}
      {!panelsHidden && <Toolbar />}
      <main className="stage"><CanvasView /><Toast /></main>
      {!panelsHidden && <Inspector />}
      {!panelsHidden && <BottomBar />}
      {panelsHidden && <button className="show-panels" onClick={togglePanels} title="Show panels (H)">Show panels</button>}
    </div>
  );
}
