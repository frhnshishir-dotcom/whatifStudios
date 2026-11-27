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

const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyF', 'KeyQ', 'KeyH', 'KeyI', 'KeyC', 'KeyJ', 'KeyK', 'Space']);
import { WorldDialog } from './components/WorldDialog';
import { ContinentDialog } from './components/ContinentDialog';
import { getWorldIO } from './persistence';
import { PlayBar } from './rpg/PlayBar';
import { RpgHud } from './rpg/RpgHud';
import { RpgWindows } from './rpg/Windows';

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
  const inspectorOpen = useUI((s) => s.inspectorOpen);
  const togglePanels = useUI((s) => s.togglePanels);
  const mode = useUI((s) => s.mode);
  const layout = useUI((s) => s.layout);
  const play = mode === 'continent' && layout === 'play';

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); void getWorldIO()?.quickSave(); return; }
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      if (useUI.getState().dialog) return;
      const ui = useUI.getState();
      // The continent: B switches between Play and the Sandbox (only the interface changes; the world carries on).
      if (ui.mode === 'continent' && ev.code === 'KeyB' && !ev.repeat && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ui.setLayout(ui.layout === 'play' ? 'sandbox' : 'play');
        return;
      }
      const engine = getEngine();
      // Play: the RPG windows (I, C, J, K; Esc closes); no editing shortcuts or tool keys (the tools are in the Sandbox).
      if (ui.mode === 'continent' && ui.layout === 'play') {
        if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
        const w = ({ KeyI: 'inventory', KeyC: 'character', KeyJ: 'journal', KeyK: 'craft' } as const)[ev.code as 'KeyI'];
        if (w) ui.toggleRpgWindow(w);
        else if (ev.key === 'Escape' && ui.rpgWindow) ui.setRpgWindow(null);
        return;
      }
      if (engine && editorShortcut(ev, engine)) { ev.preventDefault(); return; }
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      // Continent play owns the game keys (move, attack, dodge, eat, interact, watch, panel tabs).
      if (engine?.claimSpace && GAME_KEYS.has(ev.code)) return;
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
    // The stage keeps its place among the children in both layouts, so the canvas (and the engine on it) is never
    // remounted when switching between Play and the Sandbox.
    <div className={`app${play ? ' play' : ''}${!play && panelsHidden ? ' panels-hidden' : ''}${!play && inspectorOpen ? ' inspector-open' : ''}`} data-layout={mode === 'continent' ? layout : 'valley'}>
      {play ? <PlayBar /> : !panelsHidden && <TopBar />}
      {!play && !panelsHidden && <Toolbar />}
      <main className="stage"><CanvasView /><Toast />{mode === 'continent' && <RpgHud layout={layout} />}{play && <RpgWindows />}</main>
      {!play && !panelsHidden && <Inspector />}
      {!play && !panelsHidden && <BottomBar />}
      <WorldDialog />
      <ContinentDialog />
      {!play && panelsHidden && <button className="show-panels" onClick={togglePanels} title="Show panels (H)">Show panels</button>}
    </div>
  );
}
