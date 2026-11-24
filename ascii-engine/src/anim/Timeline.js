import { gsap } from 'gsap';

// SYSTEM E: deterministic animation on a paused GSAP timeline that the engine seeks to (frame - 1) / fps.
// Keys are written as explicit fromTo segments, so rendering can start at any frame (resume after a crash)
// and scrubbing backwards in the preview gives the same result as playing forwards.

/**
 * Animate obj[prop] through keyframes: [[time, value, ease?], ...] (ease applies to the segment ending at that key).
 * Before the first key the value is the first value; after the last key it holds.
 */
export function keys(engine, obj, prop, frames) {
  const tl = engine.timeline;
  const sorted = [...frames].sort((a, b) => a[0] - b[0]);
  obj[prop] = sorted[0][1];
  tl.set(obj, { [prop]: sorted[0][1] }, 0);
  for (let i = 1; i < sorted.length; i++) {
    const [t0, v0] = sorted[i - 1], [t1, v1, ease = 'power1.inOut'] = sorted[i];
    if (t1 <= t0) continue;
    tl.fromTo(obj, { [prop]: v0 }, { [prop]: v1, duration: t1 - t0, ease, immediateRender: false }, t0);
  }
  return tl;
}

/** A short glitch burst on engine.params.glitch around time t (use at cuts and transitions). */
export function glitchBurst(engine, t, { duration = 0.4, peak = 1, attack = 0.12 } = {}) {
  const tl = engine.timeline, p = engine.params;
  tl.fromTo(p, { glitch: 0 }, { glitch: peak, duration: attack, ease: 'power2.in', immediateRender: false }, t - attack);
  tl.fromTo(p, { glitch: peak }, { glitch: 0, duration: duration - attack, ease: 'power3.out', immediateRender: false }, t);
}

/** Pulse a numeric property: rise to `peak` and fall back to `base`. */
export function pulse(engine, obj, prop, t, { base = 0, peak = 1, up = 0.15, down = 0.8 } = {}) {
  const tl = engine.timeline;
  tl.fromTo(obj, { [prop]: base }, { [prop]: peak, duration: up, ease: 'power2.out', immediateRender: false }, t);
  tl.fromTo(obj, { [prop]: peak }, { [prop]: base, duration: down, ease: 'power2.inOut', immediateRender: false }, t + up);
}

/** Make sure the timeline covers the whole scene duration (so seeking past the last tween still works). */
export function extendTimeline(engine, duration) {
  engine.timeline.set({}, {}, duration);
}

export const ease = (name) => gsap.parseEase(name);
