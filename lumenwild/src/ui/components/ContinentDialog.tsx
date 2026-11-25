import { useEffect, useRef, useState } from 'react';
import { useUI } from '../store';
import type { Continent, Village } from '../../engine/continent/types';
import type { Culture } from '../../engine/continent/cultures';
import { BlueprintView } from './BlueprintView';

type Mods = {
  gen: typeof import('../../engine/continent/generate');
  map: typeof import('../../engine/continent/mapRender');
  cul: typeof import('../../engine/continent/cultures');
  types: typeof import('../../engine/continent/types');
};
let cache: { c: Continent; m: Mods } | null = null;

/** Generated on first open (about a second), then kept: the layout is deterministic for the design seed. */
async function load(): Promise<{ c: Continent; m: Mods }> {
  if (cache) return cache;
  const [gen, map, cul, types] = await Promise.all([
    import('../../engine/continent/generate'), import('../../engine/continent/mapRender'),
    import('../../engine/continent/cultures'), import('../../engine/continent/types'),
  ]);
  cache = { c: gen.generateContinent(1), m: { gen, map, cul, types } };
  const hook = (window as unknown as { __lumenwild?: Record<string, unknown> }).__lumenwild;
  if (hook) hook.continent = cache.c;
  return cache;
}

const SPECIAL_GLYPH: Record<string, [string, string]> = {
  ruin: ['◆', '#d9c8f0'], dungeon: ['▼', '#c9a0ff'], landmark: ['★', '#ffe08a'], lair: ['✦', '#ff6a4a'], 'abandoned-hamlet': ['⌂', '#bfb3a0'],
};

function drawMap(cv: HTMLCanvasElement, c: Continent, m: Mods): void {
  const S = c.size;
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d')!;
  const px = new Uint32Array(S * S);
  m.map.renderContinent(c, px);
  g.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), S, S), 0, 0);
  g.lineWidth = 2;
  for (const h of c.habitats) {
    g.setLineDash([2, 5]); g.strokeStyle = 'rgba(190,240,170,0.55)';
    g.beginPath(); g.arc(h.x, h.y, h.r * 0.75, 0, Math.PI * 2); g.stroke();
  }
  for (const t of c.territories) {
    g.setLineDash([10, 6]); g.strokeStyle = 'rgba(255,90,60,0.9)'; g.fillStyle = 'rgba(255,60,30,0.08)';
    g.beginPath(); g.arc(t.x, t.y, t.r, 0, Math.PI * 2); g.fill(); g.stroke();
    g.setLineDash([]);
    label(g, t.name, t.x, t.y - t.r - 8, '#ff9a80', 15);
  }
  // Paths on top of the terrain, so the sparse network reads clearly.
  const TRAIL_STYLE: Record<string, [string, number, number[]]> = {
    footpath: ['#f0c27a', 2, []], 'forest-trail': ['#e0b070', 2, []], 'mountain-pass': ['#f4ecd8', 2, [6, 3]], boardwalk: ['#d8c48e', 2, []],
    spur: ['#e8c08a', 1.2, [3, 3]], 'ancient-road': ['#cfc4a8', 1.5, [2, 6]],
  };
  for (const t of c.trails) {
    const [col, w, dash] = TRAIL_STYLE[t.kind];
    g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash);
    g.beginPath();
    t.cells.forEach(([x, y], k) => { if (k % 3 === 0 || k === t.cells.length - 1) { if (k === 0) g.moveTo(x + 0.5, y + 0.5); else g.lineTo(x + 0.5, y + 0.5); } });
    g.stroke();
  }
  g.setLineDash([]);
  for (const k of c.crossings) {
    g.fillStyle = k.kind === 'stone-crossing' ? '#d8d8d0' : '#c07a3a';
    g.fillRect(k.x - 3, k.y - 3, 6, 6);
  }
  for (const o of c.outposts) { g.fillStyle = '#f0a050'; g.fillRect(o.x - 3, o.y - 3, 7, 7); g.strokeStyle = '#2a1a0a'; g.lineWidth = 1; g.strokeRect(o.x - 3.5, o.y - 3.5, 8, 8); }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const s of c.specials) {
    const [ch, col] = SPECIAL_GLYPH[s.kind];
    g.font = '18px "Noto Sans Symbols 2", sans-serif';
    g.fillStyle = '#000'; g.fillText(ch, s.x + 1, s.y + 1);
    g.fillStyle = col; g.fillText(ch, s.x, s.y);
    if (s.kind === 'landmark') label(g, s.name, s.x, s.y + 16, '#ffe9b0', 12);
  }
  for (const v of c.villages) {
    g.fillStyle = '#fff'; g.strokeStyle = '#111'; g.lineWidth = 2;
    g.beginPath(); g.arc(v.centre[0], v.centre[1], 6, 0, Math.PI * 2); g.fill(); g.stroke();
    label(g, v.name.toUpperCase(), v.centre[0], v.centre[1] - 18, '#ffffff', 20);
  }
  const at: Record<string, number> = { silverrun: 0.5, amberflow: 0.44, thornbrook: 0.68 };
  for (const r of c.rivers) { const p = r.points[Math.floor(r.points.length * (at[r.id] ?? 0.5))]; label(g, r.name, p[0] + 30, p[1], '#a8d8ff', 12); }
  for (const [b, x, y] of [[2, 650, 92], [1, 540, 430], [5, 110, 450], [3, 290, 880], [4, 770, 860], [6, 905, 300]] as const) {
    label(g, m.types.BIOME_NAMES[b as 1].toUpperCase(), x, y, 'rgba(255,255,255,0.75)', 16);
  }
}

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, col: string, size: number): void {
  g.font = `600 ${size}px "Noto Sans Mono", monospace`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.strokeText(text, x, y);
  g.fillStyle = col; g.fillText(text, x, y);
}

function drawVillage(cv: HTMLCanvasElement, c: Continent, v: Village, m: Mods): void {
  const cul = m.cul.CULTURES[v.culture];
  const radius = Math.min(125, cul.fieldR + 12), scale = radius > 90 ? 3 : 4, S = radius * 2 * scale;
  cv.width = S; cv.height = S;
  const px = new Uint32Array(S * S);
  m.map.renderVillage(c, v, radius, scale, px);
  const g = cv.getContext('2d')!;
  g.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), S, S), 0, 0);
  const x0 = v.centre[0] - radius, y0 = v.centre[1] - radius;
  for (const b of v.buildings) {
    if (!['inn', 'smithy', 'market-hall', 'water-mill', 'longhouse', 'mine-head', 'windmill', 'trading-post', 'tavern', 'herbalist', 'elder-hall', 'lantern-deck', 'moonwell', 'watch-post', 'shrine', 'woodcarver'].includes(b.type)) continue;
    label(g, b.type.replace('-', ' '), (b.x - x0 + b.w / 2) * scale, (b.y - y0 - 1.6) * scale, '#fff4d8', 11);
  }
}

function summary(v: Village, cul: Culture) {
  const types = new Map<string, number>();
  for (const b of v.buildings) types.set(b.type, (types.get(b.type) ?? 0) + 1);
  const occ = new Map<string, number>();
  for (const r of v.residents) occ.set(r.occupation, (occ.get(r.occupation) ?? 0) + 1);
  const area = v.fields.reduce((s, f) => s + f.w * f.h, 0) + v.pens.reduce((s, f) => s + f.w * f.h, 0);
  return { types: [...types.entries()], occ: [...occ.entries()].sort((a, b) => b[1] - a[1]), area, cul };
}

/** Design preview of the continent: the overview map, a close-up of each village, and the land-use figures. */
export function ContinentDialog() {
  const open = useUI((s) => s.dialog === 'continent');
  const setDialog = useUI((s) => s.setDialog);
  const [data, setData] = useState<{ c: Continent; m: Mods } | null>(cache);
  const [tab, setTab] = useState('map');
  /** World spec blueprint (default), the player's starting map, or the earlier settlement draft. */
  const [mode, setMode] = useState<'blueprint' | 'player' | 'draft'>('blueprint');
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDialog(null); };
    window.addEventListener('keydown', onKey);
    if (!data && mode === 'draft') setTimeout(() => { void load().then(setData); }, 30);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, data, setDialog, mode]);

  useEffect(() => {
    if (!open || !data || !ref.current || mode !== 'draft') return;
    const v = data.c.villages.find((q) => q.id === tab);
    if (v) drawVillage(ref.current, data.c, v, data.m); else drawMap(ref.current, data.c, data.m);
  }, [open, data, tab, mode]);

  if (!open) return null;
  const c = data?.c, v = c?.villages.find((q) => q.id === tab);
  const s = c?.stats, sum = v && data ? summary(v, data.m.cul.CULTURES[v.culture]) : null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setDialog(null); }}>
      <div className="modal wide" role="dialog" aria-label="Continent" data-testid="continent-dialog">
        <header className="modal-head">
          <h2>World map</h2>
          <button className="icon-btn" onClick={() => setDialog(null)} aria-label="Close">✕</button>
        </header>
        <section className="modal-sec">
          <div className="tabs" role="tablist">
            {([['blueprint', 'World blueprint'], ['player', 'Player view at start'], ['draft', 'Earlier draft (5 villages)']] as const).map(([id, name]) => (
              <button key={id} role="tab" aria-selected={mode === id} className={`tab${mode === id ? ' on' : ''}`} onClick={() => setMode(id)} data-testid={`map-mode-${id}`}>{name}</button>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 8 }}>{mode === 'draft'
            ? 'The settlement-revision draft (1024 × 1024 cells, five villages, no cities). Superseded by the world specification pending your decisions.'
            : 'Phase 1 blueprint of the Realm of Lumenwild from the editable files in lumenwild/world/ (map units 0-1000). Design data, not yet playable terrain.'}</p>
        </section>
        {mode !== 'draft' && <section className="modal-sec"><BlueprintView mode={mode} /></section>}
        {mode === 'draft' && <section className="modal-sec">
          <div className="tabs" role="tablist">
            {[['map', 'Map'], ...(c?.villages.map((q) => [q.id, q.name]) ?? [])].map(([id, name]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={`tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)} data-testid={`continent-tab-${id}`}>{name}</button>
            ))}
          </div>
        </section>}
        {mode === 'draft' && <section className="modal-sec">
          {!data ? <p className="muted" data-testid="continent-loading">Generating the continent…</p> : <canvas ref={ref} className="continent-canvas" data-testid="continent-canvas" />}
        </section>}
        {mode === 'draft' && s && !v && (
          <section className="modal-sec" data-testid="continent-stats">
            <h3>Land use</h3>
            <div className="stat-row"><b>{s.wilderness.toFixed(1)}%</b> wilderness · <b>{s.settlements.toFixed(1)}%</b> villages, farmland, outposts and paths · <b>{s.special.toFixed(1)}%</b> ruins, dungeons, landmarks and lairs</div>
            <div className="stat-row">{s.buildings} buildings in 5 villages · {s.population} villagers · {c!.outposts.length} outposts · paths on {s.trails.toFixed(2)}% of land, {(100 - s.nearTrail).toFixed(0)}% of land more than 10 cells from any path</div>
            <div className="stat-row">{c!.territories.length} dragon territories ({s.territoryDisturbance.toFixed(2)}% disturbed) · {c!.habitats.length} wildlife habitats · {c!.falls.length} waterfalls · {c!.crossings.length} bridges and fords</div>
            <div className="legend">
              <span><i style={{ background: '#cdb995' }} />village</span><span><i style={{ background: '#d6b85a' }} />farmland</span><span><i style={{ background: '#9c6b3a' }} />path</span>
              <span><i style={{ background: '#f0a050' }} />outpost</span><span style={{ color: '#ff9a80' }}>◯ dragon territory</span><span style={{ color: '#bef0aa' }}>◌ habitat</span>
              <span>◆ ruin · ▼ dungeon · ★ landmark · ✦ lair · ⌂ abandoned hamlet</span>
            </div>
          </section>
        )}
        {mode === 'draft' && v && sum && (
          <section className="modal-sec two" data-testid="village-info">
            <div>
              <h3>{v.name} · {data!.m.types.BIOME_NAMES[v.biome]}</h3>
              <dl className="kv">
                <dt>Walls</dt><dd>{sum.cul.architecture.walls}</dd>
                <dt>Roof</dt><dd>{sum.cul.architecture.roof}</dd>
                <dt>Foundation</dt><dd>{sum.cul.architecture.foundation}</dd>
                <dt>Layout</dt><dd>{sum.cul.architecture.layout.replace(/-/g, ' ')}</dd>
                <dt>Buildings</dt><dd>{v.buildings.filter((b) => b.counts).length}</dd>
                <dt>Farmland</dt><dd>{sum.area.toLocaleString()} cells ({sum.cul.farm.kind})</dd>
              </dl>
              <div className="swatches">{Object.entries(sum.cul.architecture.palette).map(([k, col]) => <span key={k} title={k} style={{ background: col }} />)}</div>
            </div>
            <div>
              <h3>{v.residents.length} villagers</h3>
              <p className="muted small">{sum.occ.map(([o, n]) => `${o} ${n}`).join(' · ')}</p>
              <h3 style={{ marginTop: 10 }}>Structures</h3>
              <p className="muted small">{sum.types.map(([t, n]) => `${t} ${n}`).join(' · ')}</p>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
