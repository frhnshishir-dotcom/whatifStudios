import { useEffect, useState } from 'react';
import { getEngine } from '../engineRef';
import { useUI } from '../store';
import type { ContinentSession } from '../../world/session';

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
      <p className="muted small" style={{ marginTop: 6 }} data-testid="stream-stats">
        Window 768 × 768 m · {session.stats.shifts} moves (last {session.stats.lastShiftMs.toFixed(0)} ms) · {session.cache.size} regions cached · slowest region {session.cache.stats.maxMs.toFixed(0)} ms
      </p>
    </section>
  );
}
