import { useEffect, useRef } from 'react';
import { getEngine } from '../engineRef';
import { useUI } from '../store';
import { connectEditor } from '../editorBridge';
import { WorldIO, setWorldIO } from '../persistence';

/** Hosts the world canvas: attaches the engine, tracks size changes and wires engine callbacks into the UI store. */
export function CanvasView() {
  const ref = useRef<HTMLCanvasElement>(null);
  const resolutionScale = useUI((s) => s.settings.resolutionScale);
  const heightScale = useUI((s) => s.settings.heightScale);
  const lowPerf = useUI((s) => s.settings.lowPerf);
  useEffect(() => { getEngine()?.setLowPerf(lowPerf); }, [lowPerf]);

  useEffect(() => {
    const engine = getEngine();
    const canvas = ref.current;
    if (!engine || !canvas) return;
    engine.attach(canvas);
    const ui = useUI.getState();
    engine.onStats = (s) => useUI.getState().setStats(s);
    let lastHover = '';
    engine.onHover = (h) => {
      const key = h ? `${h.i}:${h.kind}:${h.elev.toFixed(2)}` : '';
      if (key !== lastHover) { lastHover = key; useUI.getState().setHover(h); }
    };
    engine.onPauseChange = (p) => useUI.getState().setPaused(p);
    engine.setPaused(ui.paused);
    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      engine.resize(r.width, r.height, window.devicePixelRatio || 1);
    });
    ro.observe(canvas);
    const r = canvas.getBoundingClientRect();
    engine.resize(r.width, r.height, window.devicePixelRatio || 1);
    if (r.width < 700) engine.fitZoom(64);
    const [hx, hy] = engine.home ?? [engine.world.w * 0.5, engine.world.h * 0.55];
    engine.focus(hx, hy);
    const unlink = connectEditor(engine);
    const io = new WorldIO(engine);
    setWorldIO(io);
    void io.init();
    engine.start();
    return () => { ro.disconnect(); unlink(); io.dispose(); setWorldIO(null); engine.stop(); };
  }, []);

  useEffect(() => {
    const engine = getEngine();
    if (!engine?.renderer || !ref.current) return;
    engine.renderer.resolutionScale = resolutionScale;
    engine.cam.heightScale = heightScale;
    const r = ref.current.getBoundingClientRect();
    engine.resize(r.width, r.height, window.devicePixelRatio || 1);
    engine.renderer.invalidate();
  }, [resolutionScale, heightScale]);

  const tool = useUI((s) => s.tool);
  return <canvas ref={ref} className={`world-canvas tool-${tool}`} data-testid="world-canvas" aria-label="Lumenwild world" />;
}
