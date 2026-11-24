"""Procedural cinematic backgrounds (numpy + Pillow, ~0.3 s each, no GPU, no API).
Kinds: spotlight, aurora, horizon, grid, mesh, vignette. All are seeded, so a rebuild is byte-stable.
The HTML deck animates the same palette live; the .pptx/PDF get these stills."""
from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from .tokens import hex_to_rgb, luminance

KINDS = ("spotlight", "aurora", "horizon", "grid", "mesh", "vignette", "nebula", "beams", "liquid")
W, H = 2400, 1350  # 16:9, sharp on 1440p projectors, small as JPEG


def _rgb(h):
    return np.array(hex_to_rgb(h), dtype=np.float32) / 255.0


def _blob(xx, yy, cx, cy, rx, ry):
    return np.exp(-(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2))


def _grain(img, amount, rng):
    return img + rng.normal(0, amount, img.shape[:2])[..., None].astype(np.float32)


def _fbm(rng, h, w, octaves=6, base=4):
    """Fractal value noise (numpy only): smooth cloud structure for nebulae."""
    out = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        n = base * 2 ** o
        g = rng.random((n + 1, int(n * w / h) + 2)).astype(np.float32)
        im = Image.fromarray((g * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
        out += amp * np.asarray(im, np.float32) / 255
        tot += amp
        amp *= 0.55
    return out / tot


def render(kind: str, colors: dict, seed: int = 1, w: int = W, h: int = H) -> Image.Image:
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    xx /= w
    yy /= h
    base = _rgb(colors["bg"])
    acc = _rgb(colors["accent"])
    acc2 = _rgb(colors.get("accent2", colors["accent"]))
    dark = luminance(colors["bg"]) < 0.2
    img = np.ones((h, w, 3), np.float32) * base

    if kind == "spotlight":
        g = _blob(xx, yy, 0.5, -0.15, 0.55, 0.85)
        img += (np.array([1, 1, 1]) * 0.10 if dark else -np.array([1, 1, 1]) * 0.0)[None, None] * g[..., None]
        img += acc * 0.10 * _blob(xx, yy, 0.5, 1.15, 0.6, 0.35)[..., None]
    elif kind == "aurora":
        for i, (c, k) in enumerate([(acc, 0.32), (acc2, 0.22), (acc, 0.16)]):
            cx, cy = rng.uniform(0.15, 0.85), rng.uniform(0.55, 1.05)
            g = _blob(xx, yy, cx, cy, rng.uniform(0.25, 0.45), rng.uniform(0.18, 0.3))
            img = img + (c - img) * (k * g)[..., None] if not dark else img + c * k * g[..., None] * 0.8
    elif kind == "horizon":
        band = np.exp(-((yy - 0.78) / 0.10) ** 2) * (0.35 + 0.65 * _blob(xx, yy, 0.5, 0.78, 0.6, 1.0))
        img = img + (acc - img) * (0.35 * band)[..., None] if not dark else img + acc * 0.30 * band[..., None]
        line = np.exp(-((yy - 0.78) / 0.0016) ** 2) * _blob(xx, yy, 0.5, 0.78, 0.45, 1.0)
        img += (np.ones(3) * (0.55 if dark else -0.15))[None, None] * line[..., None]
    elif kind == "grid":
        # perspective floor grid below a horizon at y=0.62
        hz = 0.62
        ss = 2  # supersampled vector lines, then blurred a touch: crisp but not aliased
        lay = Image.new("L", (w * ss, h * ss), 0)
        d = ImageDraw.Draw(lay)
        vx, vy = 0.5 * w * ss, hz * h * ss
        for i in range(-24, 25):  # rays from the vanishing point
            d.line([(vx, vy), (vx + i * 0.12 * w * ss, h * ss * 1.0 + 0)], fill=255, width=2 * ss)
        z = 1.0
        while True:  # rungs, spaced by perspective
            y = vy + (h * ss - vy) * (1.0 / z)
            if y <= vy + 2:
                break
            d.line([(0, y), (w * ss, y)], fill=255, width=2 * ss)
            z *= 1.35
            if z > 400:
                break
        lay = lay.resize((w, h), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.6))
        gl = np.asarray(lay, np.float32) / 255.0
        fade = np.clip((yy - hz) / 0.38, 0, 1) ** 1.1 * (yy > hz)
        img += (acc * 0.30)[None, None] * (gl * fade)[..., None]
        img += acc2 * 0.10 * _blob(xx, yy, 0.5, hz, 0.7, 0.10)[..., None]
        img += acc * 0.06 * _blob(xx, yy, 0.5, hz - 0.05, 0.35, 0.25)[..., None]
    elif kind == "mesh":
        for c, k in [(acc, 0.20), (acc2, 0.16), (acc, 0.10)]:
            g = _blob(xx, yy, rng.uniform(0.55, 1.0), rng.uniform(-0.1, 0.6), rng.uniform(0.25, 0.4), rng.uniform(0.25, 0.4))
            img = img + (c - img) * (k * g)[..., None]
    elif kind == "vignette":
        pass
    elif kind == "nebula":
        n = _fbm(rng, h, w, 7, 2)
        n2 = _fbm(rng, h, w, 5, 2)
        sweep = np.exp(-((yy - 0.25 - 0.55 * xx) / 0.28) ** 2)  # galaxy-like diagonal band
        cloud = (np.clip((n - 0.35) * 2.2, 0, 1) ** 1.3) * sweep
        cloud = np.asarray(Image.fromarray((np.clip(cloud, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6)), np.float32) / 255
        mix = np.clip(n2 * 1.4 - 0.2, 0, 1)[..., None]
        col = acc * (1 - mix) + acc2 * mix
        k = 0.55 if dark else 0.35
        img = img + (col - img) * (cloud[..., None] * k) if not dark else img + col * cloud[..., None] * k
        if dark:  # star field
            stars = rng.random((h, w)) > 0.9993
            img += (stars * rng.uniform(0.3, 1.0, (h, w)))[..., None].astype(np.float32)
    elif kind == "beams":
        ox, oy = 0.82, -0.25
        ang = np.arctan2(yy - oy, (xx - ox) * (w / h))
        rays = np.zeros_like(xx)
        for i in range(7):
            a0, wd = rng.uniform(1.75, 2.55), rng.uniform(0.012, 0.05)
            rays += np.exp(-((ang - a0) / wd) ** 2) * rng.uniform(0.4, 1.0)
        dist = np.sqrt(((xx - ox) * w / h) ** 2 + (yy - oy) ** 2)
        rays *= np.exp(-dist * 0.9)
        glow = _blob(xx, yy, ox, oy + 0.1, 0.35, 0.35)
        lit = acc * 0.6 + np.ones(3, np.float32) * 0.4
        add = (rays * 0.45 + glow * 0.18)[..., None]
        img = img + lit * add if dark else img + (acc - img) * np.clip(add, 0, 1) * 0.6
    elif kind == "liquid":
        x2, y2 = xx * 5.0, yy * 5.0 * h / w * 1.6
        for _ in range(4):  # domain warping: flowing, chrome-like bands
            x2, y2 = x2 + 0.55 * np.sin(y2 * 1.9 + rng.uniform(0, 6)), y2 + 0.55 * np.cos(x2 * 1.6 + rng.uniform(0, 6))
        bands = 0.5 + 0.5 * np.sin(x2 * 2.2 + y2 * 1.4)
        sheen = np.clip((bands - 0.82) * 5, 0, 1) ** 2
        mix = bands[..., None]
        col = acc * mix + acc2 * (1 - mix)
        k = 0.45 if dark else 0.28
        img = img * (1 - k) + col * k if dark else img + (col - img) * k
        img += (np.ones(3) * (0.35 if dark else 0.25))[None, None] * sheen[..., None]
    else:
        raise ValueError(f"unknown background kind {kind!r}; choose from {KINDS}")

    # cinematic vignette + film grain
    v = 1 - 0.28 * np.clip(((xx - 0.5) ** 2 + ((yy - 0.5) * 0.9) ** 2) * 2.2, 0, 1) if dark else 1.0
    img = img * (v[..., None] if dark else 1.0)
    img = _grain(img, 0.012 if dark else 0.006, rng)
    return Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8), "RGB")


def ensure(kind: str, colors: dict, out_dir: Path, seed: int = 1) -> Path:
    key = hashlib.sha1(f"{kind}|{seed}|{sorted(colors.items())}|{W}x{H}".encode()).hexdigest()[:10]
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / f"bg_{kind}_{key}.jpg"
    if not p.exists():
        render(kind, colors, seed).save(p, quality=90, optimize=True, progressive=True)
    return p


def mean_color(path: Path, box_in: tuple[float, float, float, float], slide_w=13.333, slide_h=7.5) -> str:
    """Average colour of an image (stretched over the slide) under a box — for contrast QA."""
    im = Image.open(path).convert("RGB")
    sx, sy = im.width / slide_w, im.height / slide_h
    x, y, w, h = box_in
    crop = im.crop((int(x * sx), int(y * sy), int((x + w) * sx), int((y + h) * sy))).resize((8, 8))
    a = np.asarray(crop, dtype=np.float32).reshape(-1, 3).mean(0)
    return "#%02X%02X%02X" % tuple(int(c) for c in a)
