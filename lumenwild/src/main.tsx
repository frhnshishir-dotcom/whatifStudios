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
  const seed = Number(new URLSearchParams(location.search).get('seed') || 7);
  const engine = createEngine(seed);
  setEngine(engine);
  useUI.getState().setWorldMeta(engine.world.name, seed);
  // Test/debug hook (read-only use in browser tests).
  (window as unknown as { __lumenwild: unknown }).__lumenwild = { getEngine, useUI };
  root.render(<App />);
}

start();
