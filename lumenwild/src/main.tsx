import '@fontsource/noto-sans-mono/400.css';
import '@fontsource/noto-sans-symbols-2/400.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { loadFonts, createEngine } from './boot';
import { setEngine, getEngine } from './ui/engineRef';
import { useUI } from './ui/store';

async function start() {
  const root = createRoot(document.getElementById('root')!);
  await loadFonts();
  const q = new URLSearchParams(location.search);
  const seed = Number(q.get('seed') || 7);
  const engine = createEngine(seed, q.get('scene') || 'world', { worker: q.get('worker') !== '0' });
  setEngine(engine);
  useUI.getState().setWorldMeta(engine.world.name, seed);
  // Test/debug hook (read-only use in browser tests).
  (window as unknown as { __lumenwild: unknown }).__lumenwild = { getEngine, useUI };
  root.render(<App />);
}

start();
