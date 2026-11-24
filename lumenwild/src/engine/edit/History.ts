/** An undoable edit. `redo` re-applies it after an undo; edits are applied before they are pushed. */
export interface Command {
  label: string;
  undo(): void;
  redo(): void;
}

/** Several commands as one step (a stroke that carves terrain and removes the trees standing in it). */
export class Composite implements Command {
  constructor(readonly label: string, readonly parts: Command[]) {}
  undo(): void { for (let k = this.parts.length - 1; k >= 0; k--) this.parts[k].undo(); }
  redo(): void { for (const c of this.parts) c.redo(); }
}

/** Bounded undo/redo stacks. Pushing a new command clears the redo stack. */
export class History {
  private done: Command[] = [];
  private undone: Command[] = [];
  onChange: (() => void) | null = null;

  constructor(readonly limit = 200) {}

  push(c: Command): void {
    this.done.push(c);
    if (this.done.length > this.limit) this.done.shift();
    this.undone.length = 0;
    this.onChange?.();
  }

  /** Replace the most recent command (coalescing a slider drag into one step). */
  replaceLast(c: Command): void {
    if (this.done.length) this.done[this.done.length - 1] = c; else this.done.push(c);
    this.undone.length = 0;
    this.onChange?.();
  }

  get last(): Command | null { return this.done.length ? this.done[this.done.length - 1] : null; }

  undo(): string | null {
    const c = this.done.pop();
    if (!c) return null;
    c.undo();
    this.undone.push(c);
    this.onChange?.();
    return c.label;
  }

  redo(): string | null {
    const c = this.undone.pop();
    if (!c) return null;
    c.redo();
    this.done.push(c);
    this.onChange?.();
    return c.label;
  }

  clear(): void {
    this.done.length = 0;
    this.undone.length = 0;
    this.onChange?.();
  }

  get canUndo(): boolean { return this.done.length > 0; }
  get canRedo(): boolean { return this.undone.length > 0; }
  get undoLabel(): string | null { return this.done.length ? this.done[this.done.length - 1].label : null; }
  get redoLabel(): string | null { return this.undone.length ? this.undone[this.undone.length - 1].label : null; }
  get size(): number { return this.done.length; }
}
