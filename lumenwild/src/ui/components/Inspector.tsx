import { useUI } from '../store';
import { MAT_NAMES, COVER_NAMES } from '../../engine/world/materials';
import { ToolPanel, SelectionPanel } from './ToolPanel';

const KIND = ['Void', 'Terrain', 'Cliff face', 'Water', 'Waterfall', 'Object', 'Particle'];

export function Inspector() {
  const hover = useUI((s) => s.hover);
  const settings = useUI((s) => s.settings);
  const setSettings = useUI((s) => s.setSettings);
  return (
    <aside className="inspector" aria-label="Inspector">
      <SelectionPanel />
      <ToolPanel />
      <section className="panel">
        <h3>Cell</h3>
        {hover ? (
          <dl className="props" data-testid="hover-info">
            <dt>Position</dt><dd>{hover.x}, {hover.y}</dd>
            <dt>Showing</dt><dd>{KIND[hover.kind] ?? '?'}</dd>
            <dt>Elevation</dt><dd>{hover.elev.toFixed(2)} m</dd>
            <dt>Material</dt><dd>{MAT_NAMES[hover.mat] ?? hover.mat}</dd>
            <dt>Cover</dt><dd>{COVER_NAMES[hover.cover] ?? hover.cover}</dd>
            <dt>Moisture</dt><dd>{Math.round((hover.moisture / 255) * 100)}%</dd>
          </dl>
        ) : <p className="muted">Hover the world to inspect a cell.</p>}
      </section>
      <section className="panel">
        <h3>View</h3>
        <label className="field">
          <span>Render resolution <em>{Math.round(settings.resolutionScale * 100)}%</em></span>
          <input type="range" min={0.5} max={1} step={0.05} value={settings.resolutionScale} onChange={(e) => setSettings({ resolutionScale: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Relief <em>{settings.heightScale.toFixed(2)}</em></span>
          <input type="range" min={0.2} max={1} step={0.05} value={settings.heightScale} onChange={(e) => setSettings({ heightScale: Number(e.target.value) })} />
        </label>
      </section>
    </aside>
  );
}
