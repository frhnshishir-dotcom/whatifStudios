import type { DragonEntity } from './DragonEntity';
import type { DragonSenses } from './DragonEnvironmentAwareness';
import type { Particles } from '../render/Particles';
import { PK } from '../render/Particles';
import { NECK_BASE } from './DragonAnimation';
import { DRAGON } from './DragonConfig';

export interface WaterSink { disturb(x: number, y: number, r: number, strength: number): void }
/** Optional sound hook: name, world position and a 0..1 volume. Lumenwild ships no audio; nothing plays by default. */
export type SoundHook = (name: string, x: number, y: number, volume: number) => void;

/**
 * The dragon's effects on the world, through existing systems: ripple impulses in the water simulation (drinking,
 * skimming low over water, landing beside it), splash particles, discovery of water sources while flying, and
 * sound events for an optional audio layer.
 */
export class DragonInteractions {
  water: WaterSink | null = null;
  particles: Particles | null = null;
  sound: SoundHook | null = null;
  /** Counters (for tests and the info panel). */
  readonly counts = { ripples: 0, splashes: 0, sounds: 0, waterFound: 0 };
  private drinkT = 0;
  private skimT = 0;
  private wingT = 0;
  private callT = 30;

  emit(name: string, x: number, y: number, volume: number): void {
    this.counts.sounds++;
    this.sound?.(name, x, y, volume);
  }

  ripple(x: number, y: number, r: number, strength: number): void {
    this.water?.disturb(Math.floor(x), Math.floor(y), r, strength);
    this.counts.ripples++;
  }

  splash(x: number, y: number, z: number, n: number, rand: () => number): void {
    const P = this.particles;
    if (!P) return;
    for (let k = 0; k < n; k++) {
      const a = rand() * Math.PI * 2, sp = 0.8 + rand() * 1.6;
      P.spawn(PK.Splash, x + Math.cos(a) * 0.5, y + Math.sin(a) * 0.3, z + 0.1, Math.cos(a) * sp, Math.sin(a) * sp * 0.5, 2.5 + rand() * 2.5, 0.5 + rand() * 0.5, rand());
    }
    this.counts.splashes += n;
  }

  /** Head position in the world (for drinking). */
  head(e: DragonEntity): [number, number] {
    const a = e.heading + e.headYaw * 0.5, reach = NECK_BASE + DRAGON.neckSegments * DRAGON.neckSeg + 1;
    return [e.x + Math.cos(a) * reach, e.y + Math.sin(a) * reach];
  }

  update(e: DragonEntity, dt: number, senses: DragonSenses, rand: () => number): void {
    const now = e.time;
    // Discover water while flying over it.
    if (e.airborne && senses.depth(e.x, e.y) > 0.5 && e.memory.noteWater(Math.round(e.x), Math.round(e.y), now)) this.counts.waterFound++;
    // Wing beats (sound only) on each downstroke.
    if (e.airborne && e.wingAmp > 0.3) {
      this.wingT += dt;
      if (this.wingT > 1 / Math.max(0.5, DRAGON.flapHz)) { this.wingT = 0; this.emit('wingbeat', e.x, e.y, 0.3 + e.wingAmp * 0.4); }
    }
    // A distant call now and then.
    this.callT -= dt;
    if (this.callT <= 0) { this.callT = 40 + rand() * 60; if (e.state !== 'SLEEPING') this.emit('call', e.x, e.y, 0.6); }
    if (e.state === 'SLEEPING') { this.wingT += dt; if (this.wingT > 3.2) { this.wingT = 0; this.emit('breathing', e.x, e.y, 0.15); } }
    if (!e.effects) return;
    // Drinking: the muzzle dips into the water: ripples and a few droplets.
    if (e.state === 'DRINKING') {
      this.drinkT -= dt;
      if (this.drinkT <= 0) {
        this.drinkT = 0.9 + rand() * 0.6;
        const [hx, hy] = this.head(e);
        if (senses.depth(hx, hy) > 0.03) {
          this.ripple(hx, hy, 1.2, 0.5 + rand() * 0.3);
          this.splash(hx, hy, senses.ground(hx, hy), 3, rand);
          this.emit('lap', hx, hy, 0.2);
        }
      }
    }
    // Skimming low over water: a wake of ripples and spray from the wing beats.
    if (e.airborne && e.z - senses.ground(e.x, e.y) < 3.2 && senses.depth(e.x, e.y) > 0.1) {
      this.skimT -= dt;
      if (this.skimT <= 0) {
        this.skimT = 0.22;
        this.ripple(e.x, e.y, 1.6, 0.35 + Math.min(0.5, e.speed * 0.04));
        if (rand() < 0.5) this.splash(e.x, e.y, senses.ground(e.x, e.y), 2, rand);
      }
    }
  }

  /** One-off events from the AI (take-off, landing flare, touch-down). */
  event(e: DragonEntity, name: string, senses: DragonSenses, rand: () => number): void {
    this.emit(name, e.x, e.y, name === 'land' ? 0.5 : 0.4);
    if (!e.effects) return;
    if (name === 'land' || name === 'takeoff') {
      // Downdraft: water nearby ripples, dust/spray flies.
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2, x = e.x + Math.cos(a) * 3, y = e.y + Math.sin(a) * 3;
        if (senses.depth(x, y) > 0.05) this.ripple(x, y, 1.4, 0.4);
      }
      if (senses.depth(e.x, e.y) > 0.03 || senses.nearestDeepWater(e.x, e.y, 3)) this.splash(e.x, e.y, senses.ground(e.x, e.y), 8, rand);
    }
  }
}
