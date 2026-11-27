import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLife } from './useLife';
import { NoticeReader, TargetPicker, questProgress, speciesName, type Notice } from './hudModel';
import { maxHp, xpToNext } from '../../world/rpg/hero';
import type { LivingWorld } from '../../world/life/client';
import './rpg.css';

/**
 * The RPG HUD over the world (continent mode): the character plate, the creature being fought, quests in progress,
 * notices, the level-up banner, the interaction prompt (click it, or press E), and on touch screens a movement stick
 * and action buttons. Everything is read from the living world and every action is an existing one (the rules decide
 * offline; the server decides online).
 */

const now = () => performance.now() / 1000;

export function Bar({ kind, frac, label, testid, aria }: { kind: 'hp' | 'st' | 'xp'; frac: number; label?: ReactNode; testid?: string; aria: string }) {
  const pct = Math.max(0, Math.min(100, frac * 100));
  return (
    <div className={`rpg-bar ${kind}`} role="meter" aria-label={aria} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <div className="rpg-bar-fill" style={{ width: `${pct}%` }} />
      {label !== undefined && <span className="rpg-bar-label" data-testid={testid}>{label}</span>}
    </div>
  );
}

function CharacterPlate({ lw }: { lw: LivingWorld }) {
  const p = lw.player, h = p.hero, mh = maxHp(h), next = xpToNext(h.level), hp = Math.max(0, Math.ceil(h.hp));
  return (
    <section className={`rpg-plate${h.dead >= 0 ? ' down' : ''}`} aria-label="Character" data-testid="hud-plate">
      <div className="rpg-crest" title={`Level ${h.level}`}><span data-testid="hud-level"><small>Lv</small> {h.level}</span></div>
      <div className="rpg-plate-body">
        <div className="rpg-plate-name">
          <span data-testid="hud-name">{p.name}</span>
          {h.points > 0 && <span className="rpg-points" title={`${h.points} attribute point${h.points > 1 ? 's' : ''} to spend`} data-testid="hud-points">+{h.points}</span>}
        </div>
        <Bar kind="hp" frac={h.hp / mh} label={`${hp} / ${mh}`} testid="hud-hp" aria={`Health ${hp} of ${mh}`} />
        <Bar kind="st" frac={p.stamina} aria={`Stamina ${Math.round(p.stamina * 100)} percent`} />
        <Bar kind="xp" frac={h.xp / next} label={`${h.xp} / ${next} xp`} testid="hud-xp" aria={`Experience ${h.xp} of ${next}`} />
      </div>
    </section>
  );
}

function TargetFrame({ lw, picker }: { lw: LivingWorld; picker: TargetPicker }) {
  const t = picker.pick(lw, now());
  if (!t) return null;
  const hp = Math.ceil(t.hp);
  return (
    <section className={`rpg-target${t.slain ? ' slain' : ''}`} data-testid="target-frame" aria-label="Target" aria-live="polite">
      <div className="rpg-target-name">
        {t.hostile && !t.slain && <span className="rpg-hostile" title="Fighting you" />}
        <span data-testid="target-name">{speciesName(t.c.sp)}</span>
        {t.slain && <em> · slain</em>}
      </div>
      <Bar kind="hp" frac={t.hp / t.max} label={`${hp} / ${t.max}`} testid="target-hp" aria={`${speciesName(t.c.sp)} health ${hp} of ${t.max}`} />
    </section>
  );
}

function QuestTracker({ lw }: { lw: LivingWorld }) {
  const h = lw.player.hero;
  if (!h.quests.length) return null;
  return (
    <aside className="rpg-tracker" aria-label="Quests in progress" data-testid="quest-tracker">
      <h4>Quests</h4>
      <ol>
        {h.quests.map((q) => {
          const pr = questProgress(h, q);
          return (
            <li key={q.id} className={pr.ready ? 'ready' : ''} data-testid="tracker-quest">
              <b>{q.title}</b>
              <span>{pr.ready ? `Return to ${q.giverName}` : `${pr.have} / ${pr.need}`}</span>
              {!pr.ready && <div className="rpg-mini"><i style={{ width: `${(pr.have / pr.need) * 100}%` }} /></div>}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function Notices({ list }: { list: Notice[] }) {
  if (!list.length) return null;
  return (
    <div className="rpg-notices" aria-live="polite" data-testid="notices">
      {list.map((n) => <div key={n.id} className={`rpg-notice ${n.kind}`} data-testid="notice">{n.text}</div>)}
    </div>
  );
}

function Prompt({ lw }: { lw: LivingWorld }) {
  const it = lw.interaction();
  if (!it) return null;
  return (
    <button className="rpg-prompt" data-testid="hud-prompt" onClick={() => lw.interact()} title="Press E (or tap)">
      <kbd>E</kbd>{it.label}
    </button>
  );
}

/** Touch screens: a movement stick (the same input the keyboard gives) and the action buttons. */
function TouchControls({ lw }: { lw: LivingWorld }) {
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState<[number, number]>([0, 0]);
  const attackT = useRef(0);
  const move = (ev: React.PointerEvent) => {
    const r = base.current!.getBoundingClientRect(), R = r.width / 2;
    const dx = ev.clientX - (r.left + R), dy = ev.clientY - (r.top + R), d = Math.hypot(dx, dy), m = Math.min(1, d / R);
    const k = d > 0 ? Math.min(d, R) / d : 0;
    setKnob([dx * k, dy * k]);
    lw.input = m > 0.18 ? { dx: dx / d, dy: dy / d, run: m > 0.92 } : { dx: 0, dy: 0, run: false };
  };
  const release = () => { setKnob([0, 0]); lw.input = null; };
  const stopAttack = () => { clearInterval(attackT.current); attackT.current = 0; };
  useEffect(() => () => { stopAttack(); lw.input = null; }, [lw]);
  return (
    <div className="rpg-touch" data-testid="touch-controls">
      <div className="rpg-stick" ref={base} aria-label="Move" role="application"
        onPointerDown={(e) => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable: still steer */ } move(e); }} onPointerMove={(e) => { if (e.buttons || e.pointerType === 'touch') move(e); }}
        onPointerUp={release} onPointerCancel={release}>
        <div className="rpg-stick-knob" style={{ transform: `translate(${knob[0]}px, ${knob[1]}px)` }} />
      </div>
      <div className="rpg-actions">
        <button className="rpg-act big" aria-label="Attack" data-testid="touch-attack"
          onPointerDown={() => { lw.attack(); stopAttack(); attackT.current = window.setInterval(() => lw.attack(), 120); }}
          onPointerUp={stopAttack} onPointerCancel={stopAttack} onPointerLeave={stopAttack}>Attack</button>
        <button className="rpg-act" aria-label="Dodge" onClick={() => lw.dodge()}>Dodge</button>
        <button className="rpg-act" aria-label="Eat" onClick={() => lw.command({ t: 'use' })}>Eat</button>
      </div>
    </div>
  );
}

const coarse = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

export function RpgHud({ layout }: { layout: 'play' | 'sandbox' }) {
  const lw = useLife(10);
  const reader = useRef(new NoticeReader()), picker = useRef(new TargetPicker());
  const notices = useRef<Notice[]>([]), levelSeq = useRef(-1), banner = useRef<{ level: number; at: number } | null>(null);
  if (!lw) return null;
  const t = now();
  // New notices and level-ups since the last render (the readers keep their place).
  notices.current.push(...reader.current.read(lw, t));
  notices.current = notices.current.filter((n) => t - n.at < 6).slice(-4);
  for (const r of lw.recent) {
    if (r.seq <= levelSeq.current) continue;
    if (levelSeq.current >= 0 && r.ev.e === 'level' && r.ev.who === lw.me) banner.current = { level: r.ev.level, at: t };
  }
  levelSeq.current = Math.max(levelSeq.current, lw.recent.at(-1)?.seq ?? 0);
  if (banner.current && t - banner.current.at > 4) banner.current = null;
  const play = layout === 'play', touch = play && coarse();
  return (
    <div className={`rpg-hud ${layout}${touch ? ' touch' : ''}`} data-testid="rpg-hud">
      <TargetFrame lw={lw} picker={picker.current} />
      {banner.current && (
        <div className="rpg-levelup" role="status" data-testid="level-banner">
          <span className="kicker">Level up</span>
          <strong>Level {banner.current.level}</strong>
          {lw.player.hero.points > 0 && <span>{lw.player.hero.points} attribute points to spend</span>}
        </div>
      )}
      {play && <QuestTracker lw={lw} />}
      <Notices list={notices.current} />
      <CharacterPlate lw={lw} />
      <Prompt lw={lw} />
      {touch ? <TouchControls lw={lw} /> : play && (
        <div className="rpg-keys" aria-hidden="true"><span><kbd>Space</kbd>Attack</span><span><kbd>Q</kbd>Dodge</span><span><kbd>H</kbd>Eat</span><span><kbd>E</kbd>Interact</span></div>
      )}
    </div>
  );
}
