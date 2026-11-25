import { useEffect, useRef, useState } from 'react';
import type { Blueprint } from '../../world/blueprint';
import type { DiscoveryState } from '../../world/discovery';
import type { MapPt } from '../../world/schema';

type Mods = {
  bp: typeof import('../../world/blueprint');
  render: typeof import('../../world/blueprintRender');
  disc: typeof import('../../world/discovery');
  schema: typeof import('../../world/schema');
};
let cache: { bp: Blueprint; m: Mods; start: DiscoveryState; errors: string[] } | null = null;

/** Built on first open from the world data files (well under a second), then kept. */
async function load() {
  if (cache) return cache;
  const [data, bp, render, disc, schema] = await Promise.all([
    import('../../world/data'), import('../../world/blueprint'), import('../../world/blueprintRender'), import('../../world/discovery'), import('../../world/schema'),
  ]);
  const v = schema.validateWorld(data.WORLD);
  const b = bp.buildBlueprint(data.WORLD);
  cache = { bp: b, m: { bp, render, disc, schema }, start: disc.createDiscovery(data.WORLD), errors: v.errors };
  const hook = (window as unknown as { __lumenwild?: Record<string, unknown> }).__lumenwild;
  if (hook) hook.blueprint = b;
  return cache;
}

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, col: string, size: number, weight = 600): void {
  g.font = `${weight} ${size}px "Noto Sans Mono", monospace`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.78)'; g.strokeText(text, x, y);
  g.fillStyle = col; g.fillText(text, x, y);
}

const glyph = (g: CanvasRenderingContext2D, ch: string, x: number, y: number, col: string, size = 16) => {
  g.font = `${size}px "Noto Sans Symbols 2", "Noto Sans Mono", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(0,0,0,0.8)'; g.fillText(ch, x + 1, y + 1);
  g.fillStyle = col; g.fillText(ch, x, y);
};

function polyline(g: CanvasRenderingContext2D, pts: MapPt[], every = 1): void {
  g.beginPath();
  pts.forEach(([x, y], k) => { if (k % every === 0 || k === pts.length - 1) { if (k === 0) g.moveTo(x, y); else g.lineTo(x, y); } });
  g.stroke();
}

function draw(cv: HTMLCanvasElement, bp: Blueprint, m: Mods, player: DiscoveryState | null): void {
  const S = 1000;
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d')!;
  const px = new Uint32Array(bp.N * bp.N);
  m.render.renderBlueprint(bp, px);
  const tmp = document.createElement('canvas');
  tmp.width = bp.N; tmp.height = bp.N;
  tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), bp.N, bp.N), 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(tmp, 0, 0, S, S);
  const d = bp.data, sc = S / d.coordinates.map.max;
  g.save();
  g.scale(sc, sc);
  g.lineCap = 'round'; g.lineJoin = 'round';

  // Fissures glow red.
  for (const f of d.elevation.fissures) { g.strokeStyle = 'rgba(255,60,40,0.85)'; g.lineWidth = f.width * 0.8; polyline(g, f.line); }
  // Rivers.
  for (const r of bp.rivers) {
    const def = d.rivers.find((q) => q.id === r.id)!;
    g.strokeStyle = '#5fb0e8';
    for (let k = 0; k < r.pts.length - 8; k += 8) {
      const f = k / r.pts.length;
      g.lineWidth = Math.max(1.1, def.width[0] + (def.width[1] - def.width[0]) * f);
      g.beginPath(); g.moveTo(r.pts[k][0], r.pts[k][1]); g.lineTo(r.pts[k + 8][0], r.pts[k + 8][1]); g.stroke();
    }
  }
  // Territories and flight corridors.
  if (!player) {
    for (const h of d.habitats) { g.setLineDash([2, 4]); g.strokeStyle = 'rgba(190,240,170,0.5)'; g.lineWidth = 1; g.beginPath(); g.arc(h.at[0], h.at[1], h.radius, 0, Math.PI * 2); g.stroke(); }
    for (const t of d.territories) {
      const nest = t.kind === 'nest';
      g.setLineDash(nest ? [9, 5] : [3, 5]); g.lineWidth = 2;
      g.strokeStyle = nest ? 'rgba(255,90,60,0.9)' : 'rgba(255,190,80,0.9)';
      g.fillStyle = nest ? 'rgba(255,60,30,0.07)' : 'rgba(255,190,80,0.06)';
      g.beginPath(); g.arc(t.centre[0], t.centre[1], t.radius, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    g.setLineDash([2, 6]); g.lineWidth = 1.6; g.strokeStyle = 'rgba(255,200,120,0.85)';
    for (const c of bp.corridors) { g.beginPath(); g.moveTo(c.a[0], c.a[1]); g.quadraticCurveTo((c.a[0] + c.b[0]) / 2 + (c.b[1] - c.a[1]) * 0.12, (c.a[1] + c.b[1]) / 2 - (c.b[0] - c.a[0]) * 0.12, c.b[0], c.b[1]); g.stroke(); }
    g.setLineDash([]);
  }
  // Roads.
  for (const r of bp.roads) {
    const def = d.roads.find((q) => q.id === r.id)!;
    if (player && !player.knownRoutes.has(r.id) && def.class !== 'major') continue;
    const major = r.cls === 'major', proposed = def.status === 'proposed';
    if (major) { g.strokeStyle = 'rgba(40,24,8,0.9)'; g.lineWidth = 4.2; g.setLineDash([]); polyline(g, r.pts); }
    g.strokeStyle = proposed ? 'rgba(230,210,170,0.8)' : major ? '#f2c66d' : '#e6cf9c';
    g.lineWidth = major ? 2.4 : 1.6;
    g.setLineDash(proposed || r.cls === 'trail' ? [4, 3] : []);
    polyline(g, r.pts);
    g.setLineDash([]);
    for (const b of r.bridges) { g.fillStyle = b.name ? '#fff3c4' : '#d8c8a0'; g.fillRect(b.at[0] - 2.5, b.at[1] - 2.5, 5, 5); }
  }

  // Fog of war for the player view.
  if (player) {
    const u = d.discovery.fogCellUnits, fog = document.createElement('canvas');
    fog.width = player.size; fog.height = player.size;
    const fg = fog.getContext('2d')!, img = fg.createImageData(player.size, player.size);
    for (let k = 0; k < player.size * player.size; k++) {
      const open = (player.fog[k >> 3] & (1 << (k & 7))) !== 0;
      img.data[k * 4] = 22; img.data[k * 4 + 1] = 20; img.data[k * 4 + 2] = 16; img.data[k * 4 + 3] = open ? 0 : 236;
    }
    fg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(fog, 0, 0, player.size * u, player.size * u);
  }

  // Waterfalls.
  for (const r of bp.rivers) for (const f of r.falls) if (!player || m.disc.isRevealed(d, player, f.at)) glyph(g, '≋', f.at[0], f.at[1], '#bfe6ff', 13);
  // Landing sites and nests.
  if (!player) {
    for (const [id, sites] of Object.entries(bp.landing)) for (const s of sites) glyph(g, '▴', s[0], s[1], id ? '#ffb08a' : '#fff', 10);
    for (const t of d.territories) if (t.nest) glyph(g, '✦', t.nest[0], t.nest[1], '#ff6a4a', 16);
  }
  // Landmarks.
  const LM: Record<string, [string, string]> = { known: ['★', '#ffe08a'], rumoured: ['◆', '#e0d4f8'], hidden: ['✧', '#c9a0ff'] };
  for (const l of d.landmarks) {
    const state = player ? m.disc.mapState(d, player, l.id) : l.discovery === 'known' ? 'shown' : l.discovery;
    if (state === 'hidden' && player) continue;
    const [ch, col] = player ? (state === 'shown' ? LM.known : ['?', '#e8dcc0']) : LM[l.discovery];
    glyph(g, ch, l.at[0], l.at[1], l.fantastical && !player ? '#8ff0ff' : col, 15);
    if (!player || state === 'shown') label(g, l.name, l.at[0], l.at[1] + 13, '#f5ecd6', 10, 500);
    else label(g, `${l.name}?`, l.at[0], l.at[1] + 13, '#cfc4ae', 10, 400);
  }
  // Settlements.
  for (const s of d.settlements) {
    if (player && !player.discovered.has(s.id)) continue;
    const [x, y] = s.at;
    g.lineWidth = 2; g.strokeStyle = '#111';
    g.setLineDash(s.status === 'proposed' ? [3, 2] : []);
    if (s.kind === 'city') { g.fillStyle = '#ffd45a'; g.beginPath(); g.rect(x - 7, y - 7, 14, 14); g.fill(); g.stroke(); g.strokeStyle = '#ffd45a'; g.beginPath(); g.arc(x, y, s.footprintRadius, 0, Math.PI * 2); g.stroke(); }
    else if (s.kind === 'village') { g.fillStyle = s.status === 'proposed' ? '#d8d8d8' : '#ffffff'; g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill(); g.stroke(); }
    else { g.fillStyle = '#9fe0ff'; g.beginPath(); g.moveTo(x, y - 8); g.lineTo(x + 7, y + 5); g.lineTo(x - 7, y + 5); g.closePath(); g.fill(); g.stroke(); }
    g.setLineDash([]);
    label(g, s.status === 'proposed' ? `${s.name} (proposed)` : s.name, x, y - (s.kind === 'city' ? 26 : 17), s.kind === 'city' ? '#ffe7a0' : '#ffffff', s.kind === 'city' ? 18 : 14);
  }
  if (!player) {
    for (const r of m.render.regionLabels(bp)) label(g, r.name.toUpperCase(), r.x, r.y, 'rgba(255,255,255,0.7)', 17, 700);
    for (const t of d.territories) {
      const top = t.centre[1] - t.radius - 8;
      label(g, t.name, t.centre[0], top < 14 ? t.centre[1] - t.radius + 16 : top, t.kind === 'nest' ? '#ff9a80' : '#ffcf80', 12);
    }
    const lumen = bp.rivers.find((r) => r.id === 'lumen-river');
    if (lumen) { const p = lumen.pts[Math.floor(lumen.pts.length * 0.8)]; label(g, 'Lumen River', p[0] + 40, p[1] + 4, '#a8d8ff', 12); }
  } else {
    const s = d.discovery.start.at;
    glyph(g, '◉', s[0], s[1] + 14, '#7dfc9a', 16);
    label(g, 'You start here', s[0], s[1] + 30, '#b8ffc8', 11);
  }
  g.restore();
}

/** The world blueprint (designer view with everything) or the map a new player starts with (fog of war). */
export function BlueprintView({ mode }: { mode: 'blueprint' | 'player' }) {
  const [state, setState] = useState(cache);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (!state) setTimeout(() => { void load().then(setState); }, 30); }, [state]);
  useEffect(() => { if (state && ref.current) draw(ref.current, state.bp, state.m, mode === 'player' ? state.start : null); }, [state, mode]);
  if (!state) return <p className="muted" data-testid="blueprint-loading">Building the world blueprint…</p>;
  const { bp } = state;
  const failed = bp.checks.filter((c) => !c.ok);
  const explored = mode === 'player'
    ? bp.data.regions.map((r) => `${r.name} ${state.m.disc.explorationPercent(bp.data, state.start, (x, y) => state.m.bp.regionAt(bp, x, y) === r.id)}%`).join(' · ')
    : '';
  return (
    <div data-testid="blueprint-view">
      <canvas ref={ref} className="continent-canvas" data-testid="blueprint-canvas" />
      {mode === 'blueprint' ? (
        <div className="legend" style={{ marginTop: 8 }}>
          <span>▣ city · ● village · ▲ outpost (dashed = proposed)</span><span style={{ color: '#f2c66d' }}>━ major road</span><span>┄ trail</span>
          <span style={{ color: '#ffe08a' }}>★ known</span><span>◆ rumoured</span><span style={{ color: '#c9a0ff' }}>✧ hidden</span><span style={{ color: '#8ff0ff' }}>fantastical</span>
          <span style={{ color: '#ff9a80' }}>◯ dragon territory ✦ nest ▴ landing</span><span style={{ color: '#ffcf80' }}>┈ flight corridor</span><span>≋ waterfall</span>
        </div>
      ) : <p className="muted small" style={{ marginTop: 8 }} data-testid="blueprint-explored">Explored at start: {explored}</p>}
      {mode === 'blueprint' && (
        <div style={{ marginTop: 10 }} data-testid="blueprint-checks">
          <h3 style={{ margin: '0 0 6px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>
            Geography checks: {bp.checks.length - failed.length} of {bp.checks.length} pass{state.errors.length ? ` · ${state.errors.length} data errors` : ''}
          </h3>
          <ul className="checks">{bp.checks.map((c) => <li key={c.id} className={c.ok ? 'ok' : 'bad'}><b>{c.ok ? '✓' : '✗'} {c.id}</b> {c.detail}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
