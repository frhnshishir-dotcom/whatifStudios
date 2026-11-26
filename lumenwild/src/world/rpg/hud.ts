import type { Engine } from '../../engine/Engine';
import type { ContinentSession } from '../session';
import type { Hero } from './hero';
import { maxHp, xpToNext } from './hero';

/**
 * The on-screen HUD over the world canvas (plain DOM, not the renderer): health, stamina and experience bars,
 * floating numbers (damage, experience, level-ups), health bars over wounded creatures, names over other players,
 * and the veil when the traveller falls. Pointer events pass through to the canvas.
 */

interface Float { x: number; y: number; z: number; text: string; colour: string; t0: number; dur: number; big: boolean; el: HTMLDivElement | null }
export interface Tag { id: string; x: number; y: number; z: number; text?: string; frac?: number; colour?: string }

export class Hud {
  readonly root: HTMLDivElement;
  private bars: { hp: HTMLDivElement; hpT: HTMLSpanElement; st: HTMLDivElement; xp: HTMLDivElement; lv: HTMLSpanElement };
  private veil: HTMLDivElement;
  private toast: HTMLDivElement;
  private hint: HTMLDivElement;
  private prompt: HTMLDivElement;
  private promptText = '';
  private floats: Float[] = [];
  private tags = new Map<string, HTMLDivElement>();
  private hurtFlash: HTMLDivElement;
  private toastT = 0;

  constructor(private engine: Engine, private session: ContinentSession) {
    const canvas = engine.renderer!.canvas, parent = canvas.parentElement ?? document.body;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const root = document.createElement('div');
    root.dataset.testid = 'hud';
    root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;font:12px/1.2 ui-monospace,Menlo,Consolas,monospace;color:#fff;z-index:5';
    parent.appendChild(root);
    this.root = root;
    const panel = div(root, 'position:absolute;left:12px;bottom:12px;padding:6px 8px;background:rgba(10,14,12,.72);border:1px solid rgba(255,255,255,.12);border-radius:6px;min-width:190px');
    const row = (label: string, colour: string) => {
      const r = div(panel, 'display:flex;align-items:center;gap:6px;margin:2px 0');
      const l = document.createElement('span'); l.textContent = label; l.style.cssText = 'width:22px;opacity:.8'; r.appendChild(l);
      const track = div(r, 'flex:1;height:8px;background:#2a2f2c;border-radius:3px;overflow:hidden');
      const fill = div(track, `height:100%;width:0;background:${colour};transition:width .12s`);
      return { r, fill };
    };
    const hp = row('HP', '#e0504a'), st = row('ST', '#5cc8ff'), xp = row('XP', '#ffd166');
    const hpT = document.createElement('span'); hpT.style.cssText = 'width:58px;text-align:right;opacity:.85'; hpT.dataset.testid = 'hud-hp'; hp.r.appendChild(hpT);
    const lv = document.createElement('span'); lv.style.cssText = 'width:58px;text-align:right;opacity:.85'; lv.dataset.testid = 'hud-level'; xp.r.appendChild(lv);
    this.bars = { hp: hp.fill, hpT, st: st.fill, xp: xp.fill, lv };
    this.hint = div(root, 'position:absolute;right:12px;bottom:12px;padding:4px 8px;background:rgba(10,14,12,.6);border-radius:6px;opacity:.85');
    this.hint.textContent = 'Space attack · Q dodge · H eat · E interact';
    this.prompt = div(root, 'position:absolute;left:50%;bottom:16px;transform:translateX(-50%);padding:4px 10px;background:rgba(10,14,12,.8);border:1px solid rgba(255,209,102,.5);border-radius:6px;display:none');
    this.prompt.dataset.testid = 'hud-prompt';
    this.toast = div(root, 'position:absolute;left:50%;top:14px;transform:translateX(-50%);padding:5px 10px;background:rgba(10,14,12,.78);border-radius:6px;max-width:70%;text-align:center;opacity:0;transition:opacity .3s');
    this.toast.dataset.testid = 'hud-toast';
    this.veil = div(root, 'position:absolute;inset:0;background:rgba(60,0,0,.45);display:none;align-items:center;justify-content:center;font-size:22px;text-shadow:0 2px 6px #000');
    this.veil.dataset.testid = 'hud-veil';
    this.hurtFlash = div(root, 'position:absolute;inset:0;box-shadow:inset 0 0 60px rgba(255,30,30,.0);transition:box-shadow .25s');
  }

  dispose(): void { this.root.remove(); }

  /** Screen position (CSS px within the canvas) of a continent point standing at absolute height z. */
  project(x: number, y: number, z: number): [number, number] {
    const e = this.engine, s = this.session, cam = e.cam, S = s.win.S;
    const rect = e.renderer!.canvas.getBoundingClientRect(), k = rect.width / Math.max(1, cam.viewW);
    const col = x - s.win.origin[0] * S - cam.x, row = y - s.win.origin[1] * S - cam.y - (z - s.win.datum) * cam.heightScale;
    return [col * cam.cellW * k, row * cam.cellH * k];
  }

  float(x: number, y: number, z: number, text: string, colour = '#fff', big = false, dur = 1.1): void {
    if (this.floats.length > 40) this.floats.shift()?.el?.remove();
    this.floats.push({ x, y, z, text, colour, t0: performance.now() / 1000, dur, big, el: null });
  }

  /** The E prompt ("E Talk to ..."), or nothing. */
  setPrompt(text: string): void {
    if (text === this.promptText) return;
    this.promptText = text;
    this.prompt.style.display = text ? 'block' : 'none';
    this.prompt.innerHTML = text ? `<b style="color:#ffd166">E</b> ${text.replace(/</g, '&lt;')}` : '';
  }

  say(text: string): void { this.toast.textContent = text; this.toast.style.opacity = '1'; this.toastT = performance.now() / 1000; }
  hurt(): void { this.hurtFlash.style.boxShadow = 'inset 0 0 70px rgba(255,30,30,.55)'; setTimeout(() => { this.hurtFlash.style.boxShadow = 'inset 0 0 60px rgba(255,30,30,0)'; }, 160); }

  update(h: Hero, stamina: number, tags: Tag[], deadFor: number): void {
    const now = performance.now() / 1000, mh = maxHp(h);
    this.bars.hp.style.width = `${Math.max(0, Math.min(100, (h.hp / mh) * 100))}%`;
    this.bars.hpT.textContent = `${Math.max(0, Math.ceil(h.hp))}/${mh}`;
    this.bars.st.style.width = `${Math.round(stamina * 100)}%`;
    this.bars.xp.style.width = `${Math.min(100, (h.xp / xpToNext(h.level)) * 100)}%`;
    this.bars.lv.textContent = `Lv ${h.level}`;
    if (deadFor >= 0) { this.veil.style.display = 'flex'; this.veil.textContent = `You have fallen. Waking in ${h.homeName}…`; }
    else this.veil.style.display = 'none';
    if (now - this.toastT > 4) this.toast.style.opacity = '0';
    // Floating numbers rise and fade.
    for (let k = this.floats.length - 1; k >= 0; k--) {
      const f = this.floats[k], a = (now - f.t0) / f.dur;
      if (a >= 1) { f.el?.remove(); this.floats.splice(k, 1); continue; }
      if (!f.el) { f.el = div(this.root, `position:absolute;white-space:nowrap;font-weight:700;text-shadow:0 1px 2px #000,0 0 4px #000;font-size:${f.big ? 18 : 13}px;color:${f.colour}`); f.el.textContent = f.text; f.el.dataset.testid = 'hud-float'; }
      const [px, py] = this.project(f.x, f.y, f.z);
      f.el.style.transform = `translate(${px - 10}px, ${py - 28 - a * 26}px)`;
      f.el.style.opacity = String(1 - a * a);
    }
    // Tags: health bars and names.
    const seen = new Set<string>();
    for (const t of tags) {
      seen.add(t.id);
      let el = this.tags.get(t.id);
      if (!el) {
        el = div(this.root, 'position:absolute;display:flex;flex-direction:column;align-items:center;gap:1px');
        el.innerHTML = '<span style="font-size:11px;text-shadow:0 1px 2px #000"></span><div style="width:30px;height:4px;background:#2a2f2c;border-radius:2px;overflow:hidden"><div style="height:100%;background:#e0504a"></div></div>';
        this.tags.set(t.id, el);
      }
      const [px, py] = this.project(t.x, t.y, t.z);
      el.style.transform = `translate(${px - 15}px, ${py - 30}px)`;
      const name = el.firstElementChild as HTMLSpanElement, bar = el.lastElementChild as HTMLDivElement;
      name.textContent = t.text ?? ''; name.style.color = t.colour ?? '#fff';
      bar.style.display = t.frac === undefined ? 'none' : 'block';
      if (t.frac !== undefined) (bar.firstElementChild as HTMLDivElement).style.width = `${Math.max(0, t.frac * 100)}%`;
    }
    for (const [id, el] of this.tags) if (!seen.has(id)) { el.remove(); this.tags.delete(id); }
  }
}

function div(parent: HTMLElement, css: string): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = css;
  parent.appendChild(d);
  return d;
}
