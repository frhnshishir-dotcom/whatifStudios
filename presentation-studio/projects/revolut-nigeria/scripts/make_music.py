"""Original 30-second music bed + transition SFX for the campaign film. Pure numpy synthesis: no samples,
no third-party music, so there is no copyright question. Writes assets/audio/music_bed.wav (48 kHz stereo)
and assets/audio/sfx.wav (whooshes and the impact on the storyboard cut points).

Structure follows the storyboard: chord changes on the cuts (0, 5, 11, 18, 24, 27 s), energy builds
through the three characters, a riser into the 24 s interface reveal, a resolved final chord at 27 s."""
from pathlib import Path

import numpy as np

SR = 48000
DUR = 30.0
OUT = Path(__file__).resolve().parents[1] / "assets" / "audio"
rng = np.random.default_rng(7)
t_all = np.arange(int(SR * DUR)) / SR


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def lowpass(x, cutoff):
    """Zero-phase FFT low-pass (smooth 12 dB-ish roll-off)."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / np.sqrt(1 + (f / cutoff) ** 4)
    return np.fft.irfft(X, len(x))


def highpass(x, cutoff):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 - 1 / np.sqrt(1 + (f / cutoff) ** 4)
    return np.fft.irfft(X, len(x))


def env(n, a, r, sustain=1.0):
    e = np.ones(n) * sustain
    na, nr = int(a * SR), int(r * SR)
    e[:na] = np.linspace(0, sustain, na)
    if nr:
        e[-nr:] *= np.linspace(1, 0, nr)
    return e


def saw(freq, n, detune=0.0):
    ph = np.cumsum(np.full(n, freq * (1 + detune)) / SR)
    return 2 * (ph % 1) - 1


# progression in D major: Bm  G  D  A  Em  D(add9)   (one chord per storyboard section)
sections = [(0.0, 5.0, [47, 54, 59, 62, 66]),     # Bm
            (5.0, 11.0, [43, 50, 55, 59, 62]),    # G
            (11.0, 18.0, [50, 57, 62, 66, 69]),   # D
            (18.0, 24.0, [45, 52, 57, 61, 64]),   # A
            (24.0, 27.0, [40, 47, 52, 55, 59]),   # Em
            (27.0, 30.0, [38, 50, 57, 62, 64, 66])]  # D add9 (resolve)

pad = np.zeros_like(t_all)
bass = np.zeros_like(t_all)
for s0, s1, notes in sections:
    i0, i1 = int(s0 * SR), int(min(s1 + 0.35, DUR) * SR)  # slight overlap = legato
    n = i1 - i0
    chord = sum(saw(midi(m), n, d) for m in notes[1:] for d in (-0.004, 0.0, 0.005))
    pad[i0:i1] += chord * env(n, 0.6, 0.5) * 0.06
    bass[i0:i1] += np.sin(2 * np.pi * midi(notes[0] - 12) * np.arange(n) / SR) * env(n, 0.05, 0.3) * 0.32
pad = lowpass(pad, 1500)

# pulse (eighth notes at 96 bpm) from 5 s; arpeggio from 11 s; percussion from 11 s
bpm = 96
eighth = 60 / bpm / 2
pulse = np.zeros_like(t_all)
arp = np.zeros_like(t_all)
kick = np.zeros_like(t_all)
hat = np.zeros_like(t_all)
for k in range(int(DUR / eighth)):
    t0 = k * eighth
    i0 = int(t0 * SR)
    sec = next(s for s in sections if s[0] <= t0 < s[1] + 1e-9) if t0 < 30 else sections[-1]
    if 5.0 <= t0 < 26.6:
        n = int(0.22 * SR)
        f = midi(sec[2][0])
        pulse[i0:i0 + n] += np.sin(2 * np.pi * f * np.arange(n) / SR) * np.exp(-np.arange(n) / (0.06 * SR)) * 0.35
    if 11.0 <= t0 < 26.6:
        n = int(0.35 * SR)
        note = sec[2][1 + (k % 4)] + 12
        tone = np.sin(2 * np.pi * midi(note) * np.arange(n) / SR) + 0.3 * np.sin(4 * np.pi * midi(note) * np.arange(n) / SR)
        arp[i0:i0 + n] += tone * np.exp(-np.arange(n) / (0.09 * SR)) * 0.10
    if 11.0 <= t0 < 26.6 and k % 4 == 0:  # soft kick on beats 1 and 3
        n = int(0.35 * SR)
        f = 110 * np.exp(-np.arange(n) / (0.04 * SR)) + 42
        kick[i0:i0 + n] += np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-np.arange(n) / (0.12 * SR)) * 0.55
    if 18.0 <= t0 < 26.6 and k % 2 == 1:
        n = int(0.05 * SR)
        hat[i0:i0 + n] += rng.normal(0, 1, n) * np.exp(-np.arange(n) / (0.012 * SR)) * 0.06
hat = highpass(hat, 7000)
arp = lowpass(arp, 5000)

# riser into the reveal (21.5 -> 24 s): filtered noise sweeping up
riser = np.zeros_like(t_all)
r0, r1 = int(21.5 * SR), int(24.0 * SR)
n = r1 - r0
noise = rng.normal(0, 1, n)
seg = np.zeros(n)
for j in range(10):  # piecewise sweep: progressively brighter bands
    a, b = j * n // 10, (j + 1) * n // 10
    seg[a:b] = highpass(lowpass(noise, 600 + j * 900), 300 + j * 300)[a:b]
riser[r0:r1] = seg * np.linspace(0, 1, n) ** 2 * 0.22

music = pad + bass + pulse + arp + kick + hat + riser
# master: gentle fade-in, fade-out of the last 1.2 s, soft clip, -1 dBFS peak
music *= np.clip(t_all / 0.8, 0, 1) * np.clip((DUR - t_all) / 1.2, 0, 1)
music = np.tanh(music * 1.4) / 1.4
music /= np.abs(music).max() / 0.89
stereo = np.stack([music, np.roll(music, int(0.012 * SR))], axis=1)  # 12 ms Haas widening

# SFX: whooshes on the cuts, impact at the 24 s reveal and a soft hit on the 27 s end frame
sfx = np.zeros_like(t_all)
for cut in (5.0, 11.0, 18.0):
    n = int(0.6 * SR)
    i0 = int((cut - 0.35) * SR)
    w = highpass(lowpass(rng.normal(0, 1, n), 2500), 400)
    sfx[i0:i0 + n] += w * np.sin(np.linspace(0, np.pi, n)) ** 2 * 0.35
for cut, amp in ((24.0, 0.8), (27.0, 0.5)):
    n = int(1.2 * SR)
    i0 = int(cut * SR)
    f = 70 * np.exp(-np.arange(n) / (0.15 * SR)) + 38
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-np.arange(n) / (0.35 * SR))
    sfx[i0:i0 + n] += boom * amp
sfx /= np.abs(sfx).max() / 0.8
sfx_st = np.stack([sfx, sfx], axis=1)


def write_wav(path, data):
    import wave
    pcm = (np.clip(data, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


OUT.mkdir(parents=True, exist_ok=True)
write_wav(OUT / "music_bed.wav", stereo)
write_wav(OUT / "sfx.wav", sfx_st)
print("music_bed.wav + sfx.wav", DUR, "s")
