import type { Engine } from '../engine/Engine';
import { SlotStore, type SlotMeta } from '../persist/storage';
import { validateSave, type Validation } from '../persist/format';
import { renderMinimap } from '../engine/render/minimap';
import { useUI } from './store';

/**
 * Saving and loading for the app: IndexedDB slots (with an autosave slot), Ctrl+S, JSON export as a download and
 * JSON import with validation. Keeps the UI store's slot list and save state current.
 */
export class WorldIO {
  store: SlotStore | null = null;
  currentSlot: string | null = null;
  private autosaveTimer = 0;
  private busy = false;

  constructor(private engine: Engine) {}

  async init(): Promise<void> {
    this.store = await SlotStore.open();
    useUI.setState({ storageKind: this.store.kind });
    await this.refresh();
    this.autosaveTimer = window.setInterval(() => { void this.autosave(); }, 90_000);
  }

  dispose(): void { clearInterval(this.autosaveTimer); }

  async refresh(): Promise<SlotMeta[]> {
    const slots = this.store ? await this.store.list() : [];
    useUI.setState({ slots, currentSlot: this.currentSlot });
    return slots;
  }

  /** Small top-down preview of the world for the slot list. */
  thumbnail(size = 96): string | undefined {
    try {
      const e = this.engine, w = e.world;
      const px = new Uint32Array(w.n);
      renderMinimap(w, e.shader, e.water ? e.water.view : null, e.objects, px);
      const full = document.createElement('canvas');
      full.width = w.w; full.height = w.h;
      full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w.w, w.h), 0, 0);
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const g = c.getContext('2d')!;
      g.imageSmoothingEnabled = true;
      g.drawImage(full, 0, 0, size, size);
      return c.toDataURL('image/png');
    } catch { return undefined; }
  }

  /** Save to a slot (null = a new slot). */
  async save(slotId: string | null, opts: { quiet?: boolean } = {}): Promise<SlotMeta | null> {
    if (!this.store || this.busy) return null;
    this.busy = true;
    const ui = useUI.getState();
    ui.setSaveState('saving');
    try {
      const data = this.engine.snapshot();
      const meta = await this.store.save(slotId, data, this.thumbnail());
      if (slotId !== 'autosave') this.currentSlot = meta.id;
      ui.setSaveState('saved');
      if (!opts.quiet) ui.showToast(`Saved “${meta.name}”`);
      await this.refresh();
      return meta;
    } catch (e) {
      ui.setSaveState('unsaved');
      ui.showToast(`Save failed: ${(e as Error).message}`);
      return null;
    } finally { this.busy = false; }
  }

  /** Ctrl+S: the current slot, or a new one. */
  quickSave(): Promise<SlotMeta | null> { return this.save(this.currentSlot); }

  private async autosave(): Promise<void> {
    if (useUI.getState().saveState !== 'unsaved' || this.engine.editor.active) return;
    const keep = this.currentSlot;
    await this.save('autosave', { quiet: true });
    this.currentSlot = keep;
    useUI.getState().setSaveState('unsaved'); // the named slot still lacks these changes
    useUI.getState().showToast('Autosaved');
  }

  async load(slotId: string): Promise<Validation> {
    const ui = useUI.getState();
    const data = this.store ? await this.store.load(slotId) : null;
    if (!data) { ui.showToast('That save could not be read'); return { ok: false, errors: ['Slot is empty or unreadable.'], warnings: [] }; }
    const v = this.apply(data);
    if (v.ok) {
      this.currentSlot = slotId === 'autosave' ? null : slotId;
      ui.setSaveState(slotId === 'autosave' ? 'unsaved' : 'saved');
      ui.showToast(`Loaded “${v.world!.name}”`);
      await this.refresh();
    }
    return v;
  }

  async remove(slotId: string): Promise<void> {
    if (!this.store) return;
    await this.store.remove(slotId);
    if (this.currentSlot === slotId) this.currentSlot = null;
    await this.refresh();
  }

  /** Validate and apply save data (object or JSON text). */
  apply(data: unknown): Validation {
    const e = this.engine;
    const v = validateSave(data, { w: e.world.w, h: e.world.h });
    if (!v.ok || !v.world) return v;
    const problems = e.applyWorld(v.world);
    v.warnings.push(...problems);
    useUI.getState().setWorldMeta(e.world.name, e.world.seed);
    return v;
  }

  exportJSON(): { name: string; size: number } {
    const data = this.engine.snapshot();
    const text = JSON.stringify(data);
    const name = `${data.name.replace(/[^\w-]+/g, '_')}-seed${data.seed}.lumenwild.json`;
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { name, size: text.length };
  }

  async importText(text: string): Promise<Validation> {
    const v = this.apply(text);
    const ui = useUI.getState();
    if (v.ok) {
      this.currentSlot = null;
      ui.setSaveState('unsaved');
      ui.showToast(`Imported “${v.world!.name}”${v.warnings.length ? ` (${v.warnings.length} warnings)` : ''}`);
    }
    return v;
  }

  newWorld(seed: number): void {
    this.engine.regenerate(seed);
    this.currentSlot = null;
    const ui = useUI.getState();
    ui.setWorldMeta(this.engine.world.name, seed);
    ui.setSaveState('unsaved');
    ui.setSelected(null);
    ui.showToast(`Generated ${this.engine.world.name}`);
    void this.refresh();
  }

  rename(name: string): void {
    const n = name.trim().slice(0, 60);
    if (!n) return;
    this.engine.world.name = n;
    useUI.getState().setWorldMeta(n, this.engine.world.seed);
    useUI.getState().markUnsaved();
  }
}

let io: WorldIO | null = null;
export const setWorldIO = (w: WorldIO | null) => { io = w; };
export const getWorldIO = () => io;
