/**
 * Fixed-timestep simulation clock with an accumulator. Rendering runs at display rate; the simulation advances in
 * whole steps of `dt`, so physics is frame-rate independent and stable. Large stalls are capped (no spiral of death).
 */
export class Clock {
  readonly dt: number;
  paused = false;
  speed = 1;
  simTime = 0;
  steps = 0;
  private acc = 0;
  maxStepsPerFrame = 6;

  constructor(hz = 60) {
    this.dt = 1 / hz;
  }

  /** Feed real elapsed seconds; returns how many fixed steps to run now. */
  advance(realDt: number): number {
    if (this.paused) return 0;
    this.acc += Math.min(realDt, 0.25) * this.speed;
    let n = Math.floor(this.acc / this.dt);
    if (n > this.maxStepsPerFrame) { n = this.maxStepsPerFrame; this.acc = 0; } else this.acc -= n * this.dt;
    this.simTime += n * this.dt;
    this.steps += n;
    return n;
  }

  /** Fraction of a step left in the accumulator (for interpolating animation between steps). */
  get alpha(): number { return this.acc / this.dt; }
}
