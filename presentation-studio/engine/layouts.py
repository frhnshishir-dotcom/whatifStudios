"""Layout engine: slide spec -> list of positioned elements (inches, 13.333 x 7.5 canvas).

The SAME element list feeds the PowerPoint builder, the HTML builder and the geometry QA,
so the .pptx and the cinematic web deck can never drift apart.

Inline markup in any text: [[words]] renders in the accent colour.
"""
from __future__ import annotations

import re
from pathlib import Path

from . import backgrounds, refs, textfit
from .tokens import color, style

W, H = 13.333, 7.5
LAYOUTS = (
    "title", "agenda", "section", "statement", "big-number", "split", "features", "timeline",
    "comparison", "chart", "stats", "quote", "product", "image-full", "video", "references", "closing",
)
NO_FOOTER = {"title", "section", "statement", "closing", "image-full", "quote", "video"}


class Ctx:
    def __init__(self, deck: dict, ds: dict, mode: str, project_dir: Path, build_dir: Path):
        self.deck, self.ds, self.mode = deck, ds, mode
        self.project_dir, self.build_dir = project_dir, build_dir
        self.M = ds["grid"]["margin"]
        self.CW = W - 2 * self.M
        self.sources = {s["id"]: s for s in deck.get("sources", [])}
        self.issues: list[dict] = []

    def asset(self, p: str | None) -> Path | None:
        if not p:
            return None
        q = Path(p)
        return q if q.is_absolute() else (self.project_dir / q)


# ---------------------------------------------------------------- text helpers
_MARK = re.compile(r"\[\[(.+?)\]\]")


def runs_of(s: str) -> list[tuple[str, bool]]:
    out, pos = [], 0
    for m in _MARK.finditer(s):
        if m.start() > pos:
            out.append((s[pos:m.start()], False))
        out.append((m.group(1), True))
        pos = m.end()
    if pos < len(s):
        out.append((s[pos:], False))
    return out or [("", False)]


def plain(s: str) -> str:
    return _MARK.sub(lambda m: m.group(1), s)


def smart_quotes(s: str) -> str:
    s = re.sub(r'(^|[\s(\[])"', r"\1“", s)
    s = s.replace('"', "”")
    s = re.sub(r"(\w)'(\w)", r"\1’\2", s)
    return s.replace("'", "’").replace(" -- ", " — ")


def text(ctx: Ctx, sty: str, content, box, *, align="left", anchor="top", key=None, order=None,
         color_=None, bullets=False, size=None, min_size=None, max_lines=None, decor=False, link=None):
    st = style(ctx.ds, sty, ctx.mode, size=size, min=min_size, color=None)
    if color_:
        st.color = color(ctx.ds, color_)
    paras = content if isinstance(content, list) else [content]
    paras = [smart_quotes(str(p)) for p in paras if p is not None and str(p) != ""]
    meas = [plain(p).upper() if st.upper else plain(p) for p in paras]
    indent = 0.3 if bullets else 0.0
    f = textfit.fit(meas, st.face, st.size, box[2], box[3], st.line_height, st.tracking,
                    st.min_size, para_space=0.45 if bullets else 0.0, indent_in=indent, max_lines=max_lines)
    el = {
        "kind": "text", "box": list(box), "style": sty, "paras": [runs_of(p) for p in paras],
        "upper": st.upper, "italic": st.italic, "size": f.size, "lh": st.line_height, "tracking": st.tracking,
        "font": {"family": st.face.family, "weight": st.face.weight, "pptx": st.face.pptx_name,
                 "bold": st.face.pptx_bold, "file": str(st.face.file)},
        "color": st.color, "accent": color(ctx.ds, "accent"), "align": align, "anchor": anchor,
        "bullets": bullets, "key": key, "order": order, "decor": decor, "fit": f.fits,
        "text_h": f.height_in, "lines": f.lines, "link": link,
    }
    if not f.fits:
        ctx.issues.append({"level": "FAIL", "check": "text-overflow",
                           "msg": f"'{plain(paras[0])[:50]}…' does not fit {sty} box even at {st.min_size}pt — cut words or split the slide"})
    return el


def rect(box, fill, alpha=1.0, radius=0.0, line=None, line_alpha=0.0, decor=True, key=None, order=None, glass=False):
    return {"kind": "rect", "box": list(box), "fill": fill, "alpha": alpha, "radius": radius, "line": line,
            "line_alpha": line_alpha, "decor": decor, "key": key, "order": order, "glass": glass}


def line(x1, y1, x2, y2, col, width_pt=1.0, alpha=1.0, order=None, key=None):
    return {"kind": "line", "box": [min(x1, x2), min(y1, y2), abs(x2 - x1), abs(y2 - y1)], "pts": [x1, y1, x2, y2],
            "color": col, "width": width_pt, "alpha": alpha, "decor": True, "order": order, "key": key}


def ellipse(box, fill, order=None, key=None):
    return {"kind": "ellipse", "box": list(box), "fill": fill, "decor": True, "order": order, "key": key}


def image(ctx, src, box, *, fit="cover", key=None, order=None, bleed=False, radius=0.0, alt=""):
    p = ctx.asset(src)
    if p is None or not p.exists():
        ctx.issues.append({"level": "FAIL", "check": "missing-image", "msg": f"image not found: {src}"})
    return {"kind": "image", "box": list(box), "src": str(p) if p else None, "fit": fit, "key": key,
            "order": order, "bleed": bleed, "radius": radius, "alt": alt, "decor": False}


def video(ctx, src, box, *, fit="cover", key=None, order=None, bleed=False, poster=None, alt=""):
    """MP4 element: plays in the web deck, embedded (autoplay, muted, loop) in the .pptx, poster frame in PDF."""
    import shutil
    import subprocess
    p = ctx.asset(src)
    if p is None or not p.exists():
        ctx.issues.append({"level": "FAIL", "check": "missing-video", "msg": f"video not found: {src}"})
        return {"kind": "image", "box": list(box), "src": None, "fit": fit, "key": key, "order": order, "bleed": bleed, "decor": False, "alt": alt}
    pp = ctx.asset(poster) if poster else None
    if pp is None or not pp.exists():
        pp = ctx.build_dir / "assets" / f"{p.stem}_poster.jpg"
        ff = shutil.which("ffmpeg")
        if not pp.exists() and ff:
            pp.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([ff, "-y", "-v", "error", "-ss", "1.5", "-i", str(p), "-frames:v", "1", "-q:v", "2", str(pp)])
        if not pp.exists():
            ctx.issues.append({"level": "WARN", "check": "video-poster", "msg": f"no poster frame for {p.name} (install ffmpeg or set 'poster')"})
            pp = None
    dur_ms = 10000
    fp = shutil.which("ffprobe")
    if fp:
        r = subprocess.run([fp, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(p)], capture_output=True, text=True)
        try:
            dur_ms = int(float(r.stdout.strip()) * 1000)
        except ValueError:
            pass
    return {"kind": "video", "box": list(box), "src": str(p), "poster": str(pp) if pp else None, "fit": fit, "key": key, "dur_ms": dur_ms,
            "order": order, "bleed": bleed, "decor": False, "alt": alt}


def card(ctx, box, order=None, key=None):
    s = ctx.ds["surfaces"]
    c = ctx.ds["colors"]
    return rect(box, c["surface"], s["card_alpha"], s["radius"], line=c["text"], line_alpha=s["card_line_alpha"],
                order=order, key=key, glass=s.get("glass", False))


# ---------------------------------------------------------------- shared furniture
def header(ctx, sl, els, o=1):
    M = ctx.M
    if sl.get("eyebrow"):
        els.append(text(ctx, "eyebrow", sl["eyebrow"], (M, 0.62, ctx.CW, 0.3), key="eyebrow", order=o))
    els.append(text(ctx, "title", sl["title"], (M, 0.95, ctx.CW * 0.86, 1.3), key="title", order=o + 1, max_lines=2))
    return o + 2


def cite_text(ctx, sl) -> str | None:
    ids = sl.get("cite") or []
    if not ids:
        return None
    parts = []
    for i in ids:
        s = ctx.sources.get(i)
        if s is None:
            ctx.issues.append({"level": "FAIL", "check": "citation", "msg": f"cites unknown source id '{i}'"})
            continue
        parts.append(refs.in_text(s))
    return "Source: " + "; ".join(parts) if parts else None


def footer(ctx, sl, idx, els):
    if sl["layout"] in NO_FOOTER:
        return
    M = ctx.M
    left = cite_text(ctx, sl) or ctx.deck["meta"].get("short_title") or ctx.deck["meta"].get("title", "")
    els.append(text(ctx, "caption", left, (M, 6.98, ctx.CW - 1.0, 0.3), decor=True, key=None, max_lines=1))
    els.append(text(ctx, "mono", f"{idx:02d}", (W - M - 0.8, 6.98, 0.8, 0.3), align="right", decor=True))


def background(ctx, sl, layout):
    ds = ctx.ds
    kind = sl.get("bg") or ds["backgrounds"].get(layout, ds["backgrounds"].get("default", "solid"))
    el = {"kind": "bg", "box": [0, 0, W, H], "color": ds["colors"]["bg"], "image": None, "decor": True, "bgkind": kind}
    if kind in backgrounds.KINDS:
        el["image"] = str(backgrounds.ensure(kind, ds["colors"], ctx.build_dir / "assets", seed=sl.get("seed", 3)))
    elif kind == "alt":
        el["color"] = ds["colors"]["bg_alt"]
    elif kind not in ("solid", None):
        p = ctx.asset(kind)
        el["image"] = str(p) if p and p.exists() else None
        if el["image"] is None:
            ctx.issues.append({"level": "FAIL", "check": "missing-image", "msg": f"background not found: {kind}"})
    return el


# ---------------------------------------------------------------- layouts
def L_title(ctx, sl, els):
    M = ctx.M
    y = 2.35
    if sl.get("eyebrow"):
        els.append(text(ctx, "eyebrow", sl["eyebrow"], (M, y, 9, 0.3), key="eyebrow", order=1))
    t = text(ctx, "hero", sl["title"], (M, y + 0.4, ctx.CW, 2.5), key="title", order=2, max_lines=2)
    els.append(t)
    if sl.get("subtitle"):
        els.append(text(ctx, "subtitle", sl["subtitle"], (M, y + 0.4 + t["text_h"] + 0.3, 8.6, 1.1), key="subtitle", order=3))
    meta = sl.get("meta") or " · ".join(x for x in [ctx.deck["meta"].get("author"), ctx.deck["meta"].get("course"), ctx.deck["meta"].get("date")] if x)
    if meta:
        els.append(text(ctx, "mono", meta, (M, 6.55, 10, 0.3), order=4, key="meta"))


def L_agenda(ctx, sl, els):
    M = ctx.M
    o = header(ctx, sl, els)
    items = sl["items"]
    row = min(0.74, 4.2 / max(1, len(items)))
    for i, it in enumerate(items):
        y = 2.5 + i * row
        els.append(line(M, y, W - M, y, ctx.ds["colors"]["line"], 0.75, order=o + i))
        els.append(text(ctx, "mono", f"{i + 1:02d}", (M, y + 0.2, 0.8, 0.35), color_="accent", order=o + i))
        els.append(text(ctx, "label", it, (M + 1.0, y + 0.14, ctx.CW - 1.0, row - 0.16), size=24, min_size=16, order=o + i, max_lines=1))


def L_section(ctx, sl, els):
    M = ctx.M
    els.append(text(ctx, "index", sl.get("index", ""), (M, 2.0, 4.0, 2.6), key="index", order=1, max_lines=1))
    els.append(text(ctx, "title", sl["title"], (M + 4.4, 2.55, 7.4, 1.8), size=54, min_size=36, key="title", order=2, max_lines=2))
    if sl.get("subtitle"):
        els.append(text(ctx, "subtitle", sl["subtitle"], (M + 4.4, 4.45, 6.8, 1.2), key="subtitle", order=3))


def L_statement(ctx, sl, els):
    if sl.get("eyebrow"):
        els.append(text(ctx, "eyebrow", sl["eyebrow"], (1.4, 1.55, W - 2.8, 0.3), align="center", key="eyebrow", order=1))
    els.append(text(ctx, "hero", sl["text"], (1.4, 2.0, W - 2.8, 3.4), size=sl.get("size", 60), min_size=34,
                    align="center", anchor="middle", key="statement", order=2))


def L_big_number(ctx, sl, els):
    M = ctx.M
    if sl.get("eyebrow"):
        els.append(text(ctx, "eyebrow", sl["eyebrow"], (M, 1.25, 7, 0.3), key="eyebrow", order=1))
    v = text(ctx, "stat", sl["value"], (M - 0.06, 1.7, 7.6, 2.6), key="stat", order=2, max_lines=1, color_=sl.get("value_color"))
    v["count"] = sl.get("count", True)
    els.append(v)
    els.append(text(ctx, "label", sl["label"], (M, 4.45, 6.6, 1.3), size=26, min_size=18, key="label", order=3))
    if sl.get("context"):
        els.append(line(8.35, 1.8, 8.35, 5.6, ctx.ds["colors"]["line"], 0.75, order=4))
        els.append(text(ctx, "body", sl["context"], (8.75, 1.75, W - M - 8.75, 3.9), order=4, anchor="top"))


def L_split(ctx, sl, els):
    M = ctx.M
    side = sl.get("image_side", "right")
    iw = 6.2
    ix = W - iw if side == "right" else 0
    tx = M if side == "right" else iw + 0.6
    tw = W - iw - M - 0.6
    if sl.get("video"):
        els.append(video(ctx, sl["video"], (ix, 0, iw, H), bleed=True, key="image", order=1, poster=sl.get("poster"), alt=sl.get("alt", "")))
    else:
        els.append(image(ctx, sl.get("image"), (ix, 0, iw, H), bleed=True, key="image", order=1, alt=sl.get("alt", "")))
    y = 1.35
    if sl.get("eyebrow"):
        els.append(text(ctx, "eyebrow", sl["eyebrow"], (tx, y, tw, 0.3), key="eyebrow", order=2))
    t = text(ctx, "title", sl["title"], (tx, y + 0.35, tw, 1.95), key="title", order=3, max_lines=3)
    els.append(t)
    yb = y + 0.35 + t["text_h"] + 0.4
    body = sl.get("bullets") or sl.get("body")
    if body:
        els.append(text(ctx, "body", body, (tx, yb, tw, 6.6 - yb), bullets=bool(sl.get("bullets")), key="body", order=4))
    if sl.get("caption"):
        els.append(text(ctx, "caption", sl["caption"], (ix + 0.3 if side == "right" else 0.3, 7.05, iw - 0.6, 0.3),
                        color_="#FFFFFF", decor=True, order=5))


def L_features(ctx, sl, els):
    M, g = ctx.M, ctx.ds["grid"]["gutter"]
    o = header(ctx, sl, els)
    items = sl["items"]
    n = len(items)
    cw = (ctx.CW - g * (n - 1)) / n
    y, h = 2.55, 4.0
    pad = 0.35
    for i, it in enumerate(items):
        x = M + i * (cw + g)
        els.append(card(ctx, (x, y, cw, h), order=o + i, key=f"card{i}"))
        els.append(text(ctx, "mono", it.get("tag", f"{i + 1:02d}"), (x + pad, y + pad, cw - 2 * pad, 0.3), color_="accent", order=o + i))
        tt = text(ctx, "label", it["title"], (x + pad, y + 1.35, cw - 2 * pad, 1.0), size=22 if n <= 3 else 19, min_size=15, order=o + i, max_lines=2)
        els.append(tt)
        yb = y + 1.35 + tt["text_h"] + 0.18
        els.append(text(ctx, "body", it["body"], (x + pad, yb, cw - 2 * pad, y + h - pad - yb), size=16 if n <= 3 else 15,
                        min_size=13, color_="muted", order=o + i))


def L_timeline(ctx, sl, els):
    M = ctx.M
    o = header(ctx, sl, els)
    items = sl["items"]
    n = len(items)
    colw = ctx.CW / n
    ly = 3.75
    els.append(line(M, ly, W - M, ly, ctx.ds["colors"]["line"], 1.0, order=o))
    for i, it in enumerate(items):
        x = M + i * colw
        oo = o + 1 + i
        els.append(ellipse((x - 0.0, ly - 0.08, 0.16, 0.16), ctx.ds["colors"]["accent"], order=oo))
        els.append(text(ctx, "stat_sm", it["when"], (x, 2.6, colw - 0.25, 0.95), size=40 if n <= 4 else 32, min_size=22, anchor="bottom", order=oo, max_lines=1))
        tt = text(ctx, "label", it["title"], (x, ly + 0.35, colw - 0.3, 0.85), size=19, min_size=14, order=oo, max_lines=2)
        els.append(tt)
        yb = ly + 0.35 + tt["text_h"] + 0.12
        if it.get("body"):
            els.append(text(ctx, "body", it["body"], (x, yb, colw - 0.3, 6.7 - yb), size=15, min_size=12, color_="muted", order=oo))


def L_comparison(ctx, sl, els):
    M, g = ctx.M, ctx.ds["grid"]["gutter"]
    o = header(ctx, sl, els)
    cw = (ctx.CW - g) / 2
    y, h, pad = 2.55, 4.05, 0.42
    for i, side in enumerate(("left", "right")):
        c = sl[side]
        x = M + i * (cw + g)
        els.append(card(ctx, (x, y, cw, h), order=o + i, key=f"cmp{i}"))
        els.append(text(ctx, "eyebrow", c.get("tag", ""), (x + pad, y + pad, cw - 2 * pad, 0.3), order=o + i,
                        color_="accent" if i else "muted"))
        tt = text(ctx, "label", c["title"], (x + pad, y + pad + 0.42, cw - 2 * pad, 0.9), size=26, min_size=18, order=o + i, max_lines=2)
        els.append(tt)
        yb = y + pad + 0.42 + tt["text_h"] + 0.25
        els.append(text(ctx, "body", c["bullets"], (x + pad, yb, cw - 2 * pad, y + h - pad - yb), bullets=True, size=17, min_size=13, order=o + i))


def L_chart(ctx, sl, els):
    M = ctx.M
    o = header(ctx, sl, els)
    side = sl.get("takeaway") or sl.get("callout")
    cw = 8.0 if side else ctx.CW
    ch = dict(sl["chart"])
    ch.setdefault("colors", ctx.ds["colors"]["chart"])
    if "format" not in ch:
        d = ch.get("decimals", 0)
        ch["format"] = "#,##0" + ("." + "0" * d if d else "") + (f'"{ch["unit"]}"' if ch.get("unit") else "")
    els.append({"kind": "chart", "box": [M, 2.4, cw, 4.35], "chart": ch, "order": o, "key": "chart", "decor": False,
                "text": ctx.ds["colors"]["text"], "muted": ctx.ds["colors"]["muted"], "line": ctx.ds["colors"]["line"],
                "font": style(ctx.ds, "caption", ctx.mode).face.pptx_name,
                "font_file": str(style(ctx.ds, "caption", ctx.mode).face.file), "css_font": ctx.ds["fonts"]["body"]["family"]})
    if side:
        x = M + cw + 0.5
        w = W - M - x
        y = 2.6
        if sl.get("callout"):
            v = text(ctx, "stat_sm", sl["callout"]["value"], (x, y, w, 1.1), color_="accent", order=o + 1, max_lines=1)
            v["count"] = True
            els.append(v)
            els.append(text(ctx, "body", sl["callout"]["label"], (x, y + 1.15, w, 0.9), size=15, color_="muted", order=o + 1))
            y += 2.25
        if sl.get("takeaway"):
            els.append(text(ctx, "body", sl["takeaway"], (x, y, w, 6.7 - y), size=18, order=o + 2))


def L_stats(ctx, sl, els):
    M, g = ctx.M, ctx.ds["grid"]["gutter"]
    o = header(ctx, sl, els)
    items = sl["items"]
    n = len(items)
    cw = (ctx.CW - g * (n - 1)) / n
    for i, it in enumerate(items):
        x = M + i * (cw + g)
        els.append(line(x, 2.85, x + cw, 2.85, ctx.ds["colors"]["line"], 1.0, order=o + i))
        v = text(ctx, "stat_sm", it["value"], (x, 3.1, cw, 1.25), size=72 if n <= 3 else 60, min_size=36,
                 color_="accent" if i == sl.get("highlight", 0) else None, order=o + i, max_lines=1)
        v["count"] = True
        els.append(v)
        els.append(text(ctx, "body", it["label"], (x, 4.5, cw - 0.2, 2.1), size=17, min_size=13, color_="muted", order=o + i))


def L_quote(ctx, sl, els):
    els.append(text(ctx, "index", "“", (1.35, 0.85, 2, 1.8), size=200, color_="accent", order=1, decor=True))
    q = text(ctx, "quote", sl["quote"], (1.6, 2.2, 10.1, 3.1), anchor="middle", key="quote", order=2)
    els.append(q)
    if sl.get("by"):
        els.append(text(ctx, "label", sl["by"], (1.6, 5.55, 9, 0.4), order=3))
    if sl.get("role"):
        els.append(text(ctx, "caption", sl["role"], (1.6, 5.98, 9, 0.35), size=13, order=3))


def L_product(ctx, sl, els):
    M = ctx.M
    if sl.get("eyebrow"):
        els.append(text(ctx, "eyebrow", sl["eyebrow"], (1.5, 0.55, W - 3, 0.3), align="center", key="eyebrow", order=1))
    els.append(text(ctx, "title", sl["title"], (1.5, 0.88, W - 3, 0.85), align="center", key="title", order=2, max_lines=1))
    vb = (3.95, 1.8, 5.43, 5.1)
    if sl.get("viewer"):
        els.append({"kind": "viewer", "box": list(vb), "viewer": sl["viewer"], "poster": str(ctx.asset(sl["poster"])) if sl.get("poster") else None,
                    "order": 3, "key": "hero", "decor": False})
    elif sl.get("video"):
        els.append(video(ctx, sl["video"], vb, fit="contain", key="hero", order=3, poster=sl.get("poster")))
    elif sl.get("image"):
        els.append(image(ctx, sl["image"], vb, fit="contain", key="hero", order=3))
    cos = sl.get("callouts", [])[:4]
    for i, c in enumerate(cos):
        left = i % 2 == 0
        row = i // 2
        x = M if left else W - M - 3.05
        y = 2.55 + row * 2.05
        els.append(line(x if left else x - 0.0, y - 0.15, x + 3.05, y - 0.15, ctx.ds["colors"]["line"], 0.75, order=4 + i))
        els.append(text(ctx, "label", c["title"], (x, y, 3.05, 0.4), size=18, align="left" if left else "right", order=4 + i, max_lines=1))
        els.append(text(ctx, "body", c["body"], (x, y + 0.45, 3.05, 1.3), size=14, min_size=12, color_="muted",
                        align="left" if left else "right", order=4 + i))


def L_image_full(ctx, sl, els):
    M = ctx.M
    els.append(image(ctx, sl.get("image"), (0, 0, W, H), bleed=True, key="image", order=0, alt=sl.get("alt", "")))
    els.append({"kind": "scrim", "box": [0, 0, W, H], "strength": sl.get("scrim", 0.75), "decor": True})
    if sl.get("eyebrow"):
        els.append(text(ctx, "eyebrow", sl["eyebrow"], (M, 4.55, 9, 0.3), order=1))
    els.append(text(ctx, "hero", sl["title"], (M, 4.9, 10.5, 1.5), size=56, min_size=36, color_="#FFFFFF", anchor="bottom", key="title", order=2, max_lines=2))
    if sl.get("caption"):
        els.append(text(ctx, "caption", sl["caption"], (M, 6.62, 11, 0.5), color_="#D8D8D8", order=3))


def L_video(ctx, sl, els):
    """Full-bleed video (ad spot, product film, b-roll) with an optional title over a scrim."""
    M = ctx.M
    els.append(video(ctx, sl.get("video"), (0, 0, W, H), bleed=True, key="video", order=0, poster=sl.get("poster"), alt=sl.get("alt", "")))
    if sl.get("title"):
        els.append({"kind": "scrim", "box": [0, 0, W, H], "strength": sl.get("scrim", 0.7), "decor": True})
        if sl.get("eyebrow"):
            els.append(text(ctx, "eyebrow", sl["eyebrow"], (M, 5.0, 9, 0.3), order=1))
        els.append(text(ctx, "hero", sl["title"], (M, 5.35, 10.5, 1.3), size=48, min_size=32, color_="#FFFFFF", anchor="bottom", key="title", order=2, max_lines=2))


def L_references(ctx, sl, els):
    M = ctx.M
    sl.setdefault("title", "References")
    o = header(ctx, sl, els)
    entries = [refs.apa(s) for s in ctx.deck.get("sources", [])]
    if not entries:
        ctx.issues.append({"level": "WARN", "check": "references", "msg": "references slide but no sources in deck"})
        return
    cols = 2 if len(entries) > 4 else 1
    per = -(-len(entries) // cols)
    cw = (ctx.CW - 0.5 * (cols - 1)) / cols
    for c in range(cols):
        chunk = entries[c * per:(c + 1) * per]
        els.append(text(ctx, "caption", chunk, (M + c * (cw + 0.5), 2.45, cw, 4.3), size=14, min_size=11, order=o + c))


def L_closing(ctx, sl, els):
    if sl.get("eyebrow"):
        els.append(text(ctx, "eyebrow", sl["eyebrow"], (1.2, 2.0, W - 2.4, 0.3), align="center", key="eyebrow", order=1))
    t = text(ctx, "hero", sl["title"], (1.2, 2.4, W - 2.4, 2.2), align="center", anchor="middle", key="title", order=2, max_lines=2)
    els.append(t)
    if sl.get("subtitle"):
        els.append(text(ctx, "subtitle", sl["subtitle"], (2.2, 4.75, W - 4.4, 1.0), align="center", key="subtitle", order=3))
    if sl.get("contact"):
        els.append(text(ctx, "mono", sl["contact"], (2.2, 6.5, W - 4.4, 0.35), align="center", order=4))


FUNCS = {name: globals()["L_" + name.replace("-", "_")] for name in LAYOUTS}


def build_slide(ctx: Ctx, sl: dict, idx: int) -> list[dict]:
    layout = sl.get("layout")
    if layout not in FUNCS:
        raise ValueError(f"slide {idx}: unknown layout {layout!r}. Choose from: {', '.join(LAYOUTS)}")
    els = [background(ctx, sl, layout)]
    n0 = len(ctx.issues)
    FUNCS[layout](ctx, sl, els)
    footer(ctx, sl, idx, els)
    for it in ctx.issues[n0:]:
        it.setdefault("slide", idx)
    return els
