import { Icon } from './Icon';
import { useUI } from '../store';
import { getEngine } from '../engineRef';

export function BottomBar() {
  const paused = useUI((s) => s.paused);
  const speed = useUI((s) => s.speed);
  const setSpeed = useUI((s) => s.setSpeed);
  const stats = useUI((s) => s.stats);
  const toggle = () => getEngine()?.setPaused(!paused);
  return (
    <footer className="bottombar">
      <button className="icon-btn" onClick={toggle} title="Pause / resume (Space)" aria-label={paused ? 'Resume' : 'Pause'} data-testid="play-pause">
        <Icon name={paused ? 'play' : 'pause'} />
      </button>
      <div className="seg" role="group" aria-label="Simulation speed">
        {[0.5, 1, 2, 4].map((v) => (
          <button key={v} className={speed === v ? 'active' : ''} onClick={() => { setSpeed(v); getEngine()?.setSpeed(v); }}>{v}×</button>
        ))}
      </div>
      {stats && (
        <div className="clock" title="Time of day" data-testid="bottom-clock">
          <Icon name={stats.time >= 6 && stats.time < 18.5 ? 'sun' : 'moon'} size={14} />
          {String(Math.floor(stats.time)).padStart(2, '0')}:{String(Math.floor((stats.time % 1) * 60)).padStart(2, '0')}
          {stats.rain > 0.05 && <Icon name="rain" size={14} />}{stats.fog > 0.05 && <Icon name="fog" size={14} />}
        </div>
      )}
      <div className="spacer" />
      {stats && (
        <div className="perf" data-testid="perf">
          <span title="Frames per second"><b>{stats.fps.toFixed(0)}</b> fps</span>
          <span title={stats.simMode === 'worker' ? 'Water step time (Web Worker, shared memory)' : 'Simulation time per frame (main thread)'}>sim <b>{stats.simMs.toFixed(1)}</b> ms{stats.simMode === 'worker' ? '/step·worker' : ''}</span>
          <span title="Water volume (m³) and active 16×16 chunks">water <b>{Math.round(stats.water)}</b> m³ · {stats.activeChunks} chunks</span>
          <span title="World to cell composition">compose <b>{stats.composeMs.toFixed(1)}</b> ms</span>
          <span title={stats.presenter === 'webgl2' ? 'GPU presenter: texture upload and draw call (CPU side)' : 'Pixel blit (changed cells only)'}>{stats.presenter === 'webgl2' ? 'gpu' : 'blit'} <b>{stats.blitMs.toFixed(1)}</b> ms</span>
          <span title="Visible character grid">{stats.cols}×{stats.rows}</span>
          <span title="Cells redrawn this frame">{stats.drawnCells} redrawn</span>
        </div>
      )}
    </footer>
  );
}
