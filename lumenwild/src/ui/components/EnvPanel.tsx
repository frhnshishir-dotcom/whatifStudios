import { useState } from 'react';
import { useUI } from '../store';
import { getEngine } from '../engineRef';
import { WEATHER_PRESETS, type EnvState } from '../../engine/env/Environment';
import { Icon } from './Icon';

const fmtTime = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;

/** Time of day and weather controls. The engine owns the values; the panel reads them through the 4 Hz stats. */
export function EnvPanel() {
  const stats = useUI((s) => s.stats);
  const [, force] = useState(0);
  const env = getEngine()?.env;
  if (!env) return null;
  const T = env.target;
  const set = (p: Partial<EnvState>) => { env.set(p); useUI.getState().markUnsaved(); force((n) => n + 1); };
  const time = stats?.time ?? env.time;
  const preset = Object.entries(WEATHER_PRESETS).find(([, v]) => v.rain === T.rain && v.fog === T.fog && v.wind === T.wind)?.[0];
  return (
    <section className="panel" data-testid="env-panel">
      <h3>Environment</h3>
      <label className="field">
        <span><span className="lbl"><Icon name="sun" size={13} /> Time of day</span> <em data-testid="clock">{fmtTime(time)}</em></span>
        <input type="range" min={0} max={23.99} step={0.05} value={time} onChange={(e) => set({ time: Number(e.target.value) })} data-testid="time-slider" />
      </label>
      <label className="check"><input type="checkbox" checked={T.cycle} onChange={(e) => set({ cycle: e.target.checked })} data-testid="cycle" /> Day–night cycle ({Math.round(T.dayLength / 60)} min per day)</label>
      <div className="seg wide presets" role="group" aria-label="Weather">
        {Object.keys(WEATHER_PRESETS).map((k) => (
          <button key={k} className={preset === k ? 'active' : ''} onClick={() => set(WEATHER_PRESETS[k])} data-weather={k}>{k[0].toUpperCase() + k.slice(1)}</button>
        ))}
      </div>
      <label className="field"><span><span className="lbl"><Icon name="rain" size={13} /> Rain</span> <em>{Math.round(T.rain * 100)}%</em></span>
        <input type="range" min={0} max={1} step={0.05} value={T.rain} onChange={(e) => set({ rain: Number(e.target.value) })} data-testid="rain" /></label>
      <label className="field"><span><span className="lbl"><Icon name="fog" size={13} /> Fog</span> <em>{Math.round(T.fog * 100)}%</em></span>
        <input type="range" min={0} max={1} step={0.05} value={T.fog} onChange={(e) => set({ fog: Number(e.target.value) })} data-testid="fog" /></label>
      <label className="field"><span><span className="lbl"><Icon name="wind" size={13} /> Wind</span> <em>{Math.round(T.wind * 100)}%</em></span>
        <input type="range" min={0} max={1} step={0.05} value={T.wind} onChange={(e) => set({ wind: Number(e.target.value) })} data-testid="wind" /></label>
      <div className="seg wide" role="group" aria-label="Wind direction">
        <button className={T.windDir < 0 ? 'active' : ''} onClick={() => set({ windDir: -1 })}>← West</button>
        <button className={T.windDir > 0 ? 'active' : ''} onClick={() => set({ windDir: 1 })}>East →</button>
      </div>
    </section>
  );
}
