import { clamp, smoothstep } from '../core/math';

export interface EnvState {
  /** Hour of day, 0..24. */
  time: number;
  /** Advance the clock automatically. */
  cycle: boolean;
  /** Real seconds per in-game day at 1x speed. */
  dayLength: number;
  rain: number;
  fog: number;
  wind: number;
  /** +1 blows east, -1 west. */
  windDir: number;
}

export const DEFAULT_ENV: EnvState = { time: 10.5, cycle: true, dayLength: 480, rain: 0, fog: 0, wind: 0.35, windDir: 1 };

export const WEATHER_PRESETS: Record<string, Partial<EnvState>> = {
  clear: { rain: 0, fog: 0, wind: 0.2 },
  breezy: { rain: 0, fog: 0, wind: 0.7 },
  rain: { rain: 0.7, fog: 0.15, wind: 0.45 },
  storm: { rain: 1, fog: 0.25, wind: 0.95 },
  fog: { rain: 0, fog: 0.75, wind: 0.1 },
};

/**
 * Time of day and weather. Targets (set by the UI or a loaded save) are approached smoothly, so weather changes
 * fade in. Derived each update: daylight, night factor and the ambient light colour (white at noon, warm at dusk
 * and dawn, blue moonlight at night, dimmer and greyer in rain or fog), plus a gusting wind.
 */
export class Environment {
  readonly target: EnvState = { ...DEFAULT_ENV };
  /** Current (smoothed) values. */
  time = DEFAULT_ENV.time;
  rain = 0;
  fog = 0;
  wind = DEFAULT_ENV.wind;
  windDir = 1;
  /** Derived. */
  daylight = 1;
  night = 0;
  /** Wind including gusts, 0..1.3. */
  gust = 0.35;
  readonly ambient: [number, number, number] = [1, 1, 1];
  /** Sky haze for depth attenuation of far rows (0..255). */
  readonly haze: [number, number, number] = [170, 200, 198];
  /** Fog colour for the current light (0..255). */
  readonly fogColor: [number, number, number] = [200, 210, 204];

  constructor() { this.derive(0); }

  set(s: Partial<EnvState>): void {
    Object.assign(this.target, s);
    if (s.time !== undefined) this.time = ((s.time % 24) + 24) % 24;
    if (s.windDir !== undefined) this.windDir = s.windDir;
  }

  /** Snap the current values to the targets (loading a save, tests). */
  settle(): void {
    this.time = this.target.time; this.rain = this.target.rain; this.fog = this.target.fog; this.wind = this.target.wind; this.windDir = this.target.windDir;
    this.derive(0);
  }

  state(): EnvState { return { ...this.target, time: this.time }; }

  update(dt: number, t: number): void {
    const T = this.target;
    if (T.cycle) this.time = (this.time + (dt * 24) / Math.max(10, T.dayLength)) % 24;
    T.time = this.time;
    const k = 1 - Math.exp(-dt * 0.6);
    this.rain += (T.rain - this.rain) * k;
    this.fog += (T.fog - this.fog) * k;
    this.wind += (T.wind - this.wind) * k;
    this.windDir = T.windDir;
    this.derive(t);
  }

  private derive(t: number): void {
    // Sun height: -1 at midnight, +1 at noon (sunrise 6:00, sunset 18:00).
    const sun = Math.sin(((this.time - 6) / 12) * Math.PI);
    this.daylight = smoothstep(-0.18, 0.3, sun);
    this.night = 1 - this.daylight;
    const warm = this.daylight * (1 - smoothstep(0.05, 0.45, sun));
    const NIGHT = [0.24, 0.3, 0.5], DAY = [1, 1, 1], DUSK = [1.08, 0.82, 0.62];
    const overcast = 1 - 0.28 * this.rain - 0.12 * this.fog;
    for (let c = 0; c < 3; c++) {
      let v = NIGHT[c] + (DAY[c] - NIGHT[c]) * this.daylight;
      v += (DUSK[c] - v) * warm * 0.75;
      // Rain and fog grey the light a little.
      const grey = 0.92;
      v = (v + (grey - v) * 0.3 * Math.max(this.rain, this.fog)) * overcast;
      this.ambient[c] = clamp(v, 0, 1.2);
    }
    const hd = [168, 200, 198], hn = [22, 32, 48], hw = [224, 168, 130];
    for (let c = 0; c < 3; c++) {
      const v = hn[c] + (hd[c] - hn[c]) * this.daylight;
      this.haze[c] = v + (hw[c] - v) * warm * 0.7;
    }
    const fd = [214, 222, 216], fn = [38, 46, 62];
    for (let c = 0; c < 3; c++) this.fogColor[c] = fn[c] + (fd[c] - fn[c]) * this.daylight * (warm > 0.3 ? 0.9 : 1);
    this.gust = this.wind * (0.65 + 0.35 * Math.sin(t * 0.43) * Math.sin(t * 1.27 + 1.1)) + this.rain * 0.15;
  }

  /** "06:30" */
  clockLabel(): string {
    const h = Math.floor(this.time), m = Math.floor((this.time - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
