import { useState } from 'react';
import { useUI } from '../store';
import { getEngine } from '../engineRef';

const STATE_TEXT: Record<string, string> = {
  IDLE: 'Standing, looking around', EXPLORING: 'Exploring', ROAMING: 'Roaming', TAKING_OFF: 'Taking off', FLYING: 'Flying',
  GLIDING: 'Gliding', CIRCLING: 'Circling', DESCENDING: 'Descending', LANDING: 'Landing', WALKING: 'Walking',
  DRINKING: 'Drinking', RESTING: 'Resting', SLEEPING: 'Asleep', INVESTIGATING: 'Investigating', AVOIDING_OBSTACLE: 'Avoiding an obstacle',
};
const GOAL_TEXT: Record<string, string> = {
  explore: 'curious', roam: 'wandering', drink: 'thirsty', rest: 'tired', sleep: 'sleepy', shelter: 'sheltering from rain', investigate: 'investigating', idle: 'idle',
};

function Meter({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  return (
    <div className="meter" title={`${label}: ${Math.round(value * 100)}%`}>
      <span>{label}</span>
      <i><b style={{ width: `${Math.round(value * 100)}%` }} className={tone ?? ''} /></i>
    </div>
  );
}

/** Dragon information and controls (opened by clicking the dragon or the top-bar button). */
export function DragonPanel() {
  const open = useUI((s) => s.dragonOpen);
  useUI((s) => s.stats); // refresh at the stats rate
  const [picking, setPicking] = useState(false);
  const engine = getEngine(), d = engine?.dragon;
  if (!open || !d || !engine) return null;
  const e = d.e, s = d.senses;
  const alt = Math.max(0, e.z - s.ground(e.x, e.y));
  const t = e.target;
  const dist = t ? Math.round(Math.hypot(t.x - e.x, t.y - e.y)) : 0;
  const p = e.personality, n = e.needs;
  const set = (patch: Partial<typeof e>) => { Object.assign(e, patch); useUI.getState().markUnsaved(); };
  return (
    <section className="panel dragon" data-testid="dragon-panel">
      <h3>Dragon <button className="x" onClick={() => useUI.getState().setDragonOpen(false)} aria-label="Close dragon panel">✕</button></h3>
      <div className="dragon-name">{e.name}</div>
      <p className="hint" data-testid="dragon-behaviour">{STATE_TEXT[e.state] ?? e.state}{e.state !== 'SLEEPING' && e.state !== 'RESTING' ? `, ${GOAL_TEXT[e.goal] ?? e.goal}` : ''}{t ? ` → ${t.label}` : ''}</p>
      <dl className="props">
        <dt>Position</dt><dd>{Math.round(e.x)}, {Math.round(e.y)}</dd>
        <dt>Altitude</dt><dd data-testid="dragon-alt">{alt.toFixed(1)} m</dd>
        <dt>Speed</dt><dd>{e.speed.toFixed(1)} m/s</dd>
        {t && <><dt>Destination</dt><dd>{t.label} ({dist} m)</dd></>}
      </dl>
      <div className="meters">
        <Meter label="Energy" value={n.energy} tone={n.energy < 0.25 ? 'warn' : undefined} />
        <Meter label="Thirst" value={n.thirst} tone={n.thirst > 0.75 ? 'warn' : undefined} />
        <Meter label="Comfort" value={n.comfort} />
        <Meter label="Alertness" value={n.alertness} />
      </div>
      <h4>Personality</h4>
      <div className="meters small">
        <Meter label="Curiosity" value={p.curiosity} />
        <Meter label="Boldness" value={p.boldness} />
        <Meter label="Restfulness" value={p.restfulness} />
        <Meter label="Wanderlust" value={p.wanderlust} />
        <Meter label="Sensitivity" value={p.sensitivity} />
      </div>
      <p className="muted small">Remembers {e.memory.landmarks.length} landmarks, {e.memory.water.length} water sources, {e.memory.rest.length} resting places.</p>
      <div className="dragon-controls">
        <button className={`btn${d.follow ? ' on' : ''}`} onClick={() => { d.follow = !d.follow; }} data-testid="dragon-follow">{d.follow ? 'Following' : 'Follow'}</button>
        <button className={`btn${e.autonomous ? ' on' : ''}`} onClick={() => set({ autonomous: !e.autonomous })} data-testid="dragon-auto">{e.autonomous ? 'Autonomous' : 'Holding'}</button>
        <button className={`btn${e.paused ? ' on' : ''}`} onClick={() => set({ paused: !e.paused })} data-testid="dragon-pause">{e.paused ? 'Paused' : 'Pause'}</button>
        <button className={`btn${e.effects ? ' on' : ''}`} onClick={() => set({ effects: !e.effects })} title="Ripples and splashes" data-testid="dragon-effects">Effects</button>
        <button className="btn" onClick={() => { d.reset(engine.home); useUI.getState().markUnsaved(); }} data-testid="dragon-reset">Reset</button>
        <button className={`btn${picking ? ' on' : ''}`} data-testid="dragon-investigate" onClick={() => {
          setPicking(true);
          useUI.getState().showToast('Click a place for the dragon to investigate');
          engine.pickLocation = (i) => { setPicking(false); d.investigate(i % engine.world.w, Math.floor(i / engine.world.w)); useUI.getState().showToast(`${e.name} is coming to look`); };
        }}>{picking ? 'Click the map…' : 'Investigate…'}</button>
      </div>
    </section>
  );
}
