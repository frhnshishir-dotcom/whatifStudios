import { useEffect, useState } from 'react';
import { getEngine } from '../engineRef';
import { useUI } from '../store';
import type { ContinentSession } from '../../world/session';
import type { LivingWorld } from '../../world/life/client';

const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
const bearing = (dx: number, dy: number) => COMPASS[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8];

/** The traveller: stamina, pack, what E does, what lives nearby, the dragons, and the journal. */
function LifeSection({ lw }: { lw: LivingWorld }) {
  const p = lw.player, sim = lw.sim, it = lw.interaction();
  const near = sim.around(p.x, p.y, 120);
  const count = (k: string) => near.filter((a) => a.alive && (a.kind === 'creature' ? a.tag === k : a.kind === k)).length;
  const kinds = ['villager', 'deer', 'wolf', 'bear', 'fox', 'bird'].map((k) => [k, count(k)] as const).filter(([, n]) => n > 0);
  const inv = Object.entries(p.inv).filter(([, n]) => n > 0);
  return (
    <div data-testid="life-panel" style={{ marginTop: 8 }}>
      <dl className="kv">
        <dt>Stamina</dt><dd><span style={{ display: 'inline-block', width: 80, height: 6, background: '#333', verticalAlign: 'middle' }}><span style={{ display: 'block', width: `${Math.round(p.stamina * 100)}%`, height: 6, background: p.running ? '#ffb347' : '#5cc8ff' }} /></span>{p.running ? ' running' : ''}</dd>
        <dt>Pack</dt><dd data-testid="life-inventory">{inv.length ? inv.map(([k, n]) => `${n} ${k}`).join(', ') : 'empty'}</dd>
        <dt>Nearby</dt><dd data-testid="life-nearby">{kinds.length ? kinds.map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`).join(', ') : 'nobody'}</dd>
      </dl>
      {it && <p className="small" data-testid="life-prompt"><b>E</b> {it.label}</p>}
      {lw.message && <p className="small muted" data-testid="life-message">{lw.message}</p>}
      <details style={{ marginTop: 6 }} open>
        <summary className="small">Dragons</summary>
        <ul className="small" data-testid="life-dragons" style={{ margin: '4px 0', paddingLeft: 16 }}>
          {sim.dragons.dragons.map((d) => {
            const km = Math.hypot(d.x - p.x, d.y - p.y) / 1000;
            return (
              <li key={d.id}>{d.name} · {d.st} · {km.toFixed(1)} km {bearing(d.x - p.x, d.y - p.y)}{d.alt > 1 ? ` · ${Math.round(d.alt)} m up` : ''}{' '}
                <button className="btn" style={{ padding: '0 6px' }} onClick={() => { lw.follow = lw.follow === d.id ? 'player' : d.id; const t = lw.follow === 'player' ? p : d; if (!lw.q.detailed(t.x, t.y)) lw.session.loadAt(lw.engine, lw.session.bp.coords.cellToMap([t.x, t.y])); }} data-testid={`watch-${d.id}`}>{lw.follow === d.id ? 'Back' : 'Watch'}</button>
              </li>
            );
          })}
        </ul>
      </details>
      <details style={{ marginTop: 4 }}>
        <summary className="small">Journal</summary>
        <ul className="small muted" data-testid="life-journal" style={{ margin: '4px 0', paddingLeft: 16 }}>{sim.log.slice(-6).reverse().map((l, k) => <li key={k}>{l.text}</li>)}</ul>
      </details>
      <p className="muted small" style={{ marginTop: 4 }}>WASD walk · Shift run · E interact · F watch the nearest dragon</p>
    </div>
  );
}

const SPEEDS: Array<[string, number]> = [['Walk (1.4 m/s)', 1.4], ['Run (5 m/s)', 5], ['Horse (8 m/s)', 8], ['Dragon flight (30 m/s)', 30], ['Fast test (300 m/s)', 300]];

const fmtTime = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

/** Continent mode: where the view is, travel between villages, and the streaming figures. */
export function ContinentPanel() {
  const mode = useUI((s) => s.mode);
  const showToast = useUI((s) => s.showToast);
  const [tick, setTick] = useState(0);
  const [dest, setDest] = useState('greenhaven');
  const [speed, setSpeed] = useState(8);
  useEffect(() => { if (mode !== 'continent') return; const t = setInterval(() => setTick((n) => n + 1), 400); return () => clearInterval(t); }, [mode]);
  if (mode !== 'continent') return null;
  const engine = getEngine(), session = engine?.streamer as ContinentSession | undefined;
  if (!engine || !session) return null;
  void tick;
  const here = session.whereAmI(engine);
  const villages = session.bp.data.settlements;
  const t = session.travel;
  const go = () => {
    const v = villages.find((s) => s.id === dest)!;
    const L = session.startTravel(engine, v.at, speed, v.name);
    if (L === null) showToast(`No route to ${v.name}`);
    else showToast(`Travelling to ${v.name}: ${(L / 1000).toFixed(1)} km, about ${fmtTime(L / speed)}`);
  };
  return (
    <section className="panel" data-testid="continent-panel">
      <h3>Continent</h3>
      <dl className="kv" data-testid="continent-where">
        <dt>Position</dt><dd>{here.map[0].toFixed(1)}, {here.map[1].toFixed(1)} ({(here.map[0] / 10).toFixed(2)} km E, {(here.map[1] / 10).toFixed(2)} km S)</dd>
        <dt>Region</dt><dd>{here.biome} · {here.region}</dd>
        <dt>Height</dt><dd>{Math.round(here.elevation)} m</dd>
        <dt>Nearest</dt><dd>{here.nearest.name}, {here.nearest.km.toFixed(1)} km {here.nearest.bearing}</dd>
      </dl>
      <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
        <select value={dest} onChange={(e) => setDest(e.target.value)} data-testid="travel-dest">{villages.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} data-testid="travel-speed">{SPEEDS.map(([n, v]) => <option key={v} value={v}>{n}</option>)}</select>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn" onClick={go} data-testid="travel-go">Travel</button>
          <button className="btn" onClick={() => session.stopTravel()} disabled={!t} data-testid="travel-stop">Stop</button>
        </div>
      </div>
      {t && <p className="muted small" data-testid="travel-progress" style={{ marginTop: 6 }}>To {session.travelTo}: {((t.length - t.progress) / 1000).toFixed(1)} km left, {fmtTime((t.length - t.progress) / t.speed)}</p>}
      {session.life && <LifeSection lw={session.life as unknown as LivingWorld} />}
      <p className="muted small" style={{ marginTop: 6 }} data-testid="stream-stats">
        Window 768 × 768 m · {session.stats.shifts} moves (last {session.stats.lastShiftMs.toFixed(0)} ms) · {session.cache.size} regions cached · slowest region {session.cache.stats.maxMs.toFixed(0)} ms
      </p>
    </section>
  );
}
