import { useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { Toolbar } from './components/Toolbar';
import { Inspector } from './components/Inspector';
import { BottomBar } from './components/BottomBar';
import { CanvasView } from './components/CanvasView';
import { useUI } from './store';

export function App() {
  const panelsHidden = useUI((s) => s.panelsHidden);
  const togglePanels = useUI((s) => s.togglePanels);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
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
      {!panelsHidden && <TopBar onUndo={() => {}} onRedo={() => {}} canUndo={false} canRedo={false} onSave={() => {}} onSettings={() => {}} />}
      {!panelsHidden && <Toolbar />}
      <main className="stage"><CanvasView /></main>
      {!panelsHidden && <Inspector />}
      {!panelsHidden && <BottomBar />}
      {panelsHidden && <button className="show-panels" onClick={togglePanels} title="Show panels (H)">Show panels</button>}
    </div>
  );
}
