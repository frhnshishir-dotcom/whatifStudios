"""Ad spots / promo videos: spot spec (JSON) -> self-contained HTML (GSAP timeline) -> MP4 via capture.cjs.

Spec (see animations/promo/README.md):
  {"name": "teaser", "design_system": "monolith", "format": "16:9" | "9:16" | "1:1" | "4:5",
   "fps": 30, "letterbox": false, "overrides": {...},
   "scenes": [
     {"type": "kinetic", "dur": 3, "bg": "nebula", "eyebrow": "...", "lines": ["Seven in ten", "are [[online]]"], "transition": "fade"},
     {"type": "reveal",  "dur": 4, "bg": "spotlight", "object": {"kind": "globe|device|sculpture|orbits", "dolly": 0.9},
      "eyebrow": "...", "title": "...", "subtitle": "...", "transition": "iris"},
     {"type": "stat",    "dur": 3, "bg": "beams", "value": "71.2%", "label": "...", "source": "World Bank, 2026", "transition": "whip"},
     {"type": "list",    "dur": 4, "title": "...", "items": ["...", "..."], "transition": "shutter"},
     {"type": "endcard", "dur": 3, "bg": "liquid", "title": "...", "subtitle": "...", "cta": "...", "object": {...}, "transition": "flash"}]}
Transitions: fade, iris, shutter, zoom, whip, flash, cut.  Backgrounds: any engine.backgrounds kind or "solid".
"""
from __future__ import annotations

import base64
import html
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

from . import backgrounds, fonts, tokens
from .layouts import runs_of, smart_quotes

STUDIO = Path(__file__).resolve().parent.parent
FORMATS = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350)}


def _b64(p: Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()


def _words(s: str) -> str:
    """Word-masked spans; accent runs stay glued to adjoining punctuation ("[[online]]." -> one word)."""
    words: list[list[tuple[str, bool]]] = [[]]
    for txt, acc in runs_of(smart_quotes(s)):
        for k, part in enumerate(txt.split(" ")):
            if k:
                words.append([])
            if part:
                words[-1].append((part, acc))
    seg = lambda p, a: f'<span class="acc">{html.escape(p)}</span>' if a else html.escape(p)
    return " ".join('<span class="w"><i>' + "".join(seg(p, a) for p, a in w) + "</i></span>" for w in words if w)


def _grain_png(path: Path) -> Path:
    if not path.exists():
        rng = np.random.default_rng(1)
        a = (rng.normal(128, 40, (256, 256))).clip(0, 255).astype(np.uint8)
        Image.fromarray(a, "L").save(path)
    return path


def build_html(spec: dict, out_dir: Path) -> Path:
    ds = tokens.load(spec.get("design_system", "monolith"), spec.get("overrides"))
    c = ds["colors"]
    W, H = FORMATS[spec.get("format", "16:9")]
    u = min(W, H) / 100
    out_dir.mkdir(parents=True, exist_ok=True)
    disp, body, mono = (ds["fonts"][r] for r in ("display", "body", "mono"))
    faces = {(disp["family"], disp.get("weight", "regular")), (body["family"], "regular"), (body["family"], "semibold"), (mono["family"], "regular")}
    ff = []
    for fam, wt in faces:
        f = fonts.resolve(fam, wt, "brand")
        fmt = "opentype" if f.file.suffix == ".otf" else "truetype"
        ff.append(f"@font-face{{font-family:'{fam}';font-weight:{f.css_weight};src:url({_b64(f.file, 'font/' + f.file.suffix[1:])}) format('{fmt}')}}")
    dw = fonts.WEIGHTS.get(disp.get("weight", "regular"), 400)
    css_vars = (f"--W:{W}px;--H:{H}px;--u:{u:.2f}px;--display:'{disp['family']}';--body:'{body['family']}';--mono:'{mono['family']}';--dw:{dw};"
                + "".join(f"--{k.replace('_', '-')}:{v};" for k, v in c.items() if isinstance(v, str)))
    scenes = []
    assets = out_dir / "_assets"
    for i, sc in enumerate(spec["scenes"]):
        kind = sc.get("bg", "solid")
        bg = ""
        if kind in backgrounds.KINDS:
            p = backgrounds.ensure(kind, c, assets, seed=sc.get("seed", 3 + i))
            bg = f'<div class="bg" style="background-image:url({_b64(p, "image/jpeg")})"></div>'
        elif kind not in ("solid", None):
            bp = Path(kind)
            bg = f'<div class="bg" style="background-image:url({_b64(bp, "image/" + bp.suffix[1:].replace("jpg", "jpeg"))})"></div>' if bp.exists() else ""
        t = sc["type"]
        eb = f'<div class="eyebrow">{html.escape(sc["eyebrow"])}</div>' if sc.get("eyebrow") else ""
        if t == "kinetic":
            foot = f'<div class="foot">{html.escape(sc["footnote"])}</div>' if sc.get("footnote") else ""
            body_html = f'<div class="center">{eb}<div class="kin">' + "<br>".join(_words(l) for l in sc["lines"]) + f"</div></div>{foot}"
        elif t in ("reveal", "endcard"):
            obj = '<div class="object"></div>' if sc.get("object") else ""
            sub = f'<div class="sub">{html.escape(smart_quotes(sc["subtitle"]))}</div>' if sc.get("subtitle") else ""
            cta = f'<div class="cta">{html.escape(sc["cta"])}</div>' if sc.get("cta") else ""
            title = f'<div class="title">{_words(sc["title"])}<div class="sweep"></div></div>' if sc.get("title") else ""
            foot = f'<div class="foot">{html.escape(sc["footnote"])}</div>' if sc.get("footnote") else ""
            brand = f'<div class="brand">{html.escape(sc["brand"])}</div>' if sc.get("brand") else ""
            if t == "reveal":
                body_html = f'{obj}<div class="copy">{eb}{title}{sub}{cta}</div>{foot}'
            else:
                body_html = f'{obj}<div class="center">{eb}{title}{sub}{cta}{brand}</div>{foot}'
        elif t == "stat":
            ring = ('<svg viewBox="0 0 100 100"><circle class="ring-bg" cx="50" cy="50" r="46" fill="none" stroke-width="1.2"/>'
                    '<circle class="ring-fg" cx="50" cy="50" r="46" fill="none" stroke-width="2.2" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></svg>')
            body_html = (f'<div class="center">{eb}<div class="statwrap">{ring}<div class="num">{html.escape(sc["value"])}</div></div>'
                         f'<div class="label">{html.escape(smart_quotes(sc.get("label", "")))}</div>'
                         + (f'<div class="source">{html.escape(sc["source"])}</div>' if sc.get("source") else "") + "</div>")
        elif t == "device":  # interface reveal: lines on the left, a device image rising on the right
            img = Path(sc["image"])
            mime = "image/png" if img.suffix.lower() == ".png" else "image/jpeg"
            lines = "".join(f'<div class="dline">{_words(l)}</div>' for l in sc.get("lines", []))
            body_html = (f'<div class="devwrap"><div class="devcopy">{eb}{lines}</div>'
                         f'<div class="devimg"><div class="glow"></div><img src="{_b64(img, mime)}" alt=""></div></div>')
        elif t == "list":
            items = "".join(f'<div class="item"><b>{k + 1:02d}</b><span>{html.escape(smart_quotes(x))}</span></div>' for k, x in enumerate(sc["items"]))
            body_html = f'<div class="list">{eb}<div class="title">{_words(sc.get("title", ""))}</div>{items}</div>'
        else:
            raise ValueError(f"scene {i}: unknown type {t!r} (kinetic, reveal, stat, list, endcard)")
        scenes.append(f'<section class="scene {t}" id="sc{i}" style="background:{c["bg"]}">{bg}{body_html}</section>')
    gsap = (STUDIO / "assets/vendor/gsap.min.js").read_text(encoding="utf-8")
    viewer = (STUDIO / "assets/vendor/studio-viewer.js").read_text(encoding="utf-8") if any(s.get("object") for s in spec["scenes"]) else ""
    assets.mkdir(parents=True, exist_ok=True)
    grain = _b64(_grain_png(assets / "grain.png"), "image/png")
    doc = f"""<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(spec.get('name', 'spot'))}</title>
<style>{''.join(ff)}
:root{{{css_vars}}}
{(STUDIO / 'animations/promo/promo.css').read_text(encoding='utf-8')}</style></head>
<body><div id="stage" class="{'letterbox' if spec.get('letterbox') else ''}">{''.join(scenes)}
<div id="vignette"></div><div id="grain" style="background-image:url({grain})"></div><div id="flash"></div></div>
<script>{gsap}</script><script>{viewer}</script>
<script>window.SPOT={json.dumps(spec)};</script>
<script>{(STUDIO / 'animations/promo/promo.js').read_text(encoding='utf-8')}</script></body></html>"""
    p = out_dir / f"{spec.get('name', 'spot')}.html"
    p.write_text(doc, encoding="utf-8")
    return p


def ffmpeg_bin() -> str | None:
    import os
    return os.environ.get("FFMPEG") or shutil.which("ffmpeg")


def render(spec: dict, out_dir: Path, preview_frames: bool = True) -> dict:
    """Build + capture + verify. Returns {'mp4', 'poster', 'frames', 'probe'}."""
    page = build_html(spec, out_dir / "_spot")
    W, H = FORMATS[spec.get("format", "16:9")]
    fps = int(spec.get("fps", 30))
    mp4 = out_dir / f"{spec.get('name', 'spot')}.mp4"
    ff = ffmpeg_bin()
    if not ff:
        raise SystemExit("ffmpeg not found (set FFMPEG=path\\to\\ffmpeg.exe or add it to PATH)")
    r = subprocess.run(["node", str(STUDIO / "animations/promo/capture.cjs"), str(page), str(mp4), "--fps", str(fps),
                        "--w", str(W), "--h", str(H), "--ffmpeg", ff], capture_output=True, text=True, timeout=3600)
    if r.returncode != 0:
        raise SystemExit("capture failed:\n" + r.stdout[-1500:] + r.stderr[-1500:])
    probe = json.loads(subprocess.run([ff.replace("ffmpeg", "ffprobe"), "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                                       "stream=width,height,codec_name,pix_fmt,r_frame_rate,nb_read_frames:format=duration", "-of", "json", str(mp4)],
                                      capture_output=True, text=True).stdout)
    out = {"mp4": mp4, "probe": probe, "page": page}
    poster = out_dir / f"{mp4.stem}_poster.jpg"
    dur = float(probe["format"]["duration"])
    subprocess.run([ff, "-y", "-v", "error", "-ss", f"{min(dur * 0.35, dur - 0.1):.2f}", "-i", str(mp4), "-frames:v", "1", "-q:v", "2", str(poster)])
    out["poster"] = poster
    lite = out_dir / f"{mp4.stem}_lite.mp4"  # small copy for sharing, messaging apps and slides
    subprocess.run([ff, "-y", "-v", "error", "-i", str(mp4), "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-maxrate", "1800k",
                    "-bufsize", "3600k", "-vf", "hqdn3d=1.5:1.5:4:4", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(lite)])
    out["lite"] = lite
    if preview_frames:  # contact strip of 6 frames for visual review
        strip = out_dir / f"{mp4.stem}_frames.jpg"
        n = 6
        subprocess.run([ff, "-y", "-v", "error", "-i", str(mp4), "-vf", f"fps={n / dur:.4f},scale=480:-2,tile={n}x1:padding=6:color=0x18181a",
                        "-frames:v", "1", str(strip)])
        out["frames"] = strip
    return out
