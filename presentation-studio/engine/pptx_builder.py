"""Element lists -> native, editable .pptx (python-pptx + a little OOXML).
Everything stays editable: real text boxes, native charts, theme colours/fonts, speaker notes."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from lxml import etree
from PIL import Image
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

from . import pptx_motion
from .tokens import hex_to_rgb, luminance

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
ALIGN = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}
ANCHOR = {"top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE, "bottom": MSO_ANCHOR.BOTTOM}


def rgb(h: str) -> RGBColor:
    return RGBColor(*hex_to_rgb(h))


def _alpha(fill_or_line_xml_parent, alpha: float):
    """Add <a:alpha> to the srgbClr inside a solidFill."""
    for clr in fill_or_line_xml_parent.iter(f"{{{A}}}srgbClr"):
        for old in clr.findall(f"{{{A}}}alpha"):
            clr.remove(old)
        a = etree.SubElement(clr, f"{{{A}}}alpha")
        a.set("val", str(int(max(0, min(1, alpha)) * 100000)))


def _box(el):
    x, y, w, h = el["box"]
    return Inches(x), Inches(y), Inches(max(w, 0.01)), Inches(max(h, 0.01))


# ------------------------------------------------------------------ theme
def patch_theme(prs, ds: dict, mode: str, name: str):
    c = ds["colors"]
    dark_first = sorted([c["bg"], c["text"]], key=luminance)
    scheme = {
        "dk1": dark_first[0], "lt1": dark_first[1],
        "dk2": c["surface"] if luminance(c["bg"]) < 0.2 else c["text"], "lt2": c["bg_alt"],
        "accent1": c["accent"], "accent2": c.get("accent2", c["accent"]),
        "accent3": c["chart"][2 % len(c["chart"])], "accent4": c["chart"][3 % len(c["chart"])],
        "accent5": c["chart"][4 % len(c["chart"])], "accent6": c["muted"],
        "hlink": c["accent"], "folHlink": c["muted"],
    }
    from .fonts import resolve
    head = resolve(ds["fonts"]["display"]["family"], ds["fonts"]["display"].get("weight", "regular"), mode).pptx_name
    body = resolve(ds["fonts"]["body"]["family"], "regular", mode).pptx_name
    part = prs.slide_master.part.part_related_by(RT.THEME)
    root = etree.fromstring(part.blob)
    root.set("name", name)
    cs = root.find(f".//{{{A}}}clrScheme")
    cs.set("name", name)
    for k, v in scheme.items():
        node = cs.find(f"{{{A}}}{k}")
        for ch in list(node):
            node.remove(ch)
        etree.SubElement(node, f"{{{A}}}srgbClr").set("val", v.lstrip("#").upper())
    fs = root.find(f".//{{{A}}}fontScheme")
    fs.set("name", name)
    fs.find(f"{{{A}}}majorFont/{{{A}}}latin").set("typeface", head)
    fs.find(f"{{{A}}}minorFont/{{{A}}}latin").set("typeface", body)
    part._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    bg = prs.slide_master.background.fill
    bg.solid()
    bg.fore_color.rgb = rgb(c["bg"])


# ------------------------------------------------------------------ elements
def add_text(slide, el):
    tb = slide.shapes.add_textbox(*_box(el))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = ANCHOR[el["anchor"]]
    size = el["size"]
    for i, runs in enumerate(el["paras"]):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = ALIGN[el["align"]]
        p.line_spacing = el["lh"] * (0.94 if el["lh"] < 1.1 else 1.0)  # PowerPoint's 'multiple' is a little loose for display type
        if el["bullets"]:
            p.space_after = Pt(size * 0.45)
            pPr = p._p.get_or_add_pPr()
            pPr.set("marL", str(Inches(0.3)))
            pPr.set("indent", str(-Inches(0.3)))
            bc = etree.SubElement(pPr, qn("a:buClr"))
            etree.SubElement(bc, qn("a:srgbClr")).set("val", el["accent"].lstrip("#"))
            etree.SubElement(pPr, qn("a:buFont")).set("typeface", "Arial")
            etree.SubElement(pPr, qn("a:buChar")).set("char", "•")
        for txt, acc in runs:
            r = p.add_run()
            r.text = txt
            f = r.font
            f.name = el["font"]["pptx"]
            f.size = Pt(size)
            f.bold = el["font"]["bold"]
            f.italic = el["italic"]
            f.color.rgb = rgb(el["accent"] if acc else el["color"])
            rPr = r._r.get_or_add_rPr()
            if el["tracking"]:
                rPr.set("spc", str(int(el["tracking"] * size * 100)))
            if el["upper"]:
                rPr.set("cap", "all")
            if el.get("strike"):
                rPr.set("strike", "sngStrike")
            if el.get("link"):
                r.hyperlink.address = el["link"]
    return tb


def add_rect(slide, el):
    shp_type = MSO_SHAPE.ROUNDED_RECTANGLE if el["radius"] > 0 else MSO_SHAPE.RECTANGLE
    s = slide.shapes.add_shape(shp_type, *_box(el))
    if el["radius"] > 0:
        s.adjustments[0] = min(0.5, el["radius"] / max(0.01, min(el["box"][2], el["box"][3])))
    s.fill.solid()
    s.fill.fore_color.rgb = rgb(el["fill"])
    if el["alpha"] < 1:
        _alpha(s._element.spPr.find(qn("a:solidFill")), el["alpha"])
    if el.get("line") and el.get("line_alpha", 0) > 0:
        s.line.color.rgb = rgb(el["line"])
        s.line.width = Pt(0.75)
        _alpha(s._element.spPr.find(qn("a:ln")), el["line_alpha"])
    else:
        s.line.fill.background()
    s.shadow.inherit = False
    return s


def add_line(slide, el):
    x1, y1, x2, y2 = el["pts"]
    c = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y1), Inches(x2), Inches(y2))
    c.line.color.rgb = rgb(el["color"])
    c.line.width = Pt(el["width"])
    return c


def add_ellipse(slide, el):
    s = slide.shapes.add_shape(MSO_SHAPE.OVAL, *_box(el))
    s.fill.solid()
    s.fill.fore_color.rgb = rgb(el["fill"])
    s.line.fill.background()
    s.shadow.inherit = False
    return s


def add_image(slide, el, slide_w=13.333, slide_h=7.5):
    src = el.get("src")
    if not src or not Path(src).exists():
        ph = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, *_box(el))
        ph.fill.solid()
        ph.fill.fore_color.rgb = RGBColor(0x55, 0x55, 0x55)
        ph.text_frame.text = f"MISSING IMAGE: {src}"
        return ph
    x, y, w, h = el["box"]
    with Image.open(src) as im:
        iw, ih = im.size
    if el["fit"] == "contain":
        s = min(w / iw, h / ih)
        nw, nh = iw * s, ih * s
        pic = slide.shapes.add_picture(src, Inches(x + (w - nw) / 2), Inches(y + (h - nh) / 2), Inches(nw), Inches(nh))
    else:
        pic = slide.shapes.add_picture(src, *_box(el))
        ia, ba = iw / ih, w / h
        if ia > ba:  # too wide: crop sides
            c = (1 - ba / ia) / 2
            pic.crop_left = pic.crop_right = c
        elif ia < ba:
            c = (1 - ia / ba) / 2
            pic.crop_top = pic.crop_bottom = c
    if el.get("radius"):
        geom = pic._element.spPr.find(qn("a:prstGeom"))
        if geom is not None:
            geom.set("prst", "roundRect")
    if el.get("alt"):
        pic._element.nvPicPr.cNvPr.set("descr", el["alt"])
    return pic


def scrim_png(out_dir: Path, strength: float, direction: str = "bottom") -> Path:
    p = out_dir / f"scrim_{direction}_{int(strength * 100)}.png"
    if not p.exists():
        h, w = 540, 960
        rgba = np.zeros((h, w, 4), np.uint8)
        if direction == "left":  # dark on the left, clear on the right, plus a soft floor
            x = np.linspace(0, 1, w)[None, :]
            a = np.clip(1 - (x - 0.05) / 0.62, 0, 1) ** 1.3 * strength
            y = np.linspace(0, 1, h)[:, None]
            a = np.clip(a + np.clip((y - 0.7) / 0.3, 0, 1) ** 2 * 0.5 * strength, 0, 1)
            rgba[..., 3] = (a * 255).astype(np.uint8)
        else:
            y = np.linspace(0, 1, h)[:, None]
            a = np.clip((y - 0.30) / 0.70, 0, 1) ** 1.4 * strength
            rgba[..., 3] = (np.repeat(a, w, 1) * 255).astype(np.uint8)
        out_dir.mkdir(parents=True, exist_ok=True)
        Image.fromarray(rgba, "RGBA").save(p)
    return p


CHART_TYPES = {"column": XL_CHART_TYPE.COLUMN_CLUSTERED, "bar": XL_CHART_TYPE.BAR_CLUSTERED,
               "line": XL_CHART_TYPE.LINE, "donut": XL_CHART_TYPE.DOUGHNUT}


def add_chart(slide, el):
    spec = el["chart"]
    cd = CategoryChartData()
    cd.categories = spec["categories"]
    for s in spec["series"]:
        cd.add_series(s["name"], s["values"])
    gf = slide.shapes.add_chart(CHART_TYPES[spec["type"]], *_box(el), cd)
    ch = gf.chart
    cols = spec["colors"]
    ch.font.name = el["font"]
    ch.font.size = Pt(12)
    ch.font.color.rgb = rgb(el["muted"])
    multi = len(spec["series"]) > 1
    ch.has_title = False
    ch.has_legend = multi or spec["type"] == "donut"
    if ch.has_legend:
        ch.legend.position = XL_LEGEND_POSITION.BOTTOM
        ch.legend.include_in_layout = False
        ch.legend.font.size = Pt(12)
        ch.legend.font.color.rgb = rgb(el["text"])
    plot = ch.plots[0]
    fmt = spec.get("format", "General")
    if spec["type"] != "donut":
        va = ch.value_axis
        va.has_major_gridlines = True
        va.major_gridlines.format.line.color.rgb = rgb(el["line"])
        va.major_gridlines.format.line.width = Pt(0.5)
        va.format.line.fill.background()
        va.tick_labels.font.size = Pt(11)
        va.tick_labels.number_format = '#,##0' + (f'"{spec["unit"]}"' if spec.get('unit') else '')
        va.major_unit = spec.get('major_unit', (spec.get('max') or 100) / 4)
        va.tick_labels.number_format_is_linked = False
        if "max" in spec:
            va.maximum_scale = spec["max"]
        va.minimum_scale = spec.get("min", 0)
        ca = ch.category_axis
        ca.format.line.color.rgb = rgb(el["line"])
        ca.tick_labels.font.size = Pt(12)
        ca.tick_labels.font.color.rgb = rgb(el["text"])
        ca.has_major_gridlines = False
        if spec["type"] == "bar":
            ca.reverse_order = True  # top-to-bottom like the HTML chart
        n = len(spec["categories"])
        if n > 8:
            cax = ca._element
            skip = cax.makeelement(qn('c:tickLblSkip'), {'val': str(-(-n // 6))})
            anchor = next((c for c in cax if c.tag.split('}')[1] in ('tickMarkSkip', 'noMultiLvlLbl', 'extLst')), None)
            anchor.addprevious(skip) if anchor is not None else cax.append(skip)
            ca.tick_labels.font.size = Pt(11)
    if spec["type"] in ("column", "bar"):
        plot.gap_width = spec.get("gap", 60)
        plot.overlap = -10 if multi else 0
        plot.has_data_labels = spec.get("labels", True)
        if plot.has_data_labels:
            dl = plot.data_labels
            dl.number_format = fmt
            dl.number_format_is_linked = False
            dl.position = XL_LABEL_POSITION.OUTSIDE_END
            dl.font.size = Pt(12)
            dl.font.color.rgb = rgb(el["text"])
        for si, s in enumerate(plot.series):
            s.format.fill.solid()
            s.format.fill.fore_color.rgb = rgb(cols[si % len(cols)] if multi else cols[2])
            if not multi:
                hl = spec.get("highlight")
                hl = [hl] if isinstance(hl, int) else (hl or [])
                for pi in range(len(spec["categories"])):
                    pt = s.points[pi]
                    pt.format.fill.solid()
                    pt.format.fill.fore_color.rgb = rgb(cols[0] if pi in hl else cols[2])
    elif spec["type"] == "line":
        for si, s in enumerate(plot.series):
            s.smooth = False
            s.format.line.color.rgb = rgb(cols[si % len(cols)])
            s.format.line.width = Pt(3 if si == spec.get("highlight", 0) else 2)
            s.marker.style = None
            from pptx.enum.chart import XL_MARKER_STYLE
            s.marker.style = XL_MARKER_STYLE.NONE
    elif spec["type"] == "donut":
        s = plot.series[0]
        for pi in range(len(spec["categories"])):
            pt = s.points[pi]
            pt.format.fill.solid()
            pt.format.fill.fore_color.rgb = rgb(cols[pi % len(cols)])
        plot.has_data_labels = True
        plot.data_labels.number_format = fmt
        plot.data_labels.number_format_is_linked = False
        plot.data_labels.font.color.rgb = rgb(el["text"])
    return gf


def add_video(slide, el):
    x, y, w, h = el["box"]
    poster = el.get("poster")
    if el["fit"] == "contain" and poster:
        with Image.open(poster) as im:
            iw, ih = im.size
        s = min(w / iw, h / ih)
        nw, nh = iw * s, ih * s
        x, y, w, h = x + (w - nw) / 2, y + (h - nh) / 2, nw, nh
    mv = slide.shapes.add_movie(el["src"], Inches(x), Inches(y), Inches(w), Inches(h),
                                poster_frame_image=poster, mime_type="video/mp4")
    mv._is_video = True
    return mv


def add_viewer_poster(slide, el, issues, idx):
    p = el.get("poster")
    if p and Path(p).exists():
        return add_image(slide, {**el, "src": p, "fit": "contain", "alt": "3D render"})
    issues.append({"level": "WARN", "slide": idx, "check": "3d-poster",
                   "msg": "3D viewer slide has no poster image for PPTX/PDF (run build with posters, or set 'poster')"})
    return None


# ------------------------------------------------------------------ deck
def build(deck: dict, ds: dict, slides_els: list[list[dict]], out: Path, mode: str, build_dir: Path, issues: list) -> Path:
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    patch_theme(prs, ds, mode, ds["name"])
    meta = deck["meta"]
    cp = prs.core_properties
    cp.title = meta.get("title", "")
    cp.author = meta.get("author", "")
    cp.subject = meta.get("subtitle", "")
    cp.keywords = "Presentation Studio"
    blank = prs.slide_layouts[6]
    motion = ds["motion"]
    specs = deck["slides"]

    # morph pairing: keys shared with the previous slide get '!!key' names on both slides
    keysets = [{e["key"] for e in els if e.get("key")} for els in slides_els]
    morph_names: list[set] = [set() for _ in slides_els]
    for i, sl in enumerate(specs):
        if i and (sl.get("transition") or motion["transition"]) == "morph":
            shared = keysets[i] & keysets[i - 1]
            morph_names[i] |= shared
            morph_names[i - 1] |= shared

    for i, (sl, els) in enumerate(zip(specs, slides_els)):
        slide = prs.slides.add_slide(blank)
        effects = []
        for el in els:
            k = el["kind"]
            if k == "bg":
                if el.get("image"):
                    pic = slide.shapes.add_picture(el["image"], 0, 0, prs.slide_width, prs.slide_height)
                    pic.name = "Background"
                else:
                    slide.background.fill.solid()
                    slide.background.fill.fore_color.rgb = rgb(el["color"])
                continue
            if k == "scrim":
                pic = slide.shapes.add_picture(str(scrim_png(build_dir / "assets", el["strength"], el.get("dir", "bottom"))), 0, 0, prs.slide_width, prs.slide_height)
                pic.name = "Scrim"
                continue
            shp = {"text": add_text, "rect": add_rect, "line": add_line, "ellipse": add_ellipse,
                   "image": add_image, "chart": add_chart, "video": add_video}.get(k)
            shp = shp(slide, el) if shp else (add_viewer_poster(slide, el, issues, i + 1) if k == "viewer" else None)
            if shp is None:
                continue
            key = el.get("key")
            if key and key in morph_names[i]:
                shp.name = f"!!{key}"
            elif key:
                shp.name = key
            morphing = key in morph_names[i] and (sl.get("transition") or motion["transition"]) == "morph"
            if k == "video":
                kind = "media" + (":auto" if el.get("autoplay", True) else ":click") + (":mute" if el.get("muted", True) else "") + (":loop" if el.get("loop", True) else "")
                effects.insert(0, (shp.shape_id, el.get("dur_ms", 10000), kind, "pic"))
                continue
            if el.get("order") and not morphing and sl.get("motion", motion["entrance"]) != "none":
                tag = etree.QName(shp._element).localname
                delay = (el["order"] - 1) * motion["stagger_ms"] * 1.6
                effects.append((shp.shape_id, int(delay), sl.get("motion", motion["entrance"]), tag))
        if sl.get("notes"):
            slide.notes_slide.notes_text_frame.text = sl["notes"]
        trans = sl.get("transition") or motion["transition"]
        if i == 0 and trans == "morph":
            trans = "fade"
        pptx_motion.apply(slide, trans, motion.get("pptx_transition_ms", 800), effects, motion.get("pptx_entrance_ms", 500))
    out.parent.mkdir(parents=True, exist_ok=True)
    prs.save(out)
    return out
