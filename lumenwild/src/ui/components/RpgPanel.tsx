import { useState, type ReactNode } from 'react';
import type { LivingWorld } from '../../world/life/client';
import type { RpgCmd } from '../../world/rpg/Rpg';
import { ITEMS, RARITY, SLOTS, itemName, itemStats, type Item } from '../../world/rpg/items';
import { RECIPES, SKILLS, STATION_NAMES } from '../../world/rpg/content';
import { ATTR_NAMES, maxHp, xpToNext, sLevel, skillXpFor, attackDamage, attackCooldown, armourOf, critChance, count, type Attr } from '../../world/rpg/hero';
import { useLife } from '../rpg/useLife';

/**
 * The traveller's RPG panel: Hero (level, attributes, skills, statistics), Pack (equipment and items), Quests,
 * Craft (recipes at the stations within reach), Shop (a villager's wares), Trade (another player, online).
 * Every button sends a command; in single player it is applied at once, online the server decides.
 */

const TABS: Array<[string, string]> = [['world', 'World'], ['hero', 'Hero'], ['pack', 'Pack'], ['quests', 'Quests'], ['craft', 'Craft'], ['shop', 'Shop'], ['trade', 'Trade']];
const Btn = ({ onClick, children, disabled, testid }: { onClick: () => void; children: ReactNode; disabled?: boolean; testid?: string }) => (
  <button className="btn" style={{ padding: '0 6px', fontSize: 11 }} onClick={onClick} disabled={disabled} data-testid={testid}>{children}</button>
);
const Name = ({ it }: { it: Item }) => <span style={{ color: RARITY[it.r].colour }}>{itemName(it)}{it.n > 1 ? ` ×${it.n}` : ''}</span>;

export function RpgPanel({ lw, world }: { lw: LivingWorld; world: ReactNode }) {
  useLife(); // re-render as soon as the character or the rules' view changes
  const [, bump] = useState(0);
  const refresh = () => bump((n) => n + 1);
  const cmd = (c: RpgCmd) => { lw.command(c); refresh(); };
  const tab = lw.ui.tab, setTab = (t: string) => { lw.ui.tab = t; refresh(); };
  const p = lw.player, h = p.hero, view = lw.view();
  const tabs = TABS.filter(([k]) => (k !== 'shop' || view.shop) && (k !== 'trade' || lw.net));
  return (
    <div data-testid="rpg-panel" style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 6 }}>
        {tabs.map(([k, label]) => (
          <button key={k} className="btn" data-testid={`tab-${k}`} onClick={() => setTab(k)} style={{ padding: '1px 6px', fontSize: 11, opacity: tab === k ? 1 : 0.65, borderColor: tab === k ? '#ffd166' : undefined }}>
            {label}{k === 'hero' && h.points ? ` (${h.points})` : ''}{k === 'quests' && (view.offer || h.quests.some((q) => q.status === 'ready')) ? ' •' : ''}
          </button>
        ))}
      </div>
      {tab === 'world' && world}
      {tab === 'hero' && <HeroTab lw={lw} cmd={cmd} />}
      {tab === 'pack' && <PackTab lw={lw} cmd={cmd} />}
      {tab === 'quests' && <QuestTab lw={lw} cmd={cmd} />}
      {tab === 'craft' && <CraftTab lw={lw} cmd={cmd} />}
      {tab === 'shop' && view.shop && <ShopTab lw={lw} cmd={cmd} />}
      {tab === 'trade' && lw.net && <TradeTab lw={lw} cmd={cmd} />}
      {tab !== 'world' && lw.message && <p className="small muted" data-testid="rpg-message" style={{ marginTop: 6 }}>{lw.message}</p>}
    </div>
  );
}

type TabProps = { lw: LivingWorld; cmd: (c: RpgCmd) => void };

function HeroTab({ lw, cmd }: TabProps) {
  const h = lw.player.hero, st = h.stats;
  const kills = Object.entries(st.kills).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
  return (
    <div data-testid="hero-tab" className="small">
      <dl className="kv">
        <dt>Level</dt><dd data-testid="hero-level">{h.level} · {h.xp}/{xpToNext(h.level)} xp</dd>
        <dt>Health</dt><dd>{Math.ceil(h.hp)}/{maxHp(h)}</dd>
        <dt>Attack</dt><dd>{attackDamage(h).toFixed(1)} dmg every {attackCooldown(h).toFixed(2)} s · {Math.round(critChance(h) * 100)}% critical</dd>
        <dt>Armour</dt><dd>{armourOf(h).toFixed(1)}</dd>
        <dt>Coins</dt><dd>{h.coins}</dd>
        <dt>Home</dt><dd>{h.homeName}</dd>
      </dl>
      <div style={{ marginTop: 6 }}>
        {(Object.keys(ATTR_NAMES) as Attr[]).map((a) => (
          <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 70 }}>{ATTR_NAMES[a]}</span><b style={{ width: 20 }}>{h.attrs[a]}</b>
            {h.points > 0 && <Btn onClick={() => cmd({ t: 'spend', attr: a })} testid={`spend-${a}`}>+</Btn>}
          </div>
        ))}
        {h.points > 0 && <p className="muted">{h.points} point{h.points > 1 ? 's' : ''} to spend.</p>}
      </div>
      <table style={{ width: '100%', marginTop: 6, borderSpacing: 0 }} data-testid="hero-skills">
        <tbody>{SKILLS.map((s) => { const lv = sLevel(h, s), a = skillXpFor(lv), b = skillXpFor(lv + 1); return (
          <tr key={s}><td style={{ textTransform: 'capitalize' }}>{s}</td><td style={{ width: 24, textAlign: 'right' }}>{lv}</td>
            <td style={{ width: 70 }}><span style={{ display: 'block', height: 4, background: '#333' }}><span style={{ display: 'block', height: 4, width: `${Math.min(100, ((h.skills[s] - a) / (b - a)) * 100)}%`, background: '#9fe07a' }} /></span></td></tr>
        ); })}</tbody>
      </table>
      <p className="muted" style={{ marginTop: 6 }}>Kills: {kills} · falls {st.deaths} · crafted {st.crafted} · gathered {st.gathered} · quests {st.quests} · found {h.found.length} places · dealt {st.dmgDealt}, took {st.dmgTaken}</p>
    </div>
  );
}

function PackTab({ lw, cmd }: TabProps) {
  const h = lw.player.hero, view = lw.view();
  return (
    <div data-testid="pack-tab" className="small">
      <p>Coins: <b data-testid="pack-coins">{h.coins}</b> · {h.inv.length}/24 slots</p>
      <ul style={{ margin: '4px 0', paddingLeft: 0, listStyle: 'none' }} data-testid="pack-equipped">
        {SLOTS.map((s) => { const it = h.equip[s]; return (
          <li key={s} style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span style={{ width: 52, opacity: 0.7, textTransform: 'capitalize' }}>{s}</span>
            {it ? <><Name it={it} /><span className="muted">{itemStats(it)}</span><Btn onClick={() => cmd({ t: 'unequip', slot: s })}>×</Btn></> : <span className="muted">—</span>}</li>
        ); })}
      </ul>
      <ul style={{ margin: '6px 0', paddingLeft: 0, listStyle: 'none' }} data-testid="pack-items">
        {h.inv.map((it) => { const d = ITEMS[it.id], price = view.shop ? lw.sellPrice(view.shop, it) : 0; return (
          <li key={it.uid} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', margin: '2px 0' }} title={d.desc}>
            <Name it={it} /><span className="muted">{itemStats(it)}</span>
            {d.slot && <Btn onClick={() => cmd({ t: 'equip', uid: it.uid })} testid={`equip-${it.id}`}>Equip</Btn>}
            {(d.heal || d.rest) && <Btn onClick={() => cmd({ t: 'use', uid: it.uid })} testid={`use-${it.id}`}>Use</Btn>}
            {view.shop && price > 0 && <Btn onClick={() => cmd({ t: 'sell', vid: view.shop!, uid: it.uid, n: it.n })} testid={`sell-${it.id}`}>Sell {price}</Btn>}
            {d.kind !== 'quest' && <Btn onClick={() => cmd({ t: 'drop', uid: it.uid })}>Drop</Btn>}
          </li>
        ); })}
        {!h.inv.length && <li className="muted">Empty.</li>}
      </ul>
    </div>
  );
}

function QuestTab({ lw, cmd }: TabProps) {
  const h = lw.player.hero, view = lw.view();
  return (
    <div data-testid="quest-tab" className="small">
      {view.offer && (
        <div style={{ border: '1px solid #ffd16655', padding: 6, borderRadius: 4, marginBottom: 6 }} data-testid="quest-offer">
          <b>{view.offer.title}</b> <span className="muted">from {view.offer.giverName}</span>
          <p style={{ margin: '4px 0' }}>{view.offer.text}</p>
          <p className="muted">Reward: {view.offer.reward.xp} xp, {view.offer.reward.coins} coins{view.offer.reward.item ? `, ${ITEMS[view.offer.reward.item].name}` : ''}</p>
          <Btn onClick={() => cmd({ t: 'accept' })} testid="quest-accept">Accept</Btn>
        </div>
      )}
      <ul style={{ margin: 0, paddingLeft: 14 }} data-testid="quest-list">
        {h.quests.map((q) => { const have = q.kind === 'gather' || q.kind === 'craft' ? Math.min(q.need, count(h, q.target)) : q.have; const ready = have >= q.need; return (
          <li key={q.id} style={{ marginBottom: 4 }}>
            <b style={{ color: ready ? '#ffd166' : undefined }}>{q.title}</b> {have}/{q.need}{ready ? ` · return to ${q.giverName}` : ''}
            <div className="muted">{q.text}</div>
            <Btn onClick={() => cmd({ t: 'abandon', qid: q.id })}>Abandon</Btn>
          </li>
        ); })}
        {!h.quests.length && !view.offer && <li className="muted" style={{ listStyle: 'none' }}>No quests. Villagers with a yellow “!” have work.</li>}
      </ul>
      <p className="muted" style={{ marginTop: 4 }}>Completed: {h.stats.quests}</p>
    </div>
  );
}

function CraftTab({ lw, cmd }: TabProps) {
  const h = lw.player.hero, here = lw.stationsHere();
  return (
    <div data-testid="craft-tab" className="small">
      <p className="muted">Here: {[...here].filter((s) => s !== 'none').map((s) => STATION_NAMES[s]).join(', ') || 'no station (field recipes only)'}</p>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
        {RECIPES.map((r) => {
          const has = r.inputs.every(([id, n]) => count(h, id) >= n), skill = sLevel(h, r.skill) >= r.level, at = here.has(r.station);
          return (
            <li key={r.id} style={{ margin: '2px 0', opacity: at ? 1 : 0.5 }}>
              <b>{ITEMS[r.out].name}</b> <span className="muted">{r.inputs.map(([id, n]) => `${count(h, id)}/${n} ${ITEMS[id].name.toLowerCase()}`).join(', ')} · {STATION_NAMES[r.station]}{r.level > 1 ? ` · ${r.skill} ${r.level}` : ''}</span>{' '}
              <Btn onClick={() => cmd({ t: 'craft', recipe: r.id })} disabled={!has || !skill || !at} testid={`craft-${r.id}`}>Make</Btn>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ShopTab({ lw, cmd }: TabProps) {
  const view = lw.view(), v = view.shop ? lw.sim.villages.people.get(view.shop) : null;
  if (!view.shop) return null;
  return (
    <div data-testid="shop-tab" className="small">
      <p><b>{v?.name ?? 'Shop'}</b> <span className="muted">({v?.tag})</span> · you have {lw.player.hero.coins} coins</p>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
        {view.stock.map((e, k) => (
          <li key={k} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', margin: '2px 0', opacity: e.left > 0 ? 1 : 0.4 }}>
            <Name it={{ ...e.item, n: 1 }} /><span className="muted">{itemStats(e.item)}</span>
            <Btn onClick={() => cmd({ t: 'buy', vid: view.shop!, idx: k })} disabled={e.left <= 0} testid={`buy-${e.item.id}`}>Buy {lw.buyPrice(e)}</Btn>
          </li>
        ))}
      </ul>
      <p className="muted" style={{ marginTop: 4 }}>Sell from the Pack tab while the shop is open.</p>
    </div>
  );
}

function TradeTab({ lw, cmd }: TabProps) {
  const [to, setTo] = useState(''), [sel, setSel] = useState<string[]>([]), [coins, setCoins] = useState(0), [price, setPrice] = useState(0);
  const p = lw.player, view = lw.view();
  const others = [...lw.sim.players.values()].filter((o) => o.id !== 'local' && Math.hypot(o.x - p.x, o.y - p.y) < 12);
  return (
    <div data-testid="trade-tab" className="small">
      {view.offers.filter((o) => o.to === lw.me).map((o) => (
        <div key={o.id} style={{ border: '1px solid #8fd3ff55', padding: 6, borderRadius: 4, marginBottom: 6 }}>
          {lw.sim.players.get(o.from)?.name ?? 'Someone'} offers {o.items.map((it) => itemName(it)).join(', ') || 'nothing'}{o.coins ? ` + ${o.coins} coins` : ''}{o.price ? ` for ${o.price} coins` : ' as a gift'}.{' '}
          <Btn onClick={() => cmd({ t: 'trade', id: o.id, accept: true })} testid="trade-accept">Accept</Btn> <Btn onClick={() => cmd({ t: 'trade', id: o.id, accept: false })}>Decline</Btn>
        </div>
      ))}
      {others.length ? (
        <>
          <select value={to} onChange={(e) => setTo(e.target.value)}><option value="">Trade with…</option>{others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          <ul style={{ margin: '4px 0', paddingLeft: 0, listStyle: 'none' }}>
            {p.hero.inv.filter((it) => ITEMS[it.id].kind !== 'quest').map((it) => (
              <li key={it.uid}><label><input type="checkbox" checked={sel.includes(it.uid)} onChange={(e) => setSel(e.target.checked ? [...sel, it.uid] : sel.filter((u) => u !== it.uid))} /> <Name it={it} /></label></li>
            ))}
          </ul>
          <label>Give coins <input type="number" min={0} value={coins} onChange={(e) => setCoins(+e.target.value)} style={{ width: 60 }} /></label>{' '}
          <label>Ask coins <input type="number" min={0} value={price} onChange={(e) => setPrice(+e.target.value)} style={{ width: 60 }} /></label>{' '}
          <Btn onClick={() => { if (to) { cmd({ t: 'offer', to, uids: sel, coins, price }); setSel([]); } }} disabled={!to}>Offer</Btn>
        </>
      ) : <p className="muted">Stand within 12 m of another player to trade.</p>}
    </div>
  );
}
