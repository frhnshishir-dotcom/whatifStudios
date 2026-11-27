import { Icon } from '../components/Icon';
import { useUI } from '../store';
import { getEngine } from '../engineRef';
import { getWorldIO } from '../persistence';
import { useLife } from './useLife';
import type { ContinentSession } from '../../world/session';
import './rpg.css';

/** "10:37" from the hour of the day. */
const clock = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;

/**
 * The Play layout's top bar: the world (save slots), where the traveller is (region, nearest village), the time of
 * day, the online state, and save, map, Sandbox (B) and full screen. Every control is an existing action.
 */
export function PlayBar() {
  const lw = useLife(1);
  const worldName = useUI((s) => s.worldName);
  const saveState = useUI((s) => s.saveState);
  const engine = getEngine(), session = engine?.streamer as ContinentSession | undefined;
  const where = engine && session ? session.whereAmI(engine) : null;
  const hour = engine?.env.time ?? 12, night = hour < 6 || hour >= 20;
  const net = lw?.net ?? null;
  return (
    <header className="playbar" data-testid="playbar" aria-label="Game bar">
      <div className="playbar-brand">
        <span className="logo" aria-hidden="true"><Icon name="logo" /></span>
        <button className="playbar-world" onClick={() => useUI.getState().setDialog('worlds')} title="Worlds: save and load" data-testid="open-worlds">{worldName}</button>
      </div>
      {where && (
        <div className="playbar-where" data-testid="play-where" aria-live="polite">
          <b>{where.biome}</b>
          <span>{where.nearest.km < 0.4 ? where.nearest.name : `${where.nearest.name} · ${where.nearest.km.toFixed(1)} km ${where.nearest.bearing}`}</span>
        </div>
      )}
      <span className="playbar-clock" title={night ? 'Night' : 'Day'} data-testid="play-clock"><Icon name={night ? 'moon' : 'sun'} />{clock(hour)}</span>
      {net && <span className={`playbar-online${net.connected ? '' : ' off'}`} data-testid="play-online">{net.connected ? `Online · ${lw!.sim.players.size} here` : 'Reconnecting…'}</span>}
      <span className="grow" />
      <button className="rpg-icon-btn" onClick={() => { void getWorldIO()?.quickSave(); }} title={`Save (Ctrl+S)${saveState === 'saved' ? ' · saved' : ''}`} aria-label="Save" data-testid="quick-save"><Icon name="save" /></button>
      <button className="rpg-icon-btn" onClick={() => useUI.getState().setDialog('continent')} title="World map" aria-label="World map" data-testid="open-continent"><Icon name="map" /></button>
      <button className="rpg-icon-btn rpg-sandbox-btn" onClick={() => useUI.getState().setLayout('sandbox')} title="Sandbox: the editor's tools, the inspector and the world's figures (B)" data-testid="layout-sandbox">
        <Icon name="terrain" /><span className="wide">Sandbox</span><span className="rpg-key wide">B</span>
      </button>
      <button className="rpg-icon-btn playbar-full" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.().catch(() => {}); }} title="Full screen" aria-label="Full screen"><Icon name="expand" /></button>
    </header>
  );
}
