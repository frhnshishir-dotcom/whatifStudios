import type { LivingWorld } from '../../world/life/client';
import type { Creature } from '../../world/life/wildlife';
import type { Hero, QuestState } from '../../world/rpg/hero';
import { count } from '../../world/rpg/hero';
import { CREATURE_COMBAT } from '../../world/rpg/content';

/**
 * What the HUD shows, worked out from the game's own state (no copies, no rules): quest progress, notices from the
 * rules' events and the world's journal, and the creature being fought. Kept apart from the components so it can be
 * tested without a browser.
 */

/** A quest's progress as the rules count it (gather and craft quests count what is in the pack). */
export function questProgress(h: Hero, q: QuestState): { have: number; need: number; ready: boolean } {
  const have = q.kind === 'gather' || q.kind === 'craft' ? Math.min(q.need, count(h, q.target)) : Math.min(q.need, q.have);
  return { have, need: q.need, ready: q.status === 'ready' || have >= q.need };
}

export interface Notice { id: number; text: string; kind: 'msg' | 'skill' | 'world'; at: number }

/** Reads new notices since the last call: the player's rules messages, skill gains, and new journal entries. */
export class NoticeReader {
  private seq = -1;
  private seenLog = new WeakSet<object>();
  private n = 0;

  /** New notices (oldest first). The first call only marks what is already there as seen. */
  read(lw: LivingWorld, now: number): Notice[] {
    const out: Notice[] = [], me = lw.me, first = this.seq < 0;
    for (const r of lw.recent) {
      if (r.seq <= this.seq) continue;
      if (!first) {
        const ev = r.ev;
        if (ev.e === 'msg' && ev.who === me) out.push({ id: ++this.n, text: ev.text, kind: 'msg', at: now });
        else if (ev.e === 'skill' && ev.who === me) out.push({ id: ++this.n, text: `${ev.skill[0].toUpperCase()}${ev.skill.slice(1)} is now ${ev.level}.`, kind: 'skill', at: now });
      }
    }
    this.seq = Math.max(this.seq, lw.recent.at(-1)?.seq ?? 0);
    // Our own quests and level-ups are already told (by their message and the level banner).
    const own = [`${lw.player.name} completed`, `${lw.player.name} reached level`];
    for (const l of lw.sim.log) {
      if (this.seenLog.has(l)) continue;
      this.seenLog.add(l);
      if (!first && !own.some((o) => l.text.startsWith(o))) out.push({ id: ++this.n, text: l.text, kind: 'world', at: now });
    }
    // The same words twice in one batch (a message and its journal line) are shown once.
    return out.filter((x, k) => out.findIndex((y) => y.text === x.text) === k);
  }
}

export interface Target { c: Creature; hp: number; max: number; hostile: boolean; slain: boolean }

/**
 * The creature the player is fighting: the last one the player hit or was hurt by (within 8 s), or one still
 * engaged with the player. A slain target stays for 2.5 s. Null when there is no fight.
 */
export class TargetPicker {
  private id: string | null = null;
  private lastAt = -1e9;
  private seq = 0;
  private slainAt = -1;

  pick(lw: LivingWorld, now: number): Target | null {
    const me = lw.me;
    for (const r of lw.recent) {
      if (r.seq <= this.seq) continue;
      const ev = r.ev;
      if (ev.e === 'hit' && ev.who === me) { this.take(ev.target, now); }
      else if (ev.e === 'hurt' && ev.who === me && lw.sim.wildlife.creatures.has(ev.by)) this.take(ev.by, now);
    }
    this.seq = lw.recent.at(-1)?.seq ?? this.seq;
    let c = this.id ? lw.sim.wildlife.creatures.get(this.id) ?? null : null;
    // Still fighting us (single player: the creature knows its foe), even without a blow this moment.
    if (c && c.alive && c.foe === lw.player.id && Math.hypot(c.x - lw.player.x, c.y - lw.player.y) < 50) this.lastAt = now;
    if (!c) {
      for (const k of lw.sim.wildlife.creatures.values()) if (k.alive && k.foe === lw.player.id && Math.hypot(k.x - lw.player.x, k.y - lw.player.y) < 30) { c = k; this.take(k.id, now); break; }
    }
    if (!c) return null;
    if (!c.alive) { if (this.slainAt < 0) this.slainAt = now; if (now - this.slainAt > 2.5) { this.id = null; return null; } }
    else if (now - this.lastAt > 8) { this.id = null; return null; }
    const max = CREATURE_COMBAT[c.sp].hp;
    return { c, hp: c.alive ? Math.max(0, c.hp) : 0, max, hostile: !!c.foe, slain: !c.alive };
  }

  private take(id: string, now: number): void {
    if (id !== this.id) this.slainAt = -1;
    this.id = id; this.lastAt = now;
  }
}

/** "Wolf", "Bear"... */
export const speciesName = (sp: string) => sp[0].toUpperCase() + sp.slice(1);
