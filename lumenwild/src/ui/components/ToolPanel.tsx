import { useUI } from '../store';
import { getEngine } from '../engineRef';
import { Mat, Cover } from '../../engine/world/materials';
import { OBJECT_DEFS } from '../../engine/objects/defs';
import { TOOL_GROUPS } from './Toolbar';

const MATERIALS: Array<[number, string, string]> = [
  [Mat.Grass, 'Grass', '#3f6a2e'], [Mat.Meadow, 'Meadow', '#6a8a3a'], [Mat.ForestFloor, 'Forest floor', '#2a4222'],
  [Mat.Moss, 'Moss', '#3c6432'], [Mat.Dirt, 'Dirt', '#5f4630'], [Mat.Path, 'Stone path', '#736a58'],
  [Mat.Sand, 'Sand', '#9c8858'], [Mat.Mud, 'Mud', '#4a3b28'], [Mat.Stone, 'Stone', '#626a68'], [Mat.Glade, 'Glowing moss', '#2f6a55'],
];
const COVERS: Array<[number, string]> = [
  [Cover.Flowers, 'Wildflowers'], [Cover.TallGrass, 'Tall grass'], [Cover.ShortGrass, 'Short grass'], [Cover.Clover, 'Clover'],
  [Cover.Fern, 'Ferns'], [Cover.Reeds, 'Reeds'], [Cover.MossPatch, 'Moss patches'], [Cover.None, 'Clear plants'],
];

const HINTS: Record<string, string> = {
  select: 'Click an object to select it, drag to move it. Delete removes it, Esc deselects. Click water to make ripples.',
  ripple: 'Click or drag on water to make ripples.',
  eraser: 'Removes objects, plants, sources and drains under the brush.',
  terrain: 'Paint the ground material.',
  raise: 'Hold to raise the ground. Steep slopes become cliffs.',
  lower: 'Hold to lower the ground. Dig basins and they fill with water.',
  water: 'Hold to pour (or soak up) water.',
  source: 'Click to place a spring. Click a spring again to remove it.',
  drain: 'Click to place a drain. Click it again to remove it.',
  channel: 'Drag downhill to carve a channel. The bed never rises along the stroke.',
  waterfall: 'Click on a stream: the bed downstream drops by the set height and the water pours over a stone lip.',
  tree: 'Click to plant, drag to scatter.',
  flowers: 'Paint grass, flowers, ferns or reeds.',
  mushroom: 'Click to place, drag to scatter.',
  rock: 'Click to place a rock. Rocks block water.',
  bridge: 'Click on a river to span it.',
  cottage: 'Click on dry ground. The ground under it is levelled.',
  mill: 'Click beside a stream. The wheel goes on the side with water.',
};

function Slider({ label, value, min, max, step, fmt, onChange, testId }: { label: string; value: number; min: number; max: number; step: number; fmt?: (v: number) => string; onChange: (v: number) => void; testId?: string }) {
  return (
    <label className="field">
      <span>{label} <em>{fmt ? fmt(value) : value}</em></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={testId} />
    </label>
  );
}

export function ToolPanel() {
  const tool = useUI((s) => s.tool);
  const o = useUI((s) => s.opts);
  const set = useUI((s) => s.setOpts);
  const meta = TOOL_GROUPS.flatMap((g) => g.tools).find((t) => t.id === tool);
  const radius = ['terrain', 'raise', 'lower', 'water', 'channel', 'waterfall', 'flowers', 'eraser', 'tree', 'mushroom'].includes(tool);
  const strength = ['raise', 'lower', 'water', 'flowers', 'ripple'].includes(tool);
  const variantKind = tool === 'tree' || tool === 'rock' || tool === 'mushroom' || tool === 'cottage' ? tool : null;
  return (
    <section className="panel" data-testid="tool-panel">
      <h3>{meta?.label ?? 'Tool'}{meta?.key ? <kbd>{meta.key}</kbd> : null}</h3>
      <p className="hint">{HINTS[tool]}</p>
      {tool === 'terrain' && (
        <div className="swatches" role="radiogroup" aria-label="Material">
          {MATERIALS.map(([m, name, c]) => (
            <button key={m} role="radio" aria-checked={o.material === m} className={o.material === m ? 'active' : ''} onClick={() => set({ material: m })} title={name}>
              <i style={{ background: c }} />{name}
            </button>
          ))}
        </div>
      )}
      {tool === 'flowers' && (
        <label className="field"><span>Plants</span>
          <select value={o.cover} onChange={(e) => set({ cover: Number(e.target.value) })}>{COVERS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
        </label>
      )}
      {tool === 'water' && (
        <div className="seg wide" role="group" aria-label="Water brush mode">
          <button className={o.waterMode === 'add' ? 'active' : ''} onClick={() => set({ waterMode: 'add' })}>Pour</button>
          <button className={o.waterMode === 'remove' ? 'active' : ''} onClick={() => set({ waterMode: 'remove' })}>Soak up</button>
        </div>
      )}
      {variantKind && (
        <label className="field"><span>Type</span>
          <select value={o.variants[variantKind] ?? 'mixed'} onChange={(e) => set({ variants: { [variantKind]: e.target.value } })} data-testid="variant-select">
            {variantKind !== 'cottage' && <option value="mixed">Mixed</option>}
            {OBJECT_DEFS[variantKind].variants.map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
          </select>
        </label>
      )}
      {tool === 'tree' && <Slider label="Size" value={o.treeSize} min={0} max={3} step={1} fmt={(v) => (v ? String(v) : 'mixed')} onChange={(v) => set({ treeSize: v })} />}
      {radius && <Slider label={tool === 'channel' || tool === 'waterfall' ? 'Width' : tool === 'tree' || tool === 'mushroom' ? 'Scatter' : 'Brush size'} value={o.radius} min={1} max={16} step={1} onChange={(v) => set({ radius: v })} testId="brush-size" />}
      {strength && <Slider label={tool === 'flowers' ? 'Density' : 'Strength'} value={o.strength} min={0.1} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ strength: v })} />}
      {(tool === 'source' || tool === 'drain') && <Slider label="Rate" value={o.rate} min={0.5} max={10} step={0.5} fmt={(v) => `${v} m³/s`} onChange={(v) => set({ rate: v })} />}
      {tool === 'channel' && <Slider label="Depth" value={o.depth} min={0.4} max={4} step={0.1} fmt={(v) => `${v.toFixed(1)} m`} onChange={(v) => set({ depth: v })} />}
      {tool === 'waterfall' && <Slider label="Drop" value={o.drop} min={1.5} max={10} step={0.5} fmt={(v) => `${v} m`} onChange={(v) => set({ drop: v })} />}
      {radius && <p className="muted small">[ and ] change the brush size.</p>}
    </section>
  );
}

export function SelectionPanel() {
  const sel = useUI((s) => s.selected);
  if (!sel) return null;
  const def = OBJECT_DEFS[sel.kind];
  const ed = getEngine()?.editor;
  return (
    <section className="panel selection" data-testid="selection-panel">
      <h3>Selected: {def.label}</h3>
      <dl className="props">
        <dt>Position</dt><dd>{sel.x}, {sel.y}</dd>
        <dt>Blocks water</dt><dd>{def.solid ? 'yes' : 'no'}</dd>
      </dl>
      {def.variants.length > 1 && (
        <label className="field"><span>Type</span>
          <select value={sel.variant} onChange={(e) => ed?.editObject(sel.id, { variant: e.target.value })}>
            {def.variants.map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
          </select>
        </label>
      )}
      {def.props.filter((p) => p.key !== 'seed' || sel.kind === 'tree').map((p) => (
        <Slider key={p.key} label={p.label} value={sel.props[p.key] ?? def.defaults[p.key] ?? 0} min={p.min} max={p.max} step={p.step}
          fmt={(v) => (p.step < 1 ? v.toFixed(1) : String(v))}
          onChange={(v) => ed?.editObject(sel.id, { props: { [p.key]: v } })} />
      ))}
      <div className="row">
        <button className="btn danger" onClick={() => ed?.deleteSelected()} data-testid="delete-selected">Delete</button>
        <button className="btn" onClick={() => ed?.select(0)}>Deselect</button>
      </div>
    </section>
  );
}
