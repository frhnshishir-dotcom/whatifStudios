import '@fontsource/noto-sans-mono/400.css';
import '@fontsource/noto-sans-symbols-2/400.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { loadFonts, createEngine } from './boot';
import { setEngine, getEngine } from './ui/engineRef';
import { useUI } from './ui/store';
import { renderMinimap } from './engine/render/minimap';
import type { Engine } from './engine/Engine';

async function start() {
  const root = createRoot(document.getElementById('root')!);
  await loadFonts();
  const q = new URLSearchParams(location.search);
  if (q.get('scene') === 'continent') {
    // Building the blueprint and the first nine regions takes a few seconds: say so before the work starts.
    document.getElementById('root')!.innerHTML = '<p style="font:14px system-ui;color:#9fb8a8;padding:24px">Building the continent around Lumenfall Village…</p>';
    await new Promise((r) => setTimeout(r, 30));
    useUI.getState().setSettings({ heightScale: 0.35 });
  }
  const seed = Number(q.get('seed') || 7);
  // ?at=x,y (map units) opens the continent somewhere other than Lumenfall Village.
  const at = q.get('at')?.split(',').map(Number);
  const engine = createEngine(seed, q.get('scene') || 'world', { worker: q.get('worker') !== '0', at: at && at.length === 2 && at.every(Number.isFinite) ? [at[0], at[1]] : undefined });
  // ?manual=1: no animation loop; tests drive frames with engine.frame(t) (golden images, benchmarks).
  if (q.get('manual') === '1') engine.manual = true;
  setEngine(engine);
  useUI.getState().setWorldMeta(engine.world.name, seed);
  // Test/debug hook (read-only use in browser tests).
  (window as unknown as { __lumenwild: unknown }).__lumenwild = {
    getEngine, useUI,
    minimap: (e: Engine, out: Uint32Array) => renderMinimap(e.world, e.shader, e.water ? e.water.view : null, e.objects, out),
  };
  root.render(<App />);
}

start();
