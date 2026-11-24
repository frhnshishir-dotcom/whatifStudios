import { useEffect, useRef, useState } from 'react';
import { useUI } from '../store';
import { getWorldIO } from '../persistence';
import { getEngine } from '../engineRef';
import { Icon } from './Icon';
import type { Validation } from '../../persist/format';

/** Two-click confirmation for destructive actions: the first click arms the button for 3 s. */
function useConfirm(): [string | null, (key: string, run: () => void) => void] {
  const [armed, setArmed] = useState<string | null>(null);
  const timer = useRef(0);
  const ask = (key: string, run: () => void) => {
    if (armed === key) { clearTimeout(timer.current); setArmed(null); run(); return; }
    setArmed(key);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setArmed(null), 3000);
  };
  return [armed, ask];
}

const fmtDate = (s: string) => { const d = new Date(s); return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; };
const fmtSize = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);

export function WorldDialog() {
  const open = useUI((s) => s.dialog === 'worlds');
  const setDialog = useUI((s) => s.setDialog);
  const slots = useUI((s) => s.slots);
  const currentSlot = useUI((s) => s.currentSlot);
  const worldName = useUI((s) => s.worldName);
  const seed = useUI((s) => s.seed);
  const saveState = useUI((s) => s.saveState);
  const storageKind = useUI((s) => s.storageKind);
  const [name, setName] = useState(worldName);
  const [newSeed, setNewSeed] = useState(String(seed + 1));
  const [report, setReport] = useState<Validation | null>(null);
  const [armed, ask] = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setName(worldName); }, [worldName, open]);
  useEffect(() => {
    if (!open) return;
    setReport(null);
    void getWorldIO()?.refresh();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDialog(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setDialog]);
  if (!open) return null;
  const io = getWorldIO();
  const dirty = saveState === 'unsaved';
  const commitName = () => { if (name.trim() && name !== worldName) io?.rename(name); };
  const guard = (key: string, run: () => void) => (dirty ? ask(key, run) : run());

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setDialog(null); }}>
      <div className="modal" role="dialog" aria-label="Worlds" data-testid="world-dialog">
        <header className="modal-head">
          <h2>Worlds</h2>
          <button className="icon-btn" onClick={() => setDialog(null)} aria-label="Close" title="Close (Esc)">✕</button>
        </header>

        <section className="modal-sec">
          <h3>This world</h3>
          <div className="row center">
            <input className="text" value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => { if (e.key === 'Enter') commitName(); }} aria-label="World name" data-testid="world-name" maxLength={60} />
            <span className="muted nowrap">seed {seed}</span>
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => { commitName(); void io?.save(currentSlot); }} data-testid="save-current">
              <Icon name="save" size={14} /> {currentSlot ? 'Save' : 'Save to a new slot'} <kbd>Ctrl+S</kbd>
            </button>
            {currentSlot && <button className="btn" onClick={() => { commitName(); void io?.save(null); }} data-testid="save-new">Save as new slot</button>}
          </div>
        </section>

        <section className="modal-sec">
          <h3>Saved in this browser {storageKind && <span className="muted small">({storageKind === 'indexeddb' ? 'IndexedDB' : storageKind === 'localstorage' ? 'localStorage' : 'memory only: not kept after reload'})</span>}</h3>
          {slots.length === 0 && <p className="muted">No saved worlds yet.</p>}
          <ul className="slots" data-testid="slot-list">
            {slots.map((s) => (
              <li key={s.id} className={s.id === currentSlot ? 'current' : ''} data-slot={s.id}>
                {s.thumb ? <img src={s.thumb} alt="" width={56} height={56} /> : <div className="thumb-ph" />}
                <div className="slot-info">
                  <b>{s.id === 'autosave' ? `Autosave · ${s.name}` : s.name}</b>
                  <span className="muted small">seed {s.seed} · {fmtDate(s.savedAt)} · {fmtSize(s.size)}</span>
                </div>
                <div className="slot-actions">
                  <button className="btn" onClick={() => guard(`load:${s.id}`, () => { void io?.load(s.id).then((v) => { if (v.ok) setDialog(null); else setReport(v); }); })} data-testid="load-slot">
                    {armed === `load:${s.id}` ? 'Discard changes?' : 'Load'}
                  </button>
                  <button className="btn danger" onClick={() => ask(`del:${s.id}`, () => { void io?.remove(s.id); })} data-testid="delete-slot" aria-label={`Delete ${s.name}`}>
                    {armed === `del:${s.id}` ? 'Delete?' : '✕'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="modal-sec two">
          <div>
            <h3>New world</h3>
            <div className="row center">
              <input className="text" type="number" min={0} max={999999999} value={newSeed} onChange={(e) => setNewSeed(e.target.value)} aria-label="Seed" data-testid="new-seed" />
              <button className="icon-btn" onClick={() => setNewSeed(String(Math.floor(Math.random() * 1e6)))} title="Random seed" aria-label="Random seed"><Icon name="dice" /></button>
            </div>
            <button className="btn" onClick={() => guard('new', () => { io?.newWorld(Math.max(0, Math.floor(Number(newSeed) || 0))); setDialog(null); })} data-testid="generate">
              {armed === 'new' ? 'Discard changes and generate?' : 'Generate'}
            </button>
          </div>
          <div>
            <h3>File</h3>
            <button className="btn" onClick={() => { const r = io?.exportJSON(); if (r) useUI.getState().showToast(`Exported ${r.name} (${fmtSize(r.size)})`); }} data-testid="export-json">
              <Icon name="download" size={14} /> Export JSON
            </button>
            <button className="btn" onClick={() => fileRef.current?.click()} data-testid="import-json"><Icon name="upload" size={14} /> Import JSON</button>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden data-testid="import-file" onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f || !io) return;
              if (f.size > 64e6) { setReport({ ok: false, errors: ['File is larger than 64 MB.'], warnings: [] }); return; }
              const v = await io.importText(await f.text());
              setReport(v);
              if (v.ok && !v.warnings.length) setDialog(null);
            }} />
          </div>
        </section>

        {report && (
          <section className={`modal-sec report ${report.ok ? 'ok' : 'bad'}`} data-testid="import-report">
            <h3>{report.ok ? 'Imported with warnings' : 'Could not import this file'}</h3>
            <ul>{report.errors.map((e, i) => <li key={`e${i}`} className="err">{e}</li>)}{report.warnings.slice(0, 12).map((w, i) => <li key={`w${i}`} className="warn">{w}</li>)}</ul>
          </section>
        )}
      </div>
    </div>
  );
}

/** Opens the dialog / saves from anywhere (top bar, shortcuts). */
export function useWorldActions() {
  return {
    openWorlds: () => useUI.getState().setDialog('worlds'),
    quickSave: () => { void getWorldIO()?.quickSave(); },
    engine: getEngine,
  };
}
