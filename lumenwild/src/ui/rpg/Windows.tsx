import { useEffect, useState, type ReactNode, type MouseEvent } from 'react';
import { useUI } from '../store';
import { useLife } from './useLife';
import { Bar } from './RpgHud';
import { questProgress } from './hudModel';
import { Icon } from '../components/Icon';
import type { LivingWorld } from '../../world/life/client';
import type { RpgCmd } from '../../world/rpg/Rpg';
import { ITEMS, RARITY, SLOTS, itemName, itemStats, itemValue, type Item, type ItemKind, type Slot } from '../../world/rpg/items';
import { RECIPES, SKILLS, STATION_NAMES } from '../../world/rpg/content';
import { ATTR_NAMES, maxHp, xpToNext, sLevel, skillXpFor, attackDamage, attackCooldown, armourOf, critChance, count, type Attr } from '../../world/rpg/hero';
import './rpg.css';

/**
 * The RPG windows over the world (Play): Character (C), Inventory (I), Journal (J), Crafting (K), and the dock that
 * opens them. They read the character and the rules' view from the living world and send the existing commands
 * (offline the rules apply them at once; online the server decides and the window follows its answer).
 */

type WinId = NonNullable<ReturnType<typeof useUI.getState>['rpgWindow']>;
export const WINDOWS: Array<{ id: WinId; title: string; key: string; icon: string }> = [
  { id: 'character', title: 'Character', key: 'C', icon: 'person' },
  { id: 'inventory', title: 'Inventory', key: 'I', icon: 'bag' },
  { id: 'journal', title: 'Journal', key: 'J', icon: 'book' },
  { id: 'craft', title: 'Crafting', key: 'K', icon: 'hammer' },
];

const KIND_ICON: Record<ItemKind, string> = { weapon: 'sword', armour: 'shield', trinket: 'gem', resource: 'ore', food: 'bread', potion: 'flask', trophy: 'fang', quest: 'scroll' };
const SLOT_NAMES: Record<Slot, string> = { weapon: 'Weapon', head: 'Head', body: 'Body', hands: 'Hands', feet: 'Feet', trinket: 'Trinket' };

/** A window button: acts, then gives the keyboard back to the game (Space must attack, not press it again). */
function Btn({ onClick, children, disabled, testid, kind = '', title }: { onClick: () => void; children: ReactNode; disabled?: boolean; testid?: string; kind?: string; title?: string }) {
  return (
    <button className={`rpg-btn ${kind}`} disabled={disabled} data-testid={testid} title={title}
      onClick={(e: MouseEvent<HTMLButtonElement>) => { onClick(); e.currentTarget.blur(); }}>{children}</button>
  );
}

function ItemIcon({ it, size = 18 }: { it: Item; size?: number }) {
  return <span className="rpg-item-icon" style={{ color: RARITY[it.r].colour }}><Icon name={KIND_ICON[ITEMS[it.id].kind]} size={size} /></span>;
}

/** The dock: the four windows, with their keys (and, with a keyboard, the fighting keys). */
export function RpgDock({ touch }: { touch: boolean }) {
  const open = useUI((s) => s.rpgWindow);
  return (
    <nav className={`rpg-dock${touch ? ' touch' : ''}`} aria-label="Windows" data-testid="rpg-dock">
      {!touch && <div className="rpg-dock-keys" aria-hidden="true"><span><kbd>Space</kbd>Attack</span><span><kbd>Q</kbd>Dodge</span><span><kbd>H</kbd>Eat</span><span><kbd>E</kbd>Interact</span></div>}
      <div className="rpg-dock-row">
        {WINDOWS.map((w) => (
          <button key={w.id} className={`rpg-dock-btn${open === w.id ? ' open' : ''}`} onClick={(e) => { useUI.getState().toggleRpgWindow(w.id); e.currentTarget.blur(); }}
            title={`${w.title} (${w.key})`} aria-pressed={open === w.id} data-testid={`open-${w.id}`}>
            <Icon name={w.icon} size={18} /><span className="label">{w.title}</span>{!touch && <kbd>{w.key}</kbd>}
          </button>
        ))}
      </div>
    </nav>
  );
}

export function RpgWindows() {
  const win = useUI((s) => s.rpgWindow);
  const lw = useLife(4);
  if (!lw || !win) return null;
  const meta = WINDOWS.find((w) => w.id === win)!;
  const cmd = (c: RpgCmd) => lw.command(c);
  return (
    <section className={`rpg-window ${win}`} role="dialog" aria-labelledby="rpg-window-title" data-testid={`window-${win}`}>
      <header className="rpg-window-head">
        <span className="rpg-window-icon"><Icon name={meta.icon} size={18} /></span>
        <h2 id="rpg-window-title">{meta.title}</h2>
        <kbd className="rpg-window-key">{meta.key}</kbd>
        <button className="rpg-close" onClick={() => useUI.getState().setRpgWindow(null)} aria-label="Close (Esc)" title="Close (Esc)" data-testid="window-close"><Icon name="close" size={16} /></button>
      </header>
      <div className="rpg-window-body">
        {win === 'character' && <CharacterWindow lw={lw} cmd={cmd} />}
        {win === 'inventory' && <InventoryWindow lw={lw} cmd={cmd} />}
        {win === 'journal' && <JournalWindow lw={lw} cmd={cmd} />}
        {win === 'craft' && <CraftWindow lw={lw} cmd={cmd} />}
        {lw.net && <p className="rpg-note">Online: the world server decides every action; this window shows its answer.</p>}
      </div>
    </section>
  );
}

type WinProps = { lw: LivingWorld; cmd: (c: RpgCmd) => void };

// ---------------------------------------------------------------- Character

function NameField({ lw }: { lw: LivingWorld }) {
  const [name, setName] = useState(lw.player.name), [err, setErr] = useState('');
  useEffect(() => setName(lw.player.name), [lw.player.name]);
  if (lw.net) return <p className="rpg-name-fixed"><b data-testid="char-name">{lw.player.name}</b> <span className="rpg-dim">· the name you joined with</span></p>;
  const save = () => { if (lw.rename(name)) setErr(''); else setErr('1–24 letters, digits, spaces, apostrophes, hyphens or dots, starting with a letter or digit.'); };
  return (
    <form className="rpg-name" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <label htmlFor="rpg-name-input">Name your traveller</label>
      <div className="rpg-name-row">
        <input id="rpg-name-input" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} data-testid="char-name-input" autoComplete="off" spellCheck={false} />
        <button className="rpg-btn primary" type="submit" disabled={name.trim() === lw.player.name} data-testid="char-name-save">Save</button>
      </div>
      {err ? <p className="rpg-err">{err}</p> : <p className="rpg-dim">Kept with this continent's save.</p>}
    </form>
  );
}

function CharacterWindow({ lw, cmd }: WinProps) {
  const h = lw.player.hero, st = h.stats, mh = maxHp(h), next = xpToNext(h.level);
  const kills = Object.entries(st.kills).map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`).join(', ') || 'none yet';
  return (
    <div className="rpg-char">
      <NameField lw={lw} />
      <div className="rpg-char-top">
        <div className="rpg-crest big"><span data-testid="char-level"><small>Level</small> {h.level}</span></div>
        <div className="rpg-char-bars">
          <Bar kind="hp" frac={h.hp / mh} label={`${Math.max(0, Math.ceil(h.hp))} / ${mh}`} aria={`Health ${Math.ceil(h.hp)} of ${mh}`} />
          <Bar kind="xp" frac={h.xp / next} label={`${h.xp} / ${next} xp`} testid="char-xp" aria={`Experience ${h.xp} of ${next}`} />
          <p className="rpg-dim">Home: {h.homeName} · {h.coins} coins</p>
        </div>
      </div>
      <h3>Attributes {h.points > 0 && <span className="rpg-points" data-testid="char-points">{h.points} to spend</span>}</h3>
      <ul className="rpg-attrs">
        {(Object.keys(ATTR_NAMES) as Attr[]).map((a) => (
          <li key={a}>
            <span>{ATTR_NAMES[a]}</span><b data-testid={`attr-${a}`}>{h.attrs[a]}</b>
            {h.points > 0 && <Btn onClick={() => cmd({ t: 'spend', attr: a })} testid={`spend-${a}`} kind="small" title={`Raise ${ATTR_NAMES[a]}`}>+</Btn>}
          </li>
        ))}
      </ul>
      <dl className="rpg-derived">
        <dt>Attack</dt><dd data-testid="char-attack">{attackDamage(h).toFixed(1)} every {attackCooldown(h).toFixed(2)} s</dd>
        <dt>Critical</dt><dd>{Math.round(critChance(h) * 100)}%</dd>
        <dt>Armour</dt><dd data-testid="char-armour">{armourOf(h).toFixed(1)}</dd>
        <dt>Health</dt><dd>{mh}</dd>
      </dl>
      <h3>Skills</h3>
      <ul className="rpg-skills" data-testid="char-skills">
        {SKILLS.map((s) => {
          const lv = sLevel(h, s), a = skillXpFor(lv), b = skillXpFor(lv + 1);
          return <li key={s}><span>{s[0].toUpperCase() + s.slice(1)}</span><b>{lv}</b><div className="rpg-mini"><i style={{ width: `${Math.min(100, ((h.skills[s] - a) / (b - a)) * 100)}%` }} /></div></li>;
        })}
      </ul>
      <h3>Record</h3>
      <p className="rpg-record">Slain: {kills}. Falls {st.deaths} · crafted {st.crafted} · gathered {st.gathered} · quests {st.quests} · places found {h.found.length} · damage dealt {st.dmgDealt}, taken {st.dmgTaken}.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Inventory

function InventoryWindow({ lw, cmd }: WinProps) {
  const h = lw.player.hero, [sel, setSel] = useState<string | null>(null);
  const picked = h.inv.find((i) => i.uid === sel) ?? null;
  const d = picked ? ITEMS[picked.id] : null;
  return (
    <div className="rpg-inv">
      <h3>Equipped</h3>
      <ul className="rpg-equip" data-testid="inv-equipped">
        {SLOTS.map((s) => {
          const it = h.equip[s];
          return (
            <li key={s} className={it ? 'filled' : ''} data-testid={`slot-${s}`}>
              <span className="rpg-slot-name">{SLOT_NAMES[s]}</span>
              {it ? <>
                <ItemIcon it={it} />
                <span className="rpg-slot-item" title={`${itemName(it)} · ${itemStats(it)}`}><b style={{ color: RARITY[it.r].colour }}>{itemName(it)}</b><small>{itemStats(it)}</small></span>
                <Btn onClick={() => cmd({ t: 'unequip', slot: s })} kind="small" testid={`unequip-${s}`} title="Take off">Remove</Btn>
              </> : <span className="rpg-dim">—</span>}
            </li>
          );
        })}
      </ul>
      <h3>Pack <span className="rpg-dim">{h.inv.length} / 24 · <b data-testid="inv-coins">{h.coins}</b> coins</span></h3>
      <div className="rpg-grid" data-testid="inv-grid" role="listbox" aria-label="Pack">
        {Array.from({ length: 24 }, (_, k) => {
          const it = h.inv[k];
          if (!it) return <div key={`e${k}`} className="rpg-tile empty" aria-hidden="true" />;
          return (
            <button key={it.uid} className={`rpg-tile${sel === it.uid ? ' sel' : ''}`} style={{ borderColor: it.r > 0 ? RARITY[it.r].colour : undefined }}
              onClick={(e) => { setSel(sel === it.uid ? null : it.uid); e.currentTarget.blur(); }} title={itemName(it)} role="option" aria-selected={sel === it.uid} data-testid={`item-${it.id}`}>
              <ItemIcon it={it} size={20} />
              <span className="rpg-tile-name">{itemName(it)}</span>
              {it.n > 1 && <span className="rpg-tile-n">{it.n}</span>}
            </button>
          );
        })}
      </div>
      {picked && d && (
        <div className="rpg-detail" data-testid="item-detail">
          <div className="rpg-detail-head"><ItemIcon it={picked} size={22} /><b style={{ color: RARITY[picked.r].colour }}>{itemName(picked)}{picked.n > 1 ? ` ×${picked.n}` : ''}</b><span className="rpg-dim">{RARITY[picked.r].name} {d.kind}{d.slot ? ` · ${SLOT_NAMES[d.slot]}` : ''}</span></div>
          <p>{d.desc}</p>
          {itemStats(picked) && <p className="rpg-dim">{itemStats(picked)}</p>}
          <p className="rpg-dim">Worth about {itemValue(picked)} coins.</p>
          <div className="rpg-actions-row">
            {d.slot && <Btn onClick={() => cmd({ t: 'equip', uid: picked.uid })} kind="primary" testid="item-equip">Equip</Btn>}
            {(d.heal || d.rest) && <Btn onClick={() => cmd({ t: 'use', uid: picked.uid })} kind="primary" testid="item-use">{d.kind === 'potion' ? 'Drink' : 'Eat'}</Btn>}
            {d.kind !== 'quest' && <Btn onClick={() => { cmd({ t: 'drop', uid: picked.uid }); setSel(null); }} testid="item-drop">Drop</Btn>}
          </div>
        </div>
      )}
      {!h.inv.length && <p className="rpg-dim">Your pack is empty.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Journal

function JournalWindow({ lw, cmd }: WinProps) {
  const h = lw.player.hero, view = lw.view();
  return (
    <div className="rpg-journal">
      {view.offer && (
        <div className="rpg-offer" data-testid="journal-offer">
          <span className="rpg-kicker">Offered by {view.offer.giverName}</span>
          <b>{view.offer.title}</b>
          <p>{view.offer.text}</p>
          <p className="rpg-dim">Reward: {view.offer.reward.xp} xp, {view.offer.reward.coins} coins{view.offer.reward.item ? `, ${ITEMS[view.offer.reward.item].name}` : ''}</p>
          <Btn onClick={() => cmd({ t: 'accept' })} kind="primary" testid="journal-accept">Accept</Btn>
        </div>
      )}
      <h3>Quests <span className="rpg-dim">{h.quests.length} of 5 · {h.stats.quests} completed</span></h3>
      {h.quests.length ? (
        <ol className="rpg-quests" data-testid="journal-quests">
          {h.quests.map((q) => {
            const p = questProgress(h, q);
            return (
              <li key={q.id} className={p.ready ? 'ready' : ''}>
                <div className="rpg-quest-head"><b>{q.title}</b><span>{p.ready ? `Return to ${q.giverName}` : `${p.have} / ${p.need}`}</span></div>
                <p>{q.text}</p>
                <div className="rpg-mini"><i style={{ width: `${(p.have / p.need) * 100}%` }} /></div>
                <p className="rpg-dim">From {q.giverName} · reward {q.reward.xp} xp, {q.reward.coins} coins{q.reward.item ? `, ${ITEMS[q.reward.item].name}` : ''}</p>
                <Btn onClick={() => cmd({ t: 'abandon', qid: q.id })} kind="small" testid={`abandon-${q.id}`}>Abandon</Btn>
              </li>
            );
          })}
        </ol>
      ) : <p className="rpg-dim">No quests yet. Villagers with a gold “!” over them have work; talk to them with E.</p>}
      <h3>The world</h3>
      <ul className="rpg-log" data-testid="journal-log">
        {lw.sim.log.slice(-15).reverse().map((l, k) => <li key={k}>{l.text}</li>)}
        {!lw.sim.log.length && <li className="rpg-dim">Nothing yet.</li>}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- Crafting

function CraftWindow({ lw, cmd }: WinProps) {
  const h = lw.player.hero, here = lw.stationsHere();
  const stations = [...here].filter((s) => s !== 'none').map((s) => STATION_NAMES[s]);
  return (
    <div className="rpg-craft">
      <p className="rpg-dim">{stations.length ? `Here: ${stations.join(', ')}.` : 'No workshop here: only recipes that can be made anywhere. Workbenches, forges, hearths and herbalists\' tables are in the villages.'}</p>
      <ul className="rpg-recipes" data-testid="craft-recipes">
        {RECIPES.map((r) => {
          const has = r.inputs.every(([id, n]) => count(h, id) >= n), skill = sLevel(h, r.skill) >= r.level, at = here.has(r.station);
          const why = !at ? `Needs ${STATION_NAMES[r.station]}` : !skill ? `Needs ${r.skill} ${r.level}` : !has ? 'Missing materials' : '';
          const out = { uid: '', id: r.out, n: 1, r: 0 } as Item;
          return (
            <li key={r.id} className={at && skill && has ? 'ready' : ''}>
              <ItemIcon it={out} />
              <div className="rpg-recipe-body">
                <b>{ITEMS[r.out].name}</b>
                <small>{r.inputs.map(([id, n]) => <span key={id} className={count(h, id) >= n ? 'ok' : 'short'}>{Math.min(count(h, id), n)}/{n} {ITEMS[id].name.toLowerCase()}</span>)}</small>
                <small className="rpg-dim">{STATION_NAMES[r.station]}{r.level > 1 ? ` · ${r.skill} ${r.level}` : ''}</small>
              </div>
              <Btn onClick={() => cmd({ t: 'craft', recipe: r.id })} disabled={!has || !skill || !at} kind="small primary" testid={`craft-${r.id}`} title={why || `Make ${ITEMS[r.out].name}`}>Make</Btn>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
