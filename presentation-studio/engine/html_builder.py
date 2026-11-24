"""Element lists -> cinematic, self-contained HTML deck (works from file://, no network, no build step).
Stage is a fixed 1920x1080 canvas (1 in = 144 px, 1 pt = 2 px) scaled to the window, so the web deck
matches the .pptx geometry exactly. Motion lives in components/runtime/deck.js + deck.css."""
from __future__ import annotations

import base64
import hashlib
import html
import json
import math
import shutil
from pathlib import Path

from . import fonts
from .tokens import hex_to_rgb

PX = 144  # px per inch
STUDIO = Path(__file__).resolve().parent.parent
RUNTIME = STUDIO / "components" / "runtime"
VENDOR = STUDIO / "assets" / "vendor"


def px(v: float) -> str:
    return f"{v * PX:.1f}px"


def rgba(h: str, a: float = 1.0) -> str:
    r, g, b = hex_to_rgb(h)
    return f"rgba({r},{g},{b},{a:.3f})"


def esc(s: str) -> str:
    return html.escape(s, quote=True)


class Assets:
    def __init__(self, out: Path):
        self.out = out
        self.map: dict[str, str] = {}

    def add(self, src: str) -> str:
        if src in self.map:
            return self.map[src]
        p = Path(src)
        h = hashlib.sha1(p.read_bytes()).hexdigest()[:10]
        rel = f"assets/{p.stem[:40]}_{h}{p.suffix.lower()}"
        dst = self.out / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.exists():
            shutil.copy2(p, dst)
        self.map[src] = rel
        return rel


# ------------------------------------------------------------------ charts (SVG)
def _fmt(v: float, spec: dict) -> str:
    d = spec.get("decimals", 0)
    return f"{v:,.{d}f}{spec.get('unit', '')}"


def _nice_max(v: float) -> float:
    if v <= 0:
        return 1
    e = 10 ** math.floor(math.log10(v))
    for m in (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10):
        if m * e >= v:
            return m * e
    return 10 * e


def chart_svg(el: dict) -> str:
    spec = el["chart"]
    W, H = el["box"][2] * PX, el["box"][3] * PX
    cols = spec["colors"]
    font = esc(el["css_font"])
    txt, muted, ln = el["text"], el["muted"], el["line"]
    cats, series = spec["categories"], spec["series"]
    out = [f'<svg class="chart" viewBox="0 0 {W:.0f} {H:.0f}" width="{W:.0f}" height="{H:.0f}" font-family="{font}" role="img" aria-label="{esc(spec.get("alt", "chart"))}">']
    t = spec["type"]
    if t == "donut":
        cx, cy, r, rw = H / 2, H / 2, H / 2 - 20, H * 0.14
        total = sum(series[0]["values"]) or 1
        a0 = -math.pi / 2
        for i, v in enumerate(series[0]["values"]):
            a1 = a0 + 2 * math.pi * v / total
            large = 1 if a1 - a0 > math.pi else 0
            x0, y0, x1, y1 = cx + r * math.cos(a0), cy + r * math.sin(a0), cx + r * math.cos(a1), cy + r * math.sin(a1)
            out.append(f'<path class="arc" style="--i:{i}" d="M{x0:.1f},{y0:.1f} A{r:.1f},{r:.1f} 0 {large} 1 {x1:.1f},{y1:.1f}" fill="none" stroke="{cols[i % len(cols)]}" stroke-width="{rw:.0f}" pathLength="1"/>')
            a0 = a1
        for i, (c, v) in enumerate(zip(cats, series[0]["values"])):
            y = 60 + i * 64
            out.append(f'<rect x="{H + 40:.0f}" y="{y - 18}" width="22" height="22" rx="4" fill="{cols[i % len(cols)]}"/>'
                       f'<text x="{H + 76:.0f}" y="{y}" font-size="26" fill="{txt}">{esc(c)} <tspan fill="{muted}">{_fmt(v, spec)}</tspan></text>')
        out.append("</svg>")
        return "".join(out)

    pad_l, pad_b, pad_t = 86, 56, 34
    pad_r = 250 if t == "line" else 20
    if t == "bar":
        pad_l = max(120, 15 * max(len(c) for c in cats))
    pw, ph = W - pad_l - pad_r, H - pad_t - pad_b
    vmax = spec.get("max") or _nice_max(max(max(s["values"]) for s in series) * 1.08)
    vmin = spec.get("min", 0)
    ticks = 4
    for k in range(ticks + 1):
        v = vmin + (vmax - vmin) * k / ticks
        if t == "bar":
            x = pad_l + pw * k / ticks
            out.append(f'<line x1="{x:.1f}" y1="{pad_t}" x2="{x:.1f}" y2="{pad_t + ph:.1f}" stroke="{ln}" stroke-width="1"/>'
                       f'<text x="{x:.1f}" y="{pad_t + ph + 34:.1f}" font-size="21" fill="{muted}" text-anchor="middle">{_fmt(v, spec)}</text>')
        else:
            y = pad_t + ph - ph * k / ticks
            out.append(f'<line x1="{pad_l}" y1="{y:.1f}" x2="{pad_l + pw:.1f}" y2="{y:.1f}" stroke="{ln}" stroke-width="1"/>'
                       f'<text x="{pad_l - 14}" y="{y + 7:.1f}" font-size="21" fill="{muted}" text-anchor="end">{_fmt(v, spec)}</text>')
    n, m = len(cats), len(series)
    hl = spec.get("highlight")
    hl = [hl] if isinstance(hl, int) else (hl or [])
    sc = lambda v: (v - vmin) / (vmax - vmin)
    if t == "column":
        gw = pw / n
        bw = gw * (1 - spec.get("gap", 60) / 160) / m
        for ci, c in enumerate(cats):
            gx = pad_l + ci * gw + (gw - bw * m) / 2
            out.append(f'<text x="{pad_l + ci * gw + gw / 2:.1f}" y="{pad_t + ph + 38:.1f}" font-size="24" fill="{txt}" text-anchor="middle">{esc(c)}</text>')
            for si, s in enumerate(series):
                v = s["values"][ci]
                bh = ph * sc(v)
                col = cols[si % len(cols)] if m > 1 else (cols[0] if ci in hl else cols[2])
                x, y = gx + si * bw, pad_t + ph - bh
                out.append(f'<g class="bar" style="--i:{ci * m + si}"><rect x="{x:.1f}" y="{y:.1f}" width="{bw - 4:.1f}" height="{bh:.1f}" rx="3" fill="{col}"/>'
                           f'<text x="{x + (bw - 4) / 2:.1f}" y="{y - 12:.1f}" font-size="24" font-weight="600" fill="{txt}" text-anchor="middle">{_fmt(v, spec)}</text></g>')
    elif t == "bar":
        gh = ph / n
        bh = gh * (1 - spec.get("gap", 60) / 160) / m
        for ci, c in enumerate(cats):
            gy = pad_t + ci * gh + (gh - bh * m) / 2
            out.append(f'<text x="{pad_l - 16}" y="{pad_t + ci * gh + gh / 2 + 8:.1f}" font-size="24" fill="{txt}" text-anchor="end">{esc(c)}</text>')
            for si, s in enumerate(series):
                v = s["values"][ci]
                bw = pw * sc(v)
                col = cols[si % len(cols)] if m > 1 else (cols[0] if ci in hl else cols[2])
                y = gy + si * bh
                out.append(f'<g class="bar h" style="--i:{ci * m + si}"><rect x="{pad_l}" y="{y:.1f}" width="{bw:.1f}" height="{bh - 4:.1f}" rx="3" fill="{col}"/>'
                           f'<text x="{pad_l + bw + 12:.1f}" y="{y + (bh - 4) / 2 + 8:.1f}" font-size="24" font-weight="600" fill="{txt}">{_fmt(v, spec)}</text></g>')
    elif t == "line":
        step = max(1, math.ceil(n / 8))
        xs = [pad_l + pw * i / max(1, n - 1) for i in range(n)]
        for i, c in enumerate(cats):
            if (i % step == 0 and n - 1 - i >= step * 0.6) or i == n - 1:
                out.append(f'<text x="{xs[i]:.1f}" y="{pad_t + ph + 38:.1f}" font-size="22" fill="{muted}" text-anchor="middle">{esc(str(c))}</text>')
        hs = spec.get("highlight", 0)
        ends = []
        for si, s in enumerate(series):
            col = cols[si % len(cols)]
            pts = " ".join(f"{xs[i]:.1f},{pad_t + ph - ph * sc(v):.1f}" for i, v in enumerate(s["values"]) if v is not None)
            wdt = 6 if si == hs else 3.5
            out.append(f'<polyline class="ln" style="--i:{si}" points="{pts}" fill="none" stroke="{col}" stroke-width="{wdt}" stroke-linejoin="round" stroke-linecap="round" pathLength="1"/>')
            lv = s["values"][-1]
            ends.append([pad_t + ph - ph * sc(lv), s["name"], lv, col])
        ends.sort()
        for k in range(1, len(ends)):  # de-collide end labels
            if ends[k][0] - ends[k - 1][0] < 30:
                ends[k][0] = ends[k - 1][0] + 30
        for y, name, lv, col in ends:
            out.append(f'<text class="endlab" x="{pad_l + pw + 14:.1f}" y="{y + 8:.1f}" font-size="22" fill="{col}" font-weight="600">{_fmt(lv, {**spec, 'decimals': spec.get('label_decimals', spec.get('decimals', 0))})} <tspan fill="{muted}" font-weight="400">{esc(name)}</tspan></text>')
    out.append("</svg>")
    return "".join(out)


# ------------------------------------------------------------------ elements
def _text_html(el: dict) -> str:
    f = el["font"]
    face = fonts.resolve(f["family"], "italic" if el["italic"] and f["family"] == "Instrument Serif" else f["weight"], "brand")
    weight = 400 if face.weight == "italic" else face.css_weight
    x, y, w, h = el["box"]
    js = {"top": "flex-start", "middle": "center", "bottom": "flex-end"}[el["anchor"]]
    st = (f"left:{px(x)};top:{px(y)};width:{px(w)};height:{px(h)};justify-content:{js};"
          f"font-family:'{f['family']}';font-weight:{weight};font-style:{'italic' if el['italic'] else 'normal'};"
          f"font-size:{el['size'] * 2:.1f}px;line-height:{el['lh']};letter-spacing:{el['tracking']}em;"
          f"color:{el['color']};text-align:{el['align']};--acc:{el['accent']};"
          + ("text-transform:uppercase;" if el["upper"] else "")
          + ("text-decoration:line-through;text-decoration-thickness:1.5px;" if el.get("strike") else ""))

    def runs(rs):
        return "".join(f'<span class="acc">{esc(t)}</span>' if a else esc(t) for t, a in rs)

    if el["bullets"]:
        inner = "<ul>" + "".join(f"<li>{runs(p)}</li>" for p in el["paras"]) + "</ul>"
    else:
        inner = "".join(f"<p>{runs(p)}</p>" for p in el["paras"])
    if el.get("link"):
        inner = f'<a href="{esc(el["link"])}" target="_blank" rel="noopener">{inner}</a>'
    extra = ' data-count="1"' if el.get("count") else ""
    return f'<div class="el text s-{el["style"]}" style="{st}"{extra}{_common(el)}>{inner}</div>'


def _common(el: dict) -> str:
    a = ""
    if el.get("order"):
        a += f' data-order="{el["order"]}"'
    if el.get("key"):
        a += f' data-key="{esc(el["key"])}"'
    return a


def element_html(el: dict, assets: Assets, ctx_out: Path) -> str:
    k = el["kind"]
    x, y, w, h = el["box"]
    pos = f"left:{px(x)};top:{px(y)};width:{px(w)};height:{px(h)};"
    if k == "text":
        return _text_html(el)
    if k == "rect":
        st = pos + f"background:{rgba(el['fill'], el['alpha'])};border-radius:{px(el['radius'])};"
        if el.get("line") and el.get("line_alpha"):
            st += f"border:1px solid {rgba(el['line'], el['line_alpha'])};"
        cls = "el rect glass" if el.get("glass") else "el rect"
        return f'<div class="{cls}" style="{st}"{_common(el)}></div>'
    if k == "line":
        x1, y1, x2, y2 = el["pts"]
        wpx = max(1.0, el["width"] * 2 * 0.66)
        if abs(y2 - y1) < 1e-6:
            st = f"left:{px(min(x1, x2))};top:{y1 * PX - wpx / 2:.1f}px;width:{px(abs(x2 - x1))};height:{wpx:.1f}px;"
        else:
            st = f"left:{x1 * PX - wpx / 2:.1f}px;top:{px(min(y1, y2))};width:{wpx:.1f}px;height:{px(abs(y2 - y1))};"
        return f'<div class="el line" style="{st}background:{rgba(el["color"], el["alpha"])}"{_common(el)}></div>'
    if k == "ellipse":
        return f'<div class="el dot" style="{pos}background:{el["fill"]};border-radius:50%"{_common(el)}></div>'
    if k == "image":
        if not el.get("src") or not Path(el["src"]).exists():
            return f'<div class="el missing" style="{pos}">MISSING IMAGE</div>'
        rel = assets.add(el["src"])
        bleed = " bleed" if el.get("bleed") else ""
        return (f'<div class="el img{bleed}" style="{pos}border-radius:{px(el.get("radius", 0))}"{_common(el)}>'
                f'<img src="{rel}" alt="{esc(el.get("alt", ""))}" style="object-fit:{el["fit"]}" decoding="async"></div>')
    if k == "video":
        rel = assets.add(el["src"])
        poster = f' poster="{assets.add(el["poster"])}"' if el.get("poster") else ""
        bleed = " bleed" if el.get("bleed") else ""
        flags = (" muted data-autoplay=\"1\"" if el.get("autoplay", True) else " controls") + (" muted" if el.get("muted", True) and not el.get("autoplay", True) else "") + (" loop" if el.get("loop", True) else "")
        return (f'<div class="el vid{bleed}" style="{pos}"{_common(el)}><video src="{rel}"{poster}{flags} playsinline preload="auto" '
                f'style="object-fit:{el["fit"]}" aria-label="{esc(el.get("alt", ""))}"></video></div>')
    if k == "scrim":
        a = el["strength"]
        if el.get("dir") == "left":
            return (f'<div class="el scrim" style="{pos}background:linear-gradient(90deg,rgba(0,0,0,{a:.2f}) 0%,rgba(0,0,0,{a * 0.75:.2f}) 35%,rgba(0,0,0,0) 72%),'
                    f'linear-gradient(180deg,rgba(0,0,0,0) 65%,rgba(0,0,0,{a * 0.5:.2f}) 100%)"></div>')
        return f'<div class="el scrim" style="{pos}background:linear-gradient(180deg,rgba(0,0,0,0) 30%,rgba(0,0,0,{a * 0.6:.2f}) 65%,rgba(0,0,0,{a:.2f}) 100%)"></div>'
    if k == "chart":
        return f'<div class="el chartbox" style="{pos}"{_common(el)}>{chart_svg(el)}</div>'
    if k == "viewer":
        v = dict(el["viewer"])
        if v.get("glb"):
            gp = Path(v["glb"])
            v["glb"] = base64.b64encode(gp.read_bytes()).decode() if gp.exists() else None
            v["kind"] = "glb"
        poster = f'<img class="poster" src="{assets.add(el["poster"])}" alt="">' if el.get("poster") and Path(el["poster"]).exists() else ""
        return f'<div class="el viewer" style="{pos}" data-viewer="{esc(json.dumps(v))}"{_common(el)}>{poster}</div>'
    return ""


def build(deck: dict, ds: dict, slides_els: list[list[dict]], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    assets = Assets(out_dir)
    used_fonts: set[tuple[str, str]] = set()
    for role in ("display", "body", "mono"):
        f = ds["fonts"][role]
        used_fonts.add((f["family"], "regular"))
    slides_html = []
    has_viewer = False
    motion = ds["motion"]
    for i, (sl, els) in enumerate(zip(deck["slides"], slides_els), start=1):
        parts = []
        for el in els:
            if el["kind"] == "bg":
                img = f"background-image:url('{assets.add(el['image'])}');" if el.get("image") else ""
                parts.append(f'<div class="bg bg-{el["bgkind"]}" style="background-color:{el["color"]};{img}"><div class="bg-live"></div></div>')
                if sl.get("fx") == "particles":
                    parts.append('<canvas class="fx-particles"></canvas>')
                continue
            if el["kind"] == "text":
                f = el["font"]
                used_fonts.add((f["family"], "italic" if el["italic"] and f["family"] == "Instrument Serif" else f["weight"]))
            if el["kind"] == "viewer":
                has_viewer = True
            parts.append(element_html(el, assets, out_dir))
        notes = f'<aside class="notes">{esc(sl.get("notes", ""))}</aside>'
        tr = sl.get("transition") or motion["transition"]
        mo = sl.get("motion") or motion["entrance"]
        title = esc((sl.get("title") or sl.get("text") or sl.get("value") or sl["layout"]).replace("[[", "").replace("]]", ""))
        slides_html.append(f'<section class="slide l-{sl["layout"]}" data-transition="{tr}" data-motion="{mo}" data-title="{title}" aria-roledescription="slide" aria-label="{i}">'
                           + "".join(parts) + notes + "</section>")

    # runtime + fonts
    rt = out_dir / "runtime"
    rt.mkdir(exist_ok=True)
    for f in ("deck.css", "deck.js"):
        shutil.copy2(RUNTIME / f, rt / f)
    fd = out_dir / "fonts"
    fd.mkdir(exist_ok=True)
    for fam, wt in used_fonts:
        face = fonts.resolve(fam, wt, "brand")
        shutil.copy2(face.file, fd / face.file.name)
    viewer_tag = ""
    if has_viewer:
        shutil.copy2(VENDOR / "studio-viewer.js", rt / "studio-viewer.js")
        viewer_tag = '<script src="runtime/studio-viewer.js"></script>'
    c = ds["colors"]
    css_vars = ";".join(f"--{k.replace('_', '-')}:{v}" for k, v in c.items() if isinstance(v, str))
    m = deck["meta"]
    doc = f"""<!doctype html>
<html lang="{m.get('lang', 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(m.get('title', 'Presentation'))}</title>
<meta name="description" content="{esc(m.get('subtitle', ''))}">
<style>
{fonts.css_font_faces(used_fonts)}
:root{{{css_vars};--ease:{motion['ease']};--dur:{motion['duration_ms']}ms;--stagger:{motion['stagger_ms']}ms;--body-font:'{ds['fonts']['body']['family']}'}}
</style>
<link rel="stylesheet" href="runtime/deck.css">
</head>
<body class="mode-{ds['mode']}">
<main class="viewport"><div class="deck" id="deck">
{chr(10).join(slides_html)}
</div></main>
<div class="hud" aria-hidden="true"><div class="progress"><i></i></div><span class="count"></span></div>
<div class="presenter" hidden><div class="p-head"><b class="p-timer">00:00</b><span class="p-pos"></span><span class="p-next"></span></div><div class="p-notes"></div><small>S: close · ←/→: navigate · F: fullscreen</small></div>
{viewer_tag}
<script src="runtime/deck.js"></script>
</body>
</html>"""
    p = out_dir / "index.html"
    p.write_text(doc, encoding="utf-8")
    return p
