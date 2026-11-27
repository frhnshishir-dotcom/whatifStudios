import type { Engine } from '../../engine/Engine';
import type { ContinentSession } from '../session';

/**
 * What the HUD draws anchored to the world (plain DOM over the canvas, not the renderer): floating numbers (damage,
 * experience, level-ups), health bars and names over creatures and other players, the red flash when hurt, and the
 * veil when the traveller falls. Pointer events pass through to the canvas.
 *
 * The character's bars, the interaction prompt, notices, the target frame and the quest tracker are the React HUD
 * (src/ui/rpg/RpgHud.tsx), which reads the same character.
 */

interface Float { x: number; y: number; z: number; text: string; colour: string; t0: number; dur: number; big: boolean; el: HTMLDivElement | null }
export interface Tag { id: string; x: number; y: number; z: number; text?: string; frac?: number; colour?: string }

const SERIF = '"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif';
const SANS = 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

export class Hud {
  readonly root: HTMLDivElement;
  private veil: HTMLDivElement;
  private veilText: HTMLDivElement;
  private floats: Float[] = [];
  private tags = new Map<string, HTMLDivElement>();
  private hurtFlash: HTMLDivElement;

  constructor(private engine: Engine, private session: ContinentSession) {
    const canvas = engine.renderer!.canvas, parent = canvas.parentElement ?? document.body;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const root = document.createElement('div');
    root.dataset.testid = 'hud';
    root.style.cssText = `position:absolute;inset:0;pointer-events:none;overflow:hidden;font:12px/1.2 ${SANS};color:#ebe4d1;z-index:5`;
    parent.appendChild(root);
    this.root = root;
    this.hurtFlash = div(root, 'position:absolute;inset:0;box-shadow:inset 0 0 60px rgba(185,71,60,0);transition:box-shadow .25s');
    this.veil = div(root, 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:radial-gradient(ellipse at center,rgba(40,8,6,.35) 0%,rgba(20,4,3,.78) 70%);');
    this.veil.dataset.testid = 'hud-veil';
    this.veilText = div(this.veil, `font:600 26px/1.3 ${SERIF};color:#ebe4d1;text-align:center;letter-spacing:.02em;text-shadow:0 2px 12px #000;padding:18px 28px;border-top:1px solid rgba(196,162,101,.45);border-bottom:1px solid rgba(196,162,101,.45)`);
  }

  dispose(): void { this.root.remove(); }

  /** Screen position (CSS px within the canvas) of a continent point standing at absolute height z. */
  project(x: number, y: number, z: number): [number, number] {
    const e = this.engine, s = this.session, cam = e.cam, S = s.win.S;
    const rect = e.renderer!.canvas.getBoundingClientRect(), k = rect.width / Math.max(1, cam.viewW);
    const col = x - s.win.origin[0] * S - cam.x, row = y - s.win.origin[1] * S - cam.y - (z - s.win.datum) * cam.heightScale;
    return [col * cam.cellW * k, row * cam.cellH * k];
  }

  float(x: number, y: number, z: number, text: string, colour = '#ebe4d1', big = false, dur = 1.1): void {
    if (this.floats.length > 40) this.floats.shift()?.el?.remove();
    this.floats.push({ x, y, z, text, colour, t0: performance.now() / 1000, dur, big, el: null });
  }

  hurt(): void { this.hurtFlash.style.boxShadow = 'inset 0 0 80px rgba(185,71,60,.6)'; setTimeout(() => { this.hurtFlash.style.boxShadow = 'inset 0 0 60px rgba(185,71,60,0)'; }, 160); }

  /** Per frame: tags (health bars and names), floating numbers, and the veil while fallen (`deadFor` >= 0 seconds). */
  update(tags: Tag[], deadFor: number, homeName: string): void {
    const now = performance.now() / 1000;
    if (deadFor >= 0) { this.veil.style.display = 'flex'; this.veilText.textContent = `You have fallen.\nWaking in ${homeName}…`; this.veilText.style.whiteSpace = 'pre-line'; }
    else this.veil.style.display = 'none';
    // Floating numbers rise and fade.
    for (let k = this.floats.length - 1; k >= 0; k--) {
      const f = this.floats[k], a = (now - f.t0) / f.dur;
      if (a >= 1) { f.el?.remove(); this.floats.splice(k, 1); continue; }
      if (!f.el) {
        f.el = div(this.root, `position:absolute;white-space:nowrap;font:${f.big ? `700 20px ${SERIF}` : `700 13px ${SANS}`};letter-spacing:${f.big ? '.02em' : '0'};text-shadow:0 1px 2px #000,0 0 6px rgba(0,0,0,.9);color:${f.colour}`);
        f.el.textContent = f.text; f.el.dataset.testid = 'hud-float';
      }
      const [px, py] = this.project(f.x, f.y, f.z), rise = f.big ? 34 : 26;
      f.el.style.transform = `translate(${px - 10}px, ${py - 28 - a * rise}px) scale(${f.big ? 1 + 0.15 * Math.sin(Math.min(1, a * 4) * Math.PI) : 1})`;
      f.el.style.opacity = String(1 - a * a);
    }
    // Tags: health bars and names.
    const seen = new Set<string>();
    for (const t of tags) {
      seen.add(t.id);
      let el = this.tags.get(t.id);
      if (!el) {
        el = div(this.root, 'position:absolute;display:flex;flex-direction:column;align-items:center;gap:2px');
        el.innerHTML = '<span style="font-size:11px;font-weight:600;text-shadow:0 1px 2px #000,0 0 4px #000"></span><div style="width:34px;height:5px;background:rgba(10,12,10,.85);border:1px solid rgba(196,162,101,.45);border-radius:3px;overflow:hidden"><div style="height:100%;background:linear-gradient(90deg,#b9473c,#e06a5b)"></div></div>';
        this.tags.set(t.id, el);
      }
      const [px, py] = this.project(t.x, t.y, t.z);
      el.style.transform = `translate(${px - 17}px, ${py - 32}px)`;
      const name = el.firstElementChild as HTMLSpanElement, bar = el.lastElementChild as HTMLDivElement;
      name.textContent = t.text ?? ''; name.style.color = t.colour ?? '#ebe4d1';
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
