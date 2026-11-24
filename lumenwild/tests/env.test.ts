import { describe, it, expect } from 'vitest';
import { Environment } from '../src/engine/env/Environment';
import { Atmosphere } from '../src/engine/env/Atmosphere';
import { World } from '../src/engine/world/World';
import { Camera } from '../src/engine/world/Camera';
import { TerrainShader } from '../src/engine/render/TerrainShader';
import { Composer } from '../src/engine/render/Composer';
import { Particles, PK } from '../src/engine/render/Particles';
import { ObjectStore } from '../src/engine/objects/ObjectStore';
import { ObjectLayer } from '../src/engine/objects/ObjectLayer';
import { Mat, Cover } from '../src/engine/world/materials';

describe('environment: time of day and weather', () => {
  it('is bright and neutral at noon, blue and dark at midnight, warm at dusk', () => {
    const e = new Environment();
    e.set({ time: 12, cycle: false }); e.settle();
    expect(e.ambient[0]).toBeCloseTo(1, 1); expect(e.ambient[2]).toBeCloseTo(1, 1);
    expect(e.night).toBeLessThan(0.01);
    e.set({ time: 0 }); e.settle();
    expect(e.night).toBeGreaterThan(0.99);
    expect(e.ambient[2]).toBeGreaterThan(e.ambient[0]);
    expect(e.ambient[0]).toBeLessThan(0.4);
    e.set({ time: 17.3 }); e.settle(); // golden hour, just before sunset
    expect(e.ambient[0]).toBeGreaterThan(e.ambient[2] * 1.1);
  });

  it('the clock advances with the cycle on and stops with it off; weather fades in', () => {
    const e = new Environment();
    e.set({ time: 6, cycle: true, dayLength: 240 });
    for (let k = 0; k < 600; k++) e.update(1 / 60, k / 60); // 10 s = 1 in-game hour
    expect(e.time).toBeCloseTo(7, 1);
    e.set({ cycle: false, rain: 1 });
    e.update(1 / 60, 10);
    expect(e.rain).toBeGreaterThan(0);
    expect(e.rain).toBeLessThan(0.05);
    for (let k = 0; k < 600; k++) e.update(1 / 60, 10 + k / 60);
    expect(e.rain).toBeGreaterThan(0.99);
    expect(e.time).toBeCloseTo(7, 1);
    expect(e.clockLabel()).toBe('07:00');
  });

  it('rain and fog dim the light', () => {
    const e = new Environment();
    e.set({ time: 12, cycle: false }); e.settle();
    const clear = e.ambient[1];
    e.set({ rain: 1, fog: 0.6 }); e.settle();
    expect(e.ambient[1]).toBeLessThan(clear * 0.8);
  });
});

/** 48 x 48 meadow of tall grass with a stream (x 20..23) and a cottage, composed through the real layers. */
function scene() {
  const world = new World(48, 48);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
    const i = y * 48 + x;
    world.elev[i] = x >= 20 && x <= 23 ? 2 : 3;
    world.mat[i] = Mat.Meadow; world.cover[i] = Cover.TallGrass;
  }
  world.markAllDirty();
  const depth = new Float32Array(world.n), velX = new Float32Array(world.n), velY = new Float32Array(world.n);
  for (let y = 0; y < 48; y++) for (let x = 20; x <= 23; x++) { depth[y * 48 + x] = 0.6; velY[y * 48 + x] = 1; }
  const sent: unknown[] = [];
  const water = { view: { depth, velX, velY }, send: (...c: unknown[]) => { sent.push(...c); } };
  const objects = new ObjectStore(world);
  objects.add({ kind: 'cottage', x: 6, y: 20, variant: 'terracotta', props: {} });
  const env = new Environment();
  const particles = new Particles(4000);
  const comp = new Composer(world, new TerrainShader(world));
  const objLayer = new ObjectLayer(world, objects, null);
  const atm = new Atmosphere(env, world, objects, particles);
  atm.water = water as never;
  comp.layers.push(objLayer, { after: (b, c, t) => particles.draw(b, c, t) }, atm);
  const cam = new Camera();
  cam.zoomIndex = 4;
  cam.setViewport(48 * cam.cellW, 40 * cam.cellH);
  cam.x = 0; cam.y = -4;
  const lum = (c: number) => 0.2126 * (c & 255) + 0.7152 * ((c >>> 8) & 255) + 0.0722 * ((c >>> 16) & 255);
  return { world, env, atm, particles, comp, cam, sent, objLayer, lum };
}

describe('atmosphere: light, wind, rain, leaves, fog', () => {
  it('night darkens the frame; the cottage lights the ground around it', () => {
    const { env, comp, cam, lum, objLayer } = scene();
    env.set({ time: 12, cycle: false, wind: 0 }); env.settle();
    let buf = comp.compose(cam, 1);
    let day = 0;
    for (let k = 0; k < buf.n; k++) day += lum(buf.bg[k]);
    env.set({ time: 0 }); env.settle(); objLayer.night = 1;
    buf = comp.compose(cam, 2);
    let night = 0;
    for (let k = 0; k < buf.n; k++) night += lum(buf.bg[k]);
    expect(night).toBeLessThan(day * 0.5);
    // Terrain cells next to the cottage (ground 6..10, 20..22) vs. far away (ground x 40) at night.
    const near: number[] = [], far: number[] = [];
    for (let k = 0; k < buf.n; k++) {
      if (buf.kind[k] !== 1) continue;
      const p = buf.pick[k], x = p % 48, y = (p / 48) | 0;
      if (y >= 22 && y <= 26 && x >= 5 && x <= 11) near.push(lum(buf.bg[k]));
      if (y >= 22 && y <= 26 && x >= 38) far.push(lum(buf.bg[k]));
    }
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(avg(near)).toBeGreaterThan(avg(far) * 1.4);
    // Lit windows are emissive: brighter than the dark wall around them.
    let emissive = 0;
    for (let k = 0; k < buf.n; k++) if (buf.kind[k] === 5 && buf.light[k] > 0) emissive++;
    expect(emissive).toBeGreaterThan(0);
  });

  it('wind bends bands of tall grass; no wind, no sway', () => {
    const { env, atm, comp, cam } = scene();
    env.set({ time: 12, cycle: false, wind: 0 }); env.settle();
    comp.compose(cam, 1);
    expect(atm.stats.swayed).toBe(0);
    env.set({ wind: 1 }); env.settle();
    let total = 0;
    for (let k = 0; k < 10; k++) { comp.compose(cam, 1 + k * 0.3); total += atm.stats.swayed; }
    expect(total).toBeGreaterThan(50);
  });

  it('rain falls, makes ripples on water and splashes on the ground', () => {
    const { env, comp, cam, sent, particles } = scene();
    env.set({ time: 12, cycle: false, rain: 1, wind: 0 }); env.settle();
    let rainSeen = 0;
    for (let k = 0; k < 120; k++) {
      comp.compose(cam, k / 60);
      for (let j = 0; j < particles.n; j++) if (particles.kind[j] === PK.Rain) rainSeen++;
    }
    expect(rainSeen).toBeGreaterThan(100);
    expect(sent.length).toBeGreaterThan(5);
    expect(sent.every((c) => (c as { op: string }).op === 'disturb')).toBe(true);
  });

  it('a leaf that lands on the stream floats downstream with the current', () => {
    const { particles, atm, env } = scene();
    env.set({ time: 12, cycle: false, wind: 0 }); env.settle();
    particles.spawn(PK.Leaf, 21.5, 10.5, 3.5, 0, 0, 0, 10, 0.3);
    const ground = (x: number, _y: number) => ((x | 0) >= 20 && (x | 0) <= 23 ? 2.6 : 3);
    void atm;
    let t = 0;
    for (let k = 0; k < 600 && particles.kind[0] === PK.Leaf; k++) { particles.update(1 / 60, t, ground); t += 1 / 60; }
    expect(particles.kind[0]).toBe(PK.FloatLeaf);
    const y0 = particles.y[0];
    for (let k = 0; k < 120; k++) { particles.update(1 / 60, t, ground); t += 1 / 60; }
    expect(particles.y[0]).toBeGreaterThan(y0 + 1.2); // velY = 1 m/s downstream
  });

  it('fog veils the view towards the fog colour', () => {
    const { env, atm, comp, cam } = scene();
    env.set({ time: 12, cycle: false, wind: 0, fog: 0 }); env.settle();
    comp.compose(cam, 1);
    expect(atm.stats.fogged).toBe(0);
    env.set({ fog: 0.9 }); env.settle();
    comp.compose(cam, 2);
    expect(atm.stats.fogged).toBeGreaterThan(cam.cols * cam.rows * 0.5);
  });
});
